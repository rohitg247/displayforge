import hashlib
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import PlainTextResponse
from ..database import db_dependency
from ..auth import get_current_user, get_display_viewer
from ..config import settings
from ..models import (
    AmbientDisplayCreate,
    AmbientDisplayUpdate,
    AmbientDisplayOut,
    AmbientMediaOut,
    MediaReorderRequest,
    ActivePlaylistRequest,
    PublishPlaylistRequest,
)
from ..media_utils import (
    extract_last_frame,
    extract_first_frame,
    normalize_video,
    build_video_run,
    build_mse_loop,
    normalize_image,
    probe_image,
    image_aspect_warning,
)

router = APIRouter()

# On-panel debug logs (?debug=true) are POSTed here so they can be read back from a browser instead
# of photographing the TV. Kept OUT of the /uploads static mount (which is immutable-cached) so the
# served log is never stale; the GET endpoint sets no-cache explicitly.
# Storage model: ONE append-only file per display per day (`ambient-<id>-<YYYY-MM-DD>.log`) holding
# every event in detail (the viewer streams all events while ?debug is open), plus a small overwritten
# `…-latest.json` status snapshot. Files older than the retention window are pruned, so the count is
# bounded (≤ retention days per display) — no per-snapshot file explosion.
_DEBUG_LOG_DIR = Path(settings.DATABASE_PATH).parent / "debug-logs"
_DEBUG_LOG_MAX_BYTES = 1024 * 1024        # per-POST body cap (a full event batch can be large)
_DEBUG_LOG_RETENTION_DAYS = 7             # keep the last 7 days of day-files per display
_DEBUG_LOG_TAIL_BYTES = 2 * 1024 * 1024   # GET returns at most the last ~2 MB of a day-file


