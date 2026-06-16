import hashlib
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import PlainTextResponse
from ..database import db_dependency
from ..auth import get_current_user
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
from ..media_utils import extract_last_frame, normalize_video, build_video_run, build_mse_loop

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
           ORDER BY sort_order, id""",
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
    rows = db.execute(
        """
        SELECT ad.id, ad.branch_id, ad.name, ad.orientation, ad.active_playlist,
               ad.announcement_label, ad.announcement_name, ad.announcement_title,
               ad.announcement_enabled,
               COUNT(am.id) AS media_count
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
):
    disp = db.execute(
        "SELECT * FROM ambient_displays WHERE id = ?", (display_id,)
    ).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    status_filter = "" if admin else "AND status = 'live'"  # ← key line

    if playlist and playlist in ("A", "B"):
        media_rows = db.execute(
            f"""SELECT id, ambient_display_id, file_path, media_type, playlist, sort_order, status, poster_path, duration
                FROM ambient_media
                WHERE ambient_display_id = ? AND playlist = ? {status_filter}
                ORDER BY sort_order, id""",
            (display_id, playlist),
        ).fetchall()
    else:
        media_rows = db.execute(
            f"""SELECT id, ambient_display_id, file_path, media_type, playlist, sort_order, status, poster_path, duration
                FROM ambient_media
                WHERE ambient_display_id = ? {status_filter}
                ORDER BY sort_order, id""",
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

    return {
        "id": disp["id"],
        "branch_id": disp["branch_id"],
        "name": disp["name"],
        "orientation": disp["orientation"],
        "active_playlist": disp["active_playlist"],
        "announcement_label": disp["announcement_label"] or "Actis welcomes",
        "announcement_name": disp["announcement_name"] or "",
        "announcement_title": disp["announcement_title"] or "",
        "announcement_enabled": disp["announcement_enabled"],
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

    name = body.name.strip() if body.name is not None else disp["name"]
    orientation = body.orientation if body.orientation in ("landscape", "portrait") else disp["orientation"]
    active_playlist = body.active_playlist if body.active_playlist in ("A", "B") else disp["active_playlist"]
    announcement_label = body.announcement_label if body.announcement_label is not None else disp["announcement_label"]
    announcement_name = body.announcement_name if body.announcement_name is not None else disp["announcement_name"]
    announcement_title = body.announcement_title if body.announcement_title is not None else disp["announcement_title"]
    announcement_enabled = body.announcement_enabled if body.announcement_enabled is not None else disp["announcement_enabled"]

    db.execute(
        """UPDATE ambient_displays
           SET name = ?, orientation = ?, active_playlist = ?,
               announcement_label = ?, announcement_name = ?, announcement_title = ?,
               announcement_enabled = ?
           WHERE id = ?""",
        (name, orientation, active_playlist, announcement_label, announcement_name, announcement_title, announcement_enabled, display_id),
    )
    db.commit()

    media_count = db.execute(
        "SELECT COUNT(*) AS cnt FROM ambient_media WHERE ambient_display_id = ?", (display_id,)
    ).fetchone()["cnt"]

    return {
        "id": display_id,
        "branch_id": disp["branch_id"],
        "name": name,
        "orientation": orientation,
        "active_playlist": active_playlist,
        "announcement_label": announcement_label or "Actis welcomes",
        "announcement_name": announcement_name or "",
        "announcement_title": announcement_title or "",
        "announcement_enabled": announcement_enabled,
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

    # Promote selected playlist draft → live
    db.execute(
        "UPDATE ambient_media SET status = 'live' WHERE ambient_display_id = ? AND playlist = ?",
        (display_id, body.playlist),
    )
    # Demote other playlist live → draft
    db.execute(
        "UPDATE ambient_media SET status = 'draft' WHERE ambient_display_id = ? AND playlist = ?",
        (display_id, other_playlist),
    )
    # Set active_playlist
    db.execute(
        "UPDATE ambient_displays SET active_playlist = ? WHERE id = ?",
        (body.playlist, display_id),
    )
    db.commit()

    # Live content just changed — rebuild the single concatenated loop video for the panel.
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

    disp = db.execute("SELECT id FROM ambient_displays WHERE id = ?", (display_id,)).fetchone()
    if not disp:
        raise HTTPException(status_code=404, detail="Ambient display not found")

    upload_dir = Path(settings.UPLOAD_DIR)
    upload_dir.mkdir(exist_ok=True)

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

        # Per-image on-screen seconds (images only; NULL for video → uses its own length).
        duration = _parse_duration(i) if media_type == "image" else None

        sort_order = max_order + 1 + i
        cursor = db.execute(
            "INSERT INTO ambient_media (ambient_display_id, file_path, media_type, playlist, sort_order, poster_path, duration) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (display_id, f"/uploads/{filename}", media_type, playlist, sort_order, poster_path, duration),
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
            "duration": duration,
        })

    return {"media": uploaded}


@router.put("/{display_id}/media/reorder")
def reorder_ambient_media(
    display_id: int,
    body: MediaReorderRequest,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    for idx, media_id in enumerate(body.media_ids):
        db.execute(
            "UPDATE ambient_media SET sort_order = ? WHERE id = ? AND ambient_display_id = ?",
            (idx, media_id, display_id),
        )
    db.commit()
    _regenerate_playlist_video(db, display_id)
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

    filepath = Path(settings.UPLOAD_DIR) / Path(media["file_path"]).name
    if filepath.exists():
        filepath.unlink()

    if media["poster_path"]:
        poster = Path(settings.UPLOAD_DIR) / Path(media["poster_path"]).name
        if poster.exists():
            poster.unlink()

    db.execute("DELETE FROM ambient_media WHERE id = ?", (media_id,))
    db.commit()
    _regenerate_playlist_video(db, media["ambient_display_id"])


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
def get_ambient_debug_log_latest(display_id: int, date: str = Query(default=None)):
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
