import sqlite3
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from ..database import db_dependency
from ..auth import get_current_user, get_display_viewer
from ..models import DisplayCreate, DisplayUpdate, DisplayOut

router = APIRouter()


@router.get("", response_model=list[DisplayOut])
def list_displays(
    branch_id: int = Query(None),
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        if branch_id is not None:
            rows = db.execute(
                """
                SELECT d.id, d.branch_id, d.name,
                       COUNT(cs.id) AS case_study_count
                FROM displays d
                LEFT JOIN case_studies cs ON cs.display_id = d.id
                WHERE d.branch_id = ?
                GROUP BY d.id ORDER BY d.id
                """,
                (branch_id,),
            ).fetchall()
        else:
            rows = db.execute(
                """
                SELECT d.id, d.branch_id, d.name,
                       COUNT(cs.id) AS case_study_count
                FROM displays d
                LEFT JOIN case_studies cs ON cs.display_id = d.id
                GROUP BY d.id ORDER BY d.id
                """
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list displays: {str(e)}")


@router.get("/{display_id}")
def get_display(
    display_id: int,
    admin: bool = Query(default=False),
    db: sqlite3.Connection = Depends(db_dependency),
    _viewer: None = Depends(get_display_viewer),
):
    """Display-viewer endpoint — returns display with nested case studies. Public unless
    DISPLAY_AUTH_ENABLED, in which case it requires an admin session or a paired device cookie
    (get_display_viewer). Without ?admin=true only published case studies are returned."""
    try:
        disp = db.execute(
            "SELECT id, branch_id, name FROM displays WHERE id = ?", (display_id,)
        ).fetchone()
        if not disp:
            raise HTTPException(status_code=404, detail="Display not found")

        status_filter = "" if admin else "AND is_published = 1"
        cs_rows = db.execute(
            f"""SELECT id, category, title, bullet_points, thumbnails, main_image, sort_order, is_published
                FROM case_studies WHERE display_id = ? {status_filter} ORDER BY sort_order, id""",
            (display_id,),
        ).fetchall()

        case_studies = []
        for cs in cs_rows:
            case_studies.append(
                {
                    "id": cs["id"],
                    "category": cs["category"],
                    "title": cs["title"],
                    "bulletPoints": json.loads(cs["bullet_points"]),
                    "thumbnails": json.loads(cs["thumbnails"]),
                    "mainImage": cs["main_image"],
                    "isPublished": cs["is_published"],
                }
            )

        return {
            "id": disp["id"],
            "branch_id": disp["branch_id"],
            "name": disp["name"],
            "pages": {"caseStudies": case_studies},
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get display: {str(e)}")


@router.post("", response_model=DisplayOut, status_code=201)
def create_display(
    body: DisplayCreate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Display name is required")

        branch = db.execute(
            "SELECT id FROM branches WHERE id = ?", (body.branch_id,)
        ).fetchone()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

        cursor = db.execute(
            "INSERT INTO displays (branch_id, name) VALUES (?, ?)",
            (body.branch_id, name),
        )
        db.commit()
        return {
            "id": cursor.lastrowid,
            "branch_id": body.branch_id,
            "name": name,
            "case_study_count": 0,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create display: {str(e)}")


@router.put("/{display_id}", response_model=DisplayOut)
def update_display(
    display_id: int,
    body: DisplayUpdate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Display name is required")

        disp = db.execute(
            "SELECT id, branch_id FROM displays WHERE id = ?", (display_id,)
        ).fetchone()
        if not disp:
            raise HTTPException(status_code=404, detail="Display not found")

        db.execute("UPDATE displays SET name = ? WHERE id = ?", (name, display_id))
        db.commit()

        cs_count = db.execute(
            "SELECT COUNT(*) AS cnt FROM case_studies WHERE display_id = ?",
            (display_id,),
        ).fetchone()["cnt"]

        return {
            "id": display_id,
            "branch_id": disp["branch_id"],
            "name": name,
            "case_study_count": cs_count,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update display: {str(e)}")


@router.delete("/{display_id}", status_code=204)
def delete_display(
    display_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        disp = db.execute(
            "SELECT id FROM displays WHERE id = ?", (display_id,)
        ).fetchone()
        if not disp:
            raise HTTPException(status_code=404, detail="Display not found")

        db.execute("DELETE FROM displays WHERE id = ?", (display_id,))
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete display: {str(e)}")