def _prune_debug_logs(display_id, now: datetime) -> None:
    """Delete this display's day-files older than the retention window (by mtime)."""
    cutoff = (now - timedelta(days=_DEBUG_LOG_RETENTION_DAYS)).timestamp()
    for p in _DEBUG_LOG_DIR.glob(f"ambient-{display_id}-*.log"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


def _tail_text(path: Path, max_bytes: int) -> str:
    """Return a file's text, capped to the last `max_bytes` (dropping a partial leading line)."""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                data = f.read()
                nl = data.find(b"\n")
                if nl != -1:
                    data = data[nl + 1:]
                return f"… (truncated to last {max_bytes // 1024} KB) …\n" + data.decode("utf-8", "ignore")
            return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _is_built_concat(url_or_path) -> bool:
    """True only for files WE built (ambient-<id>-playlist-<sig>.mp4). A single-item playlist points
    `playlist_video_path` straight at a real media clip; those must NEVER be deleted as 'stale'."""
    return bool(url_or_path) and "-playlist-" in Path(url_or_path).name


def _unlink_upload(upload_dir: Path, url_or_path) -> None:
    if not url_or_path:
        return
    f = upload_dir / Path(url_or_path).name
    if f.exists():
        try:
            f.unlink()
        except OSError:
            pass


def _unlink_quiet(path: Path) -> None:
    """Best-effort delete of an absolute path (ignore if missing / locked)."""
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


# ----------------------------------------------------------------------------------------------
# Hybrid playback: the viewer ALWAYS runs the per-item engine (full-quality images as <img>, videos
# played individually). The only server-side "joining" is a LOSSLESS concat of a RUN of ≥2 ADJACENT
# videos into one clip (built by media_utils.build_video_run) so that back-to-back videos play as a
# single never-reloaded <video> on Tizen (motion-seamless). Images are never baked into a video.
# Run clips are named ambient-<id>-run-<sig>.mp4 (+ -poster.png); their existence on disk is the source
# of truth — get_ambient_display collapses a run into one media item only when the file is present.
# ----------------------------------------------------------------------------------------------

def _is_built_run(url_or_path) -> bool:
    """True for a run clip WE built (ambient-<id>-run-<sig>.mp4 / -poster.png)."""
    return bool(url_or_path) and "-run-" in Path(url_or_path).name


def _group_runs(rows):
    """Split ordered media rows into groups: each group is either a maximal run of consecutive videos
    (same playlist) or a single non-video row. A group of ≥2 videos is a run-concat candidate."""
    groups, cur = [], []
    for r in rows:
        if (r["media_type"] == "video" and cur
                and cur[-1]["media_type"] == "video" and cur[-1]["playlist"] == r["playlist"]):
            cur.append(r)
        else:
            if cur:
                groups.append(cur)
            cur = [r]
    if cur:
        groups.append(cur)
    return groups


def _is_video_group(g) -> bool:
    return bool(g) and all(r["media_type"] == "video" for r in g)


def _playback_groups(rows):
    """Ordered playback groups, with the loop wrap made black-free for the video→video case.

    When the playlist is video-bounded (first AND last items are videos) AND has at least one non-video
    item, the trailing + leading video runs are *adjacent across the loop wrap*. We merge them into ONE
    wrap-run and ROTATE so it sits contiguously at the END. The viewer then plays
    `[...middle..., wrapRun]`, so the Vlast→V0 transition happens INSIDE one lossless clip (gapless, no
    src swap / seek / poster) and the loop's file boundary becomes a safe video→image edge (the rotated
    list starts on the first non-video item). Deterministic, so the build and the view agree.

    (All-video playlists collapse to a single video group here; the caller routes those to the MSE
    gapless-loop path instead, since there is no image to absorb the file restart.)"""
    groups = _group_runs(rows)
    if (len(groups) >= 2 and _is_video_group(groups[0]) and _is_video_group(groups[-1])
            and any(not _is_video_group(g) for g in groups)):
        wrap = list(groups[-1]) + list(groups[0])   # [Vlast run...] + [V0 run...]
        return groups[1:-1] + [wrap]                # rotate: start after the leading run, end with wrap
    return groups


def _run_sig(run_rows) -> str:
    """Stable signature of a run (its ordered source filenames) → content-addressed run-clip name."""
    src = "|".join(Path(r["file_path"]).name for r in run_rows)
    return hashlib.sha1(src.encode("utf-8")).hexdigest()[:12]


def _collapse_runs_for_view(rows, display_id: int, upload_dir: Path):
    """Return the playback media list with each BUILT video run collapsed into one synthetic video item
    (file_path = run clip, poster_path = run's last-frame poster). A run whose clip isn't on disk yet is
    left as individual videos (safe per-item fallback). Never raises into the request."""
    out = []
    for g in _playback_groups(rows):
        if len(g) >= 2 and _is_video_group(g):
            sig = _run_sig(g)
            run_name = f"ambient-{display_id}-run-{sig}.mp4"
            run_disk = upload_dir / run_name
            if run_disk.exists() and run_disk.stat().st_size > 0:
                first = g[0]
                poster_name = f"ambient-{display_id}-run-{sig}-poster.png"
                poster_url = f"/uploads/{poster_name}" if (upload_dir / poster_name).exists() else None
                out.append({
                    "id": first["id"],
                    "ambient_display_id": display_id,
                    "file_path": f"/uploads/{run_name}",
                    "media_type": "video",
                    "playlist": first["playlist"],
                    "sort_order": first["sort_order"],
                    "status": first["status"],
                    "poster_path": poster_url,
                    "duration": None,
                })
                continue
        out.extend(dict(r) for r in g)
    return out


def _regenerate_playlist_video(db: sqlite3.Connection, display_id: int) -> None:
    """Rebuild the LOSSLESS video-run clips for a display's LIVE playlist (best-effort, idempotent).

    The viewer always runs the per-item engine, so there is NO whole-playlist concat any more — that
    file baked images (quality loss) and produced decode-stall seams. Instead, for each maximal run of
    ≥2 ADJACENT compatible videos we build ONE stream-copy clip (`media_utils.build_video_run`) so a
    back-to-back video run plays as a single never-reloaded <video> (motion-seamless, zero quality
    loss). Images and lone videos are left untouched. Called after any change to live content
    (publish / reorder / delete). On every call it also clears any LEGACY whole-playlist concat pointer
    and prunes run clips that are no longer referenced.
    """
    disp = db.execute(
        "SELECT active_playlist, playlist_video_path FROM ambient_displays WHERE id = ?",
        (display_id,),
    ).fetchone()
    if not disp:
        return

    upload_dir = Path(settings.UPLOAD_DIR)

    # 1. Retire the legacy whole-playlist concat entirely (the viewer never uses it now).
    old_path = disp["playlist_video_path"]
    if old_path is not None:
        db.execute(
            "UPDATE ambient_displays SET playlist_video_path = NULL, playlist_video_sig = NULL WHERE id = ?",
            (display_id,),
        )
        db.commit()
    if _is_built_concat(old_path):
        _unlink_upload(upload_dir, old_path)

    # 2. Build the lossless joined clips the live set needs.
    playlist = disp["active_playlist"] or "A"
    rows = db.execute(
        """SELECT file_path, media_type, playlist, sort_order FROM ambient_media
           WHERE ambient_display_id = ? AND playlist = ? AND status = 'live'
           ORDER BY COALESCE(live_sort_order, sort_order), id""",
        (display_id, playlist),
    ).fetchall()

    wanted_runs = set()   # per-item run clips (ambient-<id>-run-<sig>.mp4)
    wanted_loops = set()  # all-video MSE loop clips (ambient-<id>-mseloop-<sig>.mp4)

    if rows and _is_video_group(rows):
        # ALL videos, no image to absorb the loop restart → one fragmented clip looped gaplessly via MSE.
        sig = _run_sig(rows)
        loop_name = f"ambient-{display_id}-mseloop-{sig}.mp4"
        wanted_loops.add(loop_name)
        loop_path = upload_dir / loop_name
        if not (loop_path.exists() and loop_path.stat().st_size > 0):
            srcs = [upload_dir / Path(r["file_path"]).name for r in rows]
            build_mse_loop(srcs, loop_path)  # best-effort; writes loop + .codecs sidecar
    else:
        # Mixed / has images → per-item engine. Pre-join each run of ≥2 adjacent videos (incl. the
        # cyclic wrap-run when first AND last are videos, via _playback_groups) into one lossless clip.
        for g in _playback_groups(rows):
            if len(g) < 2 or not _is_video_group(g):
                continue
            sig = _run_sig(g)
            run_name = f"ambient-{display_id}-run-{sig}.mp4"
            wanted_runs.add(run_name)
            run_path = upload_dir / run_name
            if run_path.exists() and run_path.stat().st_size > 0:
                continue  # already built (content-addressed) — keep it
            srcs = [upload_dir / Path(r["file_path"]).name for r in g]
            if build_video_run(srcs, run_path):
                # Lossless last-frame poster (covers the run→next-item edge on Tizen).
                extract_last_frame(run_path, upload_dir / f"ambient-{display_id}-run-{sig}-poster.png")
            # If the build failed, the file is absent → get_ambient_display shows the videos per-item.

    # 3. Prune joined clips this display no longer references (run clips + posters, and MSE loop clips
    #    + their .codecs sidecars).
    for p in upload_dir.glob(f"ambient-{display_id}-run-*.mp4"):
        if p.name not in wanted_runs:
            _unlink_quiet(p)
            _unlink_quiet(p.with_name(p.stem + "-poster.png"))
    for p in upload_dir.glob(f"ambient-{display_id}-mseloop-*.mp4"):
        if p.name not in wanted_loops:
            _unlink_quiet(p)
            _unlink_quiet(p.with_name(p.name + ".codecs"))


@router.get("", response_model=list[AmbientDisplayOut])
def list_ambient_displays(
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    # Admin list = the WORKING (draft) view: orientation + announcement come from the draft_* columns
    # (falling back to live when a draft was never set), so the cards/edit form reflect unpublished edits.
    # media_count counts only the working set (excludes items staged for removal).
    rows = db.execute(
        """
        SELECT ad.id, ad.branch_id, ad.name, ad.active_playlist,
               COALESCE(ad.draft_orientation, ad.orientation)                   AS orientation,
               COALESCE(ad.draft_announcement_label, ad.announcement_label)     AS announcement_label,
               COALESCE(ad.draft_announcement_name, ad.announcement_name)       AS announcement_name,
               COALESCE(ad.draft_announcement_title, ad.announcement_title)     AS announcement_title,
               COALESCE(ad.draft_announcement_enabled, ad.announcement_enabled) AS announcement_enabled,
               COUNT(CASE WHEN am.draft_removed = 0 THEN am.id END) AS media_count
        FROM ambient_displays ad
        LEFT JOIN ambient_media am ON am.ambient_display_id = ad.id
        GROUP BY ad.id ORDER BY ad.id
        """
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("", response_model=AmbientDisplayOut, status_code=201)
def create_ambient_display(
    body: AmbientDisplayCreate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    branch = db.execute("SELECT id FROM branches WHERE id = ?", (body.branch_id,)).fetchone()
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")

    orientation = body.orientation if body.orientation in ("landscape", "portrait") else "landscape"

    cursor = db.execute(
        "INSERT INTO ambient_displays (branch_id, name, orientation) VALUES (?, ?, ?)",
        (body.branch_id, name, orientation),
    )
    db.commit()
    return {
        "id": cursor.lastrowid,
        "branch_id": body.branch_id,
        "name": name,
        "orientation": orientation,
        "active_playlist": "A",
        "announcement_label": "Actis welcomes",
        "announcement_name": "",
        "announcement_title": "",
        "announcement_enabled": 0,
        "media_count": 0,
    }


@router.get("/{display_id}")
def get_ambient_display(
    display_id: int,
    playlist: str = Query(default=None),
    admin: bool = Query(default=False),
    db: sqlite3.Connection = Depends(db_dependency),
    _viewer: None = Depends(get_display_viewer),
):
    disp = db.execute(
        "SELECT * FROM ambient_displays WHERE id = ?", (display_id,)
    ).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    # The live viewer never sends a playlist (it doesn't know the active one until this response
    # comes back), but it must only ever see ONE playlist's media — otherwise _is_video_group/_run_sig/
    # _collapse_runs_for_view below run on a cross-playlist-merged row set, which can mis-signature the
    # run/loop clips built by _regenerate_playlist_video (always single-playlist-scoped) and misgroup
    # adjacent-video runs across playlists. Resolve to the published active playlist up front so the
    # rest of this function only ever operates on one playlist's rows, matching publish-time scoping.
    if not admin and playlist not in ("A", "B"):
        playlist = disp["active_playlist"] or "A"

    # Draft-staging: the admin/preview ("working") view shows everything not pending-removal, in the
    # working order (sort_order). The live (published) view shows only status='live' media in the
    # PUBLISHED order (live_sort_order) — staged reorders/adds/deletes don't reach it until Publish.
    if admin:
        row_filter = "AND draft_removed = 0"
        order_expr = "sort_order"
    else:
        row_filter = "AND status = 'live'"
        order_expr = "COALESCE(live_sort_order, sort_order)"

    cols = "id, ambient_display_id, file_path, media_type, playlist, sort_order, live_sort_order, draft_removed, status, poster_path, thumb_path, duration"
    if playlist and playlist in ("A", "B"):
        media_rows = db.execute(
            f"""SELECT {cols} FROM ambient_media
                WHERE ambient_display_id = ? AND playlist = ? {row_filter}
                ORDER BY {order_expr}, id""",
            (display_id, playlist),
        ).fetchall()
    else:
        media_rows = db.execute(
            f"""SELECT {cols} FROM ambient_media
                WHERE ambient_display_id = ? {row_filter}
                ORDER BY {order_expr}, id""",
            (display_id,),
        ).fetchall()

    # The whole-playlist concat is retired (it baked images and produced decode-stall seams). The viewer
    # runs the per-item engine for any playlist containing an image, and the MSE gapless-loop engine for
    # an ALL-VIDEO playlist (no image to absorb the loop restart). `playlist_video` stays None so a stale
    # built concat is never served. Defaults below keep image/mixed playlists on the per-item path.
    playlist_video = None
    playback_mode = "per-item"
    loop_video = None
    loop_codec = None
    upload_dir = Path(settings.UPLOAD_DIR)

    if admin:
        media = [dict(m) for m in media_rows]
    else:
        try:
            if media_rows and _is_video_group(media_rows):
                # ALL-VIDEO live playlist → MSE gapless loop on one fragmented clip (built by
                # _regenerate_playlist_video). Falls back to per-item if the loop clip isn't on disk yet.
                sig = _run_sig(media_rows)
                loop_name = f"ambient-{display_id}-mseloop-{sig}.mp4"
                loop_disk = upload_dir / loop_name
                if loop_disk.exists() and loop_disk.stat().st_size > 0:
                    playback_mode = "mse-loop"
                    loop_video = f"/uploads/{loop_name}"
                    codecs_file = upload_dir / f"{loop_name}.codecs"
                    loop_codec = codecs_file.read_text(encoding="utf-8").strip() if codecs_file.exists() else None
                media = [dict(m) for m in media_rows]  # raw rows kept for the per-item fallback
            else:
                # Mixed / has images → per-item, with built video runs (incl. the cyclic wrap-run)
                # collapsed into single items.
                media = _collapse_runs_for_view(media_rows, display_id, upload_dir)
        except Exception:  # pragma: no cover - safety: never break the endpoint
            playback_mode, loop_video, loop_codec = "per-item", None, None
            media = [dict(m) for m in media_rows]

    # Admin/preview reads the DRAFT (working) config under the normal keys; live reads the published
    # columns. (COALESCE-style: a draft field that is NULL falls back to its live value.) Empty strings
    # and 0 are valid draft values, so test `is not None` rather than truthiness.
    def _draft(field):
        dv = disp[f"draft_{field}"]
        return dv if dv is not None else disp[field]

    if admin:
        orientation = _draft("orientation")
        ann_label = _draft("announcement_label")
        ann_name = _draft("announcement_name")
        ann_title = _draft("announcement_title")
        ann_enabled = _draft("announcement_enabled")
    else:
        orientation = disp["orientation"]
        ann_label = disp["announcement_label"]
        ann_name = disp["announcement_name"]
        ann_title = disp["announcement_title"]
        ann_enabled = disp["announcement_enabled"]

    # Publish-state flags for the admin UI (only meaningful when a specific playlist is requested).
    is_live = None
    has_unpublished_changes = None
    if admin and playlist in ("A", "B"):
        is_live = playlist == disp["active_playlist"]
        media_changes = db.execute(
            """SELECT COUNT(*) AS c FROM ambient_media
               WHERE ambient_display_id = ? AND playlist = ?
                 AND (status = 'draft' OR draft_removed = 1
                      OR (status = 'live' AND COALESCE(live_sort_order, sort_order) != sort_order))""",
            (display_id, playlist),
        ).fetchone()["c"]
        config_changed = (
            _draft("orientation") != disp["orientation"]
            or _draft("announcement_label") != disp["announcement_label"]
            or _draft("announcement_name") != disp["announcement_name"]
            or _draft("announcement_title") != disp["announcement_title"]
            or _draft("announcement_enabled") != disp["announcement_enabled"]
        )
        has_unpublished_changes = (not is_live) or media_changes > 0 or config_changed

    return {
        "id": disp["id"],
        "branch_id": disp["branch_id"],
        "name": disp["name"],
        "orientation": orientation,
        "active_playlist": disp["active_playlist"],
        "announcement_label": ann_label or "Actis welcomes",
        "announcement_name": ann_name or "",
        "announcement_title": ann_title or "",
        "announcement_enabled": ann_enabled,
        "is_live": is_live,
        "has_unpublished_changes": has_unpublished_changes,
        "playlist_video": playlist_video,
        "playback_mode": playback_mode,
        "loop_video": loop_video,
        "loop_codec": loop_codec,
        "media": media,
    }


@router.put("/{display_id}", response_model=AmbientDisplayOut)
def update_ambient_display(
    display_id: int,
    body: AmbientDisplayUpdate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    disp = db.execute("SELECT * FROM ambient_displays WHERE id = ?", (display_id,)).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    # Draft-staging: announcement + orientation edits write to the DRAFT columns only. They surface on
    # the preview link (admin reads draft) and reach the live link solely via Publish. `name` is not a
    # broadcast concern (admin label), so it stays on the live column. `active_playlist` is owned by
    # publish/switch endpoints and intentionally not changed here.
    name = body.name.strip() if body.name is not None else disp["name"]

    def _cur_draft(field):
        dv = disp[f"draft_{field}"]
        return dv if dv is not None else disp[field]

    draft_orientation = body.orientation if body.orientation in ("landscape", "portrait") else _cur_draft("orientation")
    draft_label = body.announcement_label if body.announcement_label is not None else _cur_draft("announcement_label")
    draft_name = body.announcement_name if body.announcement_name is not None else _cur_draft("announcement_name")
    draft_title = body.announcement_title if body.announcement_title is not None else _cur_draft("announcement_title")
    draft_enabled = body.announcement_enabled if body.announcement_enabled is not None else _cur_draft("announcement_enabled")

    db.execute(
        """UPDATE ambient_displays
           SET name = ?, draft_orientation = ?, draft_announcement_label = ?,
               draft_announcement_name = ?, draft_announcement_title = ?, draft_announcement_enabled = ?
           WHERE id = ?""",
        (name, draft_orientation, draft_label, draft_name, draft_title, draft_enabled, display_id),
    )
    db.commit()

    media_count = db.execute(
        "SELECT COUNT(*) AS cnt FROM ambient_media WHERE ambient_display_id = ?", (display_id,)
    ).fetchone()["cnt"]

    # Echo back the DRAFT (working) values so the admin form reflects what was just saved.
    return {
        "id": display_id,
        "branch_id": disp["branch_id"],
        "name": name,
        "orientation": draft_orientation,
        "active_playlist": disp["active_playlist"],
        "announcement_label": draft_label or "Actis welcomes",
        "announcement_name": draft_name or "",
        "announcement_title": draft_title or "",
        "announcement_enabled": draft_enabled,
        "media_count": media_count,
    }


@router.put("/{display_id}/active-playlist")
def set_active_playlist(
    display_id: int,
    body: ActivePlaylistRequest,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    if body.playlist not in ("A", "B"):
        raise HTTPException(status_code=400, detail="Playlist must be 'A' or 'B'")

    disp = db.execute("SELECT id FROM ambient_displays WHERE id = ?", (display_id,)).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    db.execute("UPDATE ambient_displays SET active_playlist = ? WHERE id = ?", (body.playlist, display_id))
    db.commit()
    return {"status": "ok", "active_playlist": body.playlist}


@router.post("/{display_id}/publish-playlist")
def publish_playlist(
    display_id: int,
    body: PublishPlaylistRequest,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    if body.playlist not in ("A", "B"):
        raise HTTPException(status_code=400, detail="Playlist must be 'A' or 'B'")

    disp = db.execute("SELECT id FROM ambient_displays WHERE id = ?", (display_id,)).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    other_playlist = "B" if body.playlist == "A" else "A"

    # 1. Commit staged DELETES: hard-remove rows marked draft_removed in the target playlist (+ their files).
    removed = db.execute(
        "SELECT id, file_path, poster_path, thumb_path FROM ambient_media WHERE ambient_display_id = ? AND playlist = ? AND draft_removed = 1",
        (display_id, body.playlist),
    ).fetchall()
    for m in removed:
        for col in ("file_path", "poster_path", "thumb_path"):
            if m[col]:
                _unlink_upload(Path(settings.UPLOAD_DIR), m[col])
        db.execute("DELETE FROM ambient_media WHERE id = ?", (m["id"],))

    # 2. Promote target playlist draft → live and commit the working order as the published order.
    db.execute(
        "UPDATE ambient_media SET status = 'live', live_sort_order = sort_order, draft_removed = 0 WHERE ambient_display_id = ? AND playlist = ?",
        (display_id, body.playlist),
    )
    # 3. Demote the other playlist live → draft (A/B swap, unchanged behaviour).
    db.execute(
        "UPDATE ambient_media SET status = 'draft' WHERE ambient_display_id = ? AND playlist = ?",
        (display_id, other_playlist),
    )
    # 4. Promote the staged display config (orientation + announcement) draft → live, set active playlist.
    db.execute(
        """UPDATE ambient_displays
           SET active_playlist = ?,
               orientation          = COALESCE(draft_orientation, orientation),
               announcement_label   = COALESCE(draft_announcement_label, announcement_label),
               announcement_name    = COALESCE(draft_announcement_name, announcement_name),
               announcement_title   = COALESCE(draft_announcement_title, announcement_title),
               announcement_enabled = COALESCE(draft_announcement_enabled, announcement_enabled)
           WHERE id = ?""",
        (body.playlist, display_id),
    )
    db.commit()

    # Live content just changed — rebuild the lossless joined clips for the panel from the published set.
    _regenerate_playlist_video(db, display_id)

    return {"status": "ok", "active_playlist": body.playlist}


@router.delete("/{display_id}", status_code=204)
def delete_ambient_display(
    display_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    disp = db.execute(
        "SELECT id, playlist_video_path FROM ambient_displays WHERE id = ?", (display_id,)
    ).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    media_rows = db.execute(
        "SELECT file_path, poster_path FROM ambient_media WHERE ambient_display_id = ?", (display_id,)
    ).fetchall()
    for m in media_rows:
        filepath = Path(settings.UPLOAD_DIR) / Path(m["file_path"]).name
        if filepath.exists():
            filepath.unlink()
        if m["poster_path"]:
            poster = Path(settings.UPLOAD_DIR) / Path(m["poster_path"]).name
            if poster.exists():
                poster.unlink()

    upload_dir = Path(settings.UPLOAD_DIR)
    # Remove any legacy BUILT whole-playlist concat (not an ambient_media row).
    if _is_built_concat(disp["playlist_video_path"]):
        _unlink_upload(upload_dir, disp["playlist_video_path"])
    # Remove this display's built video-run clips (+ their posters) — also not ambient_media rows.
    for p in upload_dir.glob(f"ambient-{display_id}-run-*"):
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass

    db.execute("DELETE FROM ambient_displays WHERE id = ?", (display_id,))
    db.commit()


@router.post("/{display_id}/media")
def upload_ambient_media(
    display_id: int,
    files: list[UploadFile] = File(...),
    playlist: str = Form(default="A"),
    durations: str = Form(default=""),
    user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(db_dependency),
):
    if playlist not in ("A", "B"):
        playlist = "A"

    disp = db.execute(
        "SELECT id, COALESCE(draft_orientation, orientation) AS orientation FROM ambient_displays WHERE id = ?",
        (display_id,),
    ).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")
    orientation = disp["orientation"] or "landscape"

    upload_dir = Path(settings.UPLOAD_DIR)
    upload_dir.mkdir(exist_ok=True)

    # Image-safety warnings (aspect/size) collected across this batch and returned to the admin UI.
    warnings = []

    # Optional per-file image durations (seconds), comma-separated and aligned to `files` by index.
    # FULLY OPTIONAL and backward-compatible: the current upload UI doesn't send it, so every entry is
    # NULL and images use the default seconds. A future UI can send e.g. "8,,5" to set durations at
    # upload time without any change to this endpoint's existing callers. Only applied to images.
    dur_tokens = [t.strip() for t in durations.split(",")] if durations else []

    def _parse_duration(idx: int):
        if idx >= len(dur_tokens) or not dur_tokens[idx]:
            return None
        try:
            val = int(dur_tokens[idx])
            return val if val > 0 else None
        except ValueError:
            return None

    max_order = db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) AS mx FROM ambient_media WHERE ambient_display_id = ? AND playlist = ?",
        (display_id, playlist),
    ).fetchone()["mx"]

    uploaded = []
    for i, file in enumerate(files):
        if file.content_type not in settings.ALLOWED_MEDIA_TYPES:
            raise HTTPException(status_code=400, detail=f"Invalid file type: {file.content_type}")

        content = file.file.read()
        max_size = settings.MAX_VIDEO_SIZE if file.content_type.startswith("video/") else settings.MAX_IMAGE_SIZE
        if len(content) > max_size:
            raise HTTPException(status_code=400, detail=f"File too large: {len(content) / 1024 / 1024:.1f}MB")

        ext_map = {
            "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
            "video/mp4": ".mp4", "video/webm": ".webm",
        }
        ext = ext_map.get(file.content_type, ".bin")
        media_type = "video" if file.content_type.startswith("video/") else "image"
        ts = int(time.time())
        filename = f"ambient-{display_id}-{ts}-{i}{ext}"
        filepath = upload_dir / filename
        filepath.write_bytes(content)

        # For videos: (1) normalize to a Tizen-friendly MP4 (faststart + uniform H.264) for faster,
        # more consistent first-frame decode, then (2) extract a last-frame poster so the viewer can
        # hold the final frame on screen during the next clip's decode (no black gap). Both steps are
        # best-effort: if ffmpeg is missing or fails we keep the original upload, and (respectively)
        # leave poster_path NULL so the viewer degrades to its canvas bridge.
        poster_path = None
        thumb_path = None
        if media_type == "video":
            normalized_name = f"ambient-{display_id}-{ts}-{i}-norm.mp4"
            normalized_path = upload_dir / normalized_name
            # normalize_video is 3-state: 'written' (a -norm.mp4 was produced → serve it, drop the raw),
            # 'skip' (source already H.264/yuv420p/<=1080p/<=30fps AND faststart → serve the ORIGINAL
            # byte-for-byte; nothing written, raw KEPT), or 'failed' (serve the original as a fallback).
            if normalize_video(filepath, normalized_path) == "written":
                # Raw upload superseded by the -norm.mp4 (its bytes were never referenced by any URL).
                try:
                    filepath.unlink()
                except OSError:
                    pass
                filename = normalized_name
                filepath = normalized_path
            # 'skip'/'failed' → keep the ORIGINAL as the served file (filename/filepath unchanged).
            poster_filename = f"{Path(filename).stem}-poster.png"  # lossless PNG cover (no soft poster)
            if extract_last_frame(filepath, upload_dir / poster_filename):
                poster_path = f"/uploads/{poster_filename}"
            # First-frame still for the admin media-list tile (best-effort; falls back to the Film icon).
            thumb_filename = f"{Path(filename).stem}-thumb.jpg"
            if extract_first_frame(filepath, upload_dir / thumb_filename):
                thumb_path = f"/uploads/{thumb_filename}"
        elif media_type == "image":
            # Image-safety contract: (1) downscale ONLY if the image exceeds the 1920x1080 Tizen
            # ceiling — one high-quality Lanczos resample, aspect preserved, never upscaled/cropped —
            # overwriting the original under the same name/URL; (2) warn (or, under AMBIENT_IMAGE_STRICT,
            # reject) when the aspect ratio doesn't match the display's target. Best-effort: an ffmpeg
            # miss just serves the original bytes.
            fit_path = upload_dir / f"{Path(filename).stem}-fit{ext}"
            if normalize_image(filepath, fit_path) == "written":
                fit_path.replace(filepath)  # atomic overwrite; same filename → served URL unchanged
                warnings.append(f"{file.filename}: downscaled to fit the 1920x1080 panel ceiling")
            meta = probe_image(filepath)
            if meta:
                aspect_warn = image_aspect_warning(
                    meta["w"], meta["h"], orientation, settings.AMBIENT_IMAGE_ASPECT_TOLERANCE
                )
                if aspect_warn:
                    if settings.AMBIENT_IMAGE_STRICT:
                        try:
                            filepath.unlink()
                        except OSError:
                            pass
                        raise HTTPException(status_code=400, detail=f"{file.filename}: {aspect_warn}")
                    warnings.append(f"{file.filename}: {aspect_warn}")

        # Per-image on-screen seconds (images only; NULL for video → uses its own length).
        duration = _parse_duration(i) if media_type == "image" else None

        sort_order = max_order + 1 + i
        cursor = db.execute(
            "INSERT INTO ambient_media (ambient_display_id, file_path, media_type, playlist, sort_order, poster_path, thumb_path, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (display_id, f"/uploads/{filename}", media_type, playlist, sort_order, poster_path, thumb_path, duration),
        )
        db.commit()
        uploaded.append({
            "id": cursor.lastrowid,
            "ambient_display_id": display_id,
            "file_path": f"/uploads/{filename}",
            "media_type": media_type,
            "playlist": playlist,
            "sort_order": sort_order,
            "status": "draft",
            "poster_path": poster_path,
            "thumb_path": thumb_path,
            "duration": duration,
        })

    return {"media": uploaded, "warnings": warnings}


@router.put("/{display_id}/media/reorder")
def reorder_ambient_media(
    display_id: int,
    body: MediaReorderRequest,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    # Draft-staging: reorder writes the WORKING order (sort_order) only. The published order
    # (live_sort_order) and the panel's joined clips are untouched until Publish — so the live link
    # keeps playing its current order with no disturbance.
    for idx, media_id in enumerate(body.media_ids):
        db.execute(
            "UPDATE ambient_media SET sort_order = ? WHERE id = ? AND ambient_display_id = ?",
            (idx, media_id, display_id),
        )
    db.commit()
    return {"status": "ok"}


@router.delete("/media/{media_id}", status_code=204)
def delete_ambient_media(
    media_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    media = db.execute("SELECT * FROM ambient_media WHERE id = ?", (media_id,)).fetchone()
    if not media:
        raise HTTPException(status_code=404, detail="Media not found")

    # Draft-staging: a PUBLISHED (live) item is only marked for removal — it stays on the live link
    # until Publish (which hard-deletes it + its files). A draft-only item (never published) is removed
    # immediately. Either way it disappears from the admin/preview working view at once.
    if media["status"] == "live":
        db.execute("UPDATE ambient_media SET draft_removed = 1 WHERE id = ?", (media_id,))
        db.commit()
        return

    for col in ("file_path", "poster_path", "thumb_path"):
        if media[col]:
            f = Path(settings.UPLOAD_DIR) / Path(media[col]).name
            if f.exists():
                f.unlink()
    db.execute("DELETE FROM ambient_media WHERE id = ?", (media_id,))
    db.commit()


# ----------------------------------------------------------------------------------------------
# On-panel debug-log capture (?debug=true). The viewer POSTs its rolling event log + HUD header so
# we can read it back from a browser (GET .../debug-log/latest) instead of photographing the TV.
# ----------------------------------------------------------------------------------------------

@router.post("/{display_id}/debug-log")
async def post_ambient_debug_log(display_id: int, request: Request):
    """Append a batch of debug events from the on-panel viewer to today's day-file, in full detail.
    The viewer only POSTs while `?debug=true` is open and streams EVERY event (not a rolling window),
    so the day-file is a complete, timestamped transcript. Best-effort, unauthenticated (local
    network); JSON sent as text/plain so the TV browser makes no CORS preflight."""
    raw = await request.body()
    if len(raw) > _DEBUG_LOG_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Debug log too large")
    try:
        payload = json.loads(raw.decode("utf-8", "ignore") or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    now = datetime.now(timezone.utc)
    events = payload.get("events") or []
    _DEBUG_LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Source of this batch: "TV" (Samsung panel) or "laptop" (regular browser). Both can open
    # ?debug=true and stream to the same day-file, so tag the snapshot and every event line.
    client = str(payload.get("client") or "?")
    client_tag = client[:6]  # short, fixed-width prefix for event lines

    # Overwritten status snapshot — a quick "right now" view (engine/build/url + live header).
    status = {
        "display_id": display_id,
        "captured_at": now.isoformat(timespec="seconds"),
        "engine": payload.get("engine"),
        "build": payload.get("build"),
        "client": client,
        "user_agent": payload.get("ua"),
        "url": payload.get("url"),
        "header": payload.get("header"),
    }
    (_DEBUG_LOG_DIR / f"ambient-{display_id}-latest.json").write_text(
        json.dumps(status, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Append every event (full detail) to today's day-file with a wall-clock timestamp.
    appended = 0
    if isinstance(events, list) and events:
        day_file = _DEBUG_LOG_DIR / f"ambient-{display_id}-{now.strftime('%Y-%m-%d')}.log"
        lines = []
        for e in events:
            if not isinstance(e, dict):
                continue
            at = e.get("at") or now.isoformat(timespec="milliseconds")
            seq = e.get("seq", "")
            klass = e.get("klass", "")
            msg = e.get("msg", "")
            lines.append(f"{at}  [{client_tag:<6}] #{seq:<7} [{klass:<9}] {msg}")
        if lines:
            with day_file.open("a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            appended = len(lines)

    _prune_debug_logs(display_id, now)
    return {"status": "ok", "appended": appended}


@router.get("/{display_id}/debug-log/latest", response_class=PlainTextResponse)
def get_ambient_debug_log_latest(
    display_id: int,
    date: str = Query(default=None),
    _viewer: None = Depends(get_display_viewer),
):
    """Return a day's FULL debug transcript as plain text (open in a browser, select-all, paste).
    Defaults to the most recent day; pass `?date=YYYY-MM-DD` to view another of the retained days.
    No-cache so a refresh always shows the newest events."""
    no_cache = {"Cache-Control": "no-store"}
    files = sorted(_DEBUG_LOG_DIR.glob(f"ambient-{display_id}-*.log"))
    if not files:
        return PlainTextResponse(
            f"No debug log captured yet for display {display_id}.\n"
            f"Open the viewer with ?debug=true on the panel, let it run, then refresh.",
            headers=no_cache,
        )

    available = [f.stem.split("-", 2)[2] for f in files]  # 'ambient-<id>-YYYY-MM-DD' -> 'YYYY-MM-DD'
    if date:
        target = _DEBUG_LOG_DIR / f"ambient-{display_id}-{date}.log"
        if not target.exists():
            return PlainTextResponse(
                f"No log for {date}. Available days: {', '.join(available)}", headers=no_cache,
            )
    else:
        target = files[-1]
    shown = target.stem.split("-", 2)[2]

    header_path = _DEBUG_LOG_DIR / f"ambient-{display_id}-latest.json"
    status = header_path.read_text(encoding="utf-8") if header_path.exists() else "(none)"
    body = (
        f"=== ambient display {display_id} — debug log ===\n"
        f"Available days (last {_DEBUG_LOG_RETENTION_DAYS}): {', '.join(available)}\n"
        f"Showing: {shown}   (append ?date=YYYY-MM-DD to view another day)\n\n"
        f"--- STATUS (latest snapshot) ---\n{status}\n\n"
        f"--- EVENTS (full detail) ---\n{_tail_text(target, _DEBUG_LOG_TAIL_BYTES)}"
    )
    return PlainTextResponse(body, headers=no_cache)
