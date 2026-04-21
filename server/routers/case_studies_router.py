import sqlite3
import json
from fastapi import APIRouter, Depends, HTTPException, Query
from ..database import db_dependency
from ..auth import get_current_user
from ..models import CaseStudyCreate, CaseStudyUpdate, CaseStudyOut

router = APIRouter()


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "display_id": row["display_id"],
        "category": row["category"],
        "title": row["title"],
        "bullet_points": json.loads(row["bullet_points"]),
        "thumbnails": json.loads(row["thumbnails"]),
        "main_image": row["main_image"],
        "sort_order": row["sort_order"],
        "is_published": row["is_published"],
    }


@router.get("", response_model=list[CaseStudyOut])
def list_case_studies(
    display_id: int = Query(None),
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        if display_id is not None:
            rows = db.execute(
                """SELECT id, display_id, category, title, bullet_points,
                          thumbnails, main_image, sort_order, is_published
                   FROM case_studies WHERE display_id = ? ORDER BY sort_order, id""",
                (display_id,),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT id, display_id, category, title, bullet_points,
                          thumbnails, main_image, sort_order, is_published
                   FROM case_studies ORDER BY sort_order, id"""
            ).fetchall()
        return [_row_to_dict(r) for r in rows]
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to list case studies: {str(e)}"
        )


@router.post("", response_model=CaseStudyOut, status_code=201)
def create_case_study(
    body: CaseStudyCreate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        title = body.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title is required")

        disp = db.execute(
            "SELECT id FROM displays WHERE id = ?", (body.display_id,)
        ).fetchone()
        if not disp:
            raise HTTPException(status_code=404, detail="Display not found")

        # Get next sort_order
        max_order = db.execute(
            "SELECT COALESCE(MAX(sort_order), -1) AS m FROM case_studies WHERE display_id = ?",
            (body.display_id,),
        ).fetchone()["m"]

        cursor = db.execute(
            """INSERT INTO case_studies (display_id, category, title, bullet_points, sort_order)
               VALUES (?, ?, ?, ?, ?)""",
            (
                body.display_id,
                body.category.strip(),
                title,
                json.dumps(body.bullet_points),
                max_order + 1,
            ),
        )
        db.commit()

        row = db.execute(
            """SELECT id, display_id, category, title, bullet_points,
                      thumbnails, main_image, sort_order, is_published
               FROM case_studies WHERE id = ?""",
            (cursor.lastrowid,),
        ).fetchone()
        return _row_to_dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to create case study: {str(e)}"
        )


@router.put("/{cs_id}", response_model=CaseStudyOut)
def update_case_study(
    cs_id: int,
    body: CaseStudyUpdate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        existing = db.execute(
            "SELECT id FROM case_studies WHERE id = ?", (cs_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Case study not found")

        updates = []
        params = []
        if body.category is not None:
            updates.append("category = ?")
            params.append(body.category.strip())
        if body.title is not None:
            title = body.title.strip()
            if not title:
                raise HTTPException(status_code=400, detail="Title cannot be empty")
            updates.append("title = ?")
            params.append(title)
        if body.bullet_points is not None:
            updates.append("bullet_points = ?")
            params.append(json.dumps(body.bullet_points))

        if updates:
            params.append(cs_id)
            db.execute(
                f"UPDATE case_studies SET {', '.join(updates)} WHERE id = ?", params
            )
            db.commit()

        row = db.execute(
            """SELECT id, display_id, category, title, bullet_points,
                      thumbnails, main_image, sort_order, is_published
               FROM case_studies WHERE id = ?""",
            (cs_id,),
        ).fetchone()
        return _row_to_dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to update case study: {str(e)}"
        )


@router.post("/{cs_id}/publish")
def publish_case_study(
    cs_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    existing = db.execute("SELECT id FROM case_studies WHERE id = ?", (cs_id,)).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Case study not found")
    db.execute("UPDATE case_studies SET is_published = 1 WHERE id = ?", (cs_id,))
    db.commit()
    return {"status": "ok", "is_published": 1}


@router.post("/{cs_id}/unpublish")
def unpublish_case_study(
    cs_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    existing = db.execute("SELECT id FROM case_studies WHERE id = ?", (cs_id,)).fetchone()
    if not existing:
        raise HTTPException(status_code=404, detail="Case study not found")
    db.execute("UPDATE case_studies SET is_published = 0 WHERE id = ?", (cs_id,))
    db.commit()
    return {"status": "ok", "is_published": 0}


@router.delete("/{cs_id}", status_code=204)
def delete_case_study(
    cs_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        existing = db.execute(
            "SELECT id FROM case_studies WHERE id = ?", (cs_id,)
        ).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Case study not found")

        db.execute("DELETE FROM case_studies WHERE id = ?", (cs_id,))
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to delete case study: {str(e)}"
        )
