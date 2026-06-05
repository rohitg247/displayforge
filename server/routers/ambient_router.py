import sqlite3
import time
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
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
from ..media_utils import extract_last_frame, normalize_video

router = APIRouter()


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
            f"""SELECT id, ambient_display_id, file_path, media_type, playlist, sort_order, status, poster_path
                FROM ambient_media
                WHERE ambient_display_id = ? AND playlist = ? {status_filter}
                ORDER BY sort_order, id""",
            (display_id, playlist),
        ).fetchall()
    else:
        media_rows = db.execute(
            f"""SELECT id, ambient_display_id, file_path, media_type, playlist, sort_order, status, poster_path
                FROM ambient_media
                WHERE ambient_display_id = ? {status_filter}
                ORDER BY sort_order, id""",
            (display_id,),
        ).fetchall()

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

    return {"status": "ok", "active_playlist": body.playlist}


@router.delete("/{display_id}", status_code=204)
def delete_ambient_display(
    display_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    disp = db.execute("SELECT id FROM ambient_displays WHERE id = ?", (display_id,)).fetchone()
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

    db.execute("DELETE FROM ambient_displays WHERE id = ?", (display_id,))
    db.commit()


@router.post("/{display_id}/media")
def upload_ambient_media(
    display_id: int,
    files: list[UploadFile] = File(...),
    playlist: str = Form(default="A"),
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

        sort_order = max_order + 1 + i
        cursor = db.execute(
            "INSERT INTO ambient_media (ambient_display_id, file_path, media_type, playlist, sort_order, poster_path) VALUES (?, ?, ?, ?, ?, ?)",
            (display_id, f"/uploads/{filename}", media_type, playlist, sort_order, poster_path),
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
