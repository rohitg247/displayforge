import sqlite3
import json
import time
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from ..database import db_dependency
from ..auth import get_current_user
from ..config import settings

router = APIRouter()

ALLOWED_TYPES = settings.ALLOWED_IMAGE_TYPES
MAX_SIZE = settings.MAX_IMAGE_SIZE


@router.post("/case-study/{cs_id}/thumbnails")
def upload_thumbnails(
    cs_id: int,
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(db_dependency),
):
    try:
        # Validate case study exists
        cs = db.execute(
            "SELECT id, thumbnails FROM case_studies WHERE id = ?", (cs_id,)
        ).fetchone()
        if not cs:
            raise HTTPException(status_code=404, detail="Case study not found")

        existing_thumbnails = json.loads(cs["thumbnails"])

        if len(existing_thumbnails) + len(files) > 3:
            raise HTTPException(
                status_code=400,
                detail="Maximum 3 thumbnails allowed per case study",
            )

        upload_dir = Path(settings.UPLOAD_DIR)
        upload_dir.mkdir(exist_ok=True)

        new_paths = []
        for i, file in enumerate(files):
            # Validate file type
            if file.content_type not in ALLOWED_TYPES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid file type: {file.content_type}. Allowed: JPEG, PNG, WebP",
                )

            # Read and validate size
            content = file.file.read()
            if len(content) > MAX_SIZE:
                raise HTTPException(
                    status_code=400,
                    detail=f"File too large: {len(content) / 1024 / 1024:.1f}MB. Maximum: 5MB",
                )

            # Determine extension
            ext_map = {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "image/webp": ".webp",
            }
            ext = ext_map.get(file.content_type, ".jpg")
            filename = f"cs-{cs_id}-thumb-{len(existing_thumbnails) + i}-{int(time.time())}{ext}"
            filepath = upload_dir / filename

            filepath.write_bytes(content)
            new_paths.append(f"/uploads/{filename}")

        # Update DB
        all_thumbnails = existing_thumbnails + new_paths
        db.execute(
            "UPDATE case_studies SET thumbnails = ? WHERE id = ?",
            (json.dumps(all_thumbnails), cs_id),
        )
        db.commit()

        return {"thumbnails": all_thumbnails}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to upload thumbnails: {str(e)}"
        )


@router.delete("/case-study/{cs_id}/thumbnails/{index}", status_code=204)
def delete_thumbnail(
    cs_id: int,
    index: int,
    user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(db_dependency),
):
    try:
        cs = db.execute(
            "SELECT id, thumbnails FROM case_studies WHERE id = ?", (cs_id,)
        ).fetchone()
        if not cs:
            raise HTTPException(status_code=404, detail="Case study not found")

        thumbnails = json.loads(cs["thumbnails"])
        if index < 0 or index >= len(thumbnails):
            raise HTTPException(status_code=400, detail="Invalid thumbnail index")

        # Delete file from disk
        filepath = Path(settings.UPLOAD_DIR) / Path(thumbnails[index]).name
        if filepath.exists():
            filepath.unlink()

        thumbnails.pop(index)
        db.execute(
            "UPDATE case_studies SET thumbnails = ? WHERE id = ?",
            (json.dumps(thumbnails), cs_id),
        )
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to delete thumbnail: {str(e)}"
        )
