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
from ..media_utils import extract_last_frame, normalize_video, build_playlist_video

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


def _regenerate_playlist_video(db: sqlite3.Connection, display_id: int) -> None:
    """Rebuild the single concatenated loop video for a display's LIVE playlist (best-effort).

    Playing one continuous file is what actually removes the Tizen per-clip black gap (no <video>.src
    swaps → no decoder teardown). This is called after any change to live content. It is idempotent
    via a signature of the live items: if the live set is unchanged the existing file is kept. On any
    failure it clears the pointer so the viewer cleanly falls back to its per-item engine.
    """
    disp = db.execute(
        "SELECT active_playlist, orientation, playlist_video_path, playlist_video_sig FROM ambient_displays WHERE id = ?",
        (display_id,),
    ).fetchone()
    if not disp:
        return

    playlist = disp["active_playlist"] or "A"
    rows = db.execute(
        """SELECT file_path, media_type, sort_order, duration FROM ambient_media
           WHERE ambient_display_id = ? AND playlist = ? AND status = 'live'
           ORDER BY sort_order, id""",
        (display_id, playlist),
    ).fetchall()

    upload_dir = Path(settings.UPLOAD_DIR)
    items = [{"file_path": r["file_path"], "media_type": r["media_type"], "duration": r["duration"]} for r in rows]

    # Signature of the live set (filenames + order + per-image duration + orientation + audio mode).
    # Unchanged sig ⇒ nothing to do. Use a STABLE hash (not Python's per-process salted hash()) so the
    # filename/skip check is consistent across restarts.
    sig_src = (
        "|".join(f"{it['media_type']}:{it['file_path']}:{it['duration'] or ''}" for it in items)
        + f"@{disp['orientation']}|audio={settings.AMBIENT_PLAYLIST_AUDIO}|img={settings.AMBIENT_IMAGE_SECONDS}"
    )
    sig = hashlib.sha1(sig_src.encode("utf-8")).hexdigest()[:12]

    old_path = disp["playlist_video_path"]

    # Single-item playlist needs no concat:
    #   one VIDEO -> point straight at that clip's URL; the viewer's seamless seek-to-0 loop runs on
    #                it directly (one <video> looping one file — lossless, no build).
    #   one IMAGE / empty -> NULL (a still never loop-blacks; the per-item engine renders it).
    if len(items) < 2:
        single_url = items[0]["file_path"] if (items and items[0]["media_type"] == "video") else None
        single_sig = ("single:" + single_url) if single_url else None
        if old_path != single_url or disp["playlist_video_sig"] != single_sig:
            db.execute(
                "UPDATE ambient_displays SET playlist_video_path = ?, playlist_video_sig = ? WHERE id = ?",
                (single_url, single_sig, display_id),
            )
            db.commit()
            if _is_built_concat(old_path) and Path(old_path).name != Path(single_url or "x").name:
                _unlink_upload(upload_dir, old_path)
        return

    if disp["playlist_video_sig"] == sig and disp["playlist_video_path"]:
        existing = upload_dir / Path(disp["playlist_video_path"]).name
        if existing.exists() and existing.stat().st_size > 0:
            return  # live set unchanged and file present — keep it

    out_name = f"ambient-{display_id}-playlist-{sig}.mp4"
    out_path = upload_dir / out_name
    abs_items = [
        {"file_path": str(upload_dir / Path(it["file_path"]).name),
         "media_type": it["media_type"], "duration": it["duration"]}
        for it in items
    ]
    ok = out_path.exists() and out_path.stat().st_size > 0
    if not ok:
        ok = build_playlist_video(
            abs_items, out_path, disp["orientation"],
            image_seconds=settings.AMBIENT_IMAGE_SECONDS,
            include_audio=settings.AMBIENT_PLAYLIST_AUDIO,
        )

    if ok:
        db.execute(
            "UPDATE ambient_displays SET playlist_video_path = ?, playlist_video_sig = ? WHERE id = ?",
            (f"/uploads/{out_name}", sig, display_id),
        )
        db.commit()
        # Remove a now-superseded BUILT concat (never a real media clip pointed at directly).
        if _is_built_concat(old_path) and Path(old_path).name != out_name:
            _unlink_upload(upload_dir, old_path)
    else:
        # Build failed — clear the pointer so the viewer falls back to the per-item engine.
        if disp["playlist_video_path"]:
            db.execute(
                "UPDATE ambient_displays SET playlist_video_path = NULL, playlist_video_sig = NULL WHERE id = ?",
                (display_id,),
            )
            db.commit()


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

    # The pre-built single-loop video applies to the LIVE active playlist only (it's what removes the
    # Tizen per-clip black gap). Don't offer it in admin/preview mode (draft content, specific
    # playlist) — there the per-item engine renders the draft. `disp` is SELECT * so the column is
    # present once the migration has run; guard with a default for older rows.
    playlist_video = None
    if not admin:
        pv = disp["playlist_video_path"] if "playlist_video_path" in disp.keys() else None
        if pv:
            pv_disk = Path(settings.UPLOAD_DIR) / Path(pv).name
            if pv_disk.exists() and pv_disk.stat().st_size > 0:
                playlist_video = pv

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
        "media": [dict(m) for m in media_rows],
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

    # Remove the BUILT concatenated loop video too (it's not an ambient_media row). Skip when the
    # pointer is a single real clip URL — that file is already handled by the media loop above.
    if _is_built_concat(disp["playlist_video_path"]):
        _unlink_upload(Path(settings.UPLOAD_DIR), disp["playlist_video_path"])

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
            if normalize_video(filepath, normalized_path):
                # Serve the normalized file; drop the raw upload (its bytes were never referenced by
                # any URL, so removing it is safe and avoids leaving an orphan on disk).
                try:
                    filepath.unlink()
                except OSError:
                    pass
                filename = normalized_name
                filepath = normalized_path
            poster_filename = f"{Path(filename).stem}-poster.jpg"
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
