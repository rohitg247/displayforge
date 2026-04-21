import sqlite3
import json
from fastapi import APIRouter, Depends, HTTPException
from ..database import db_dependency
from ..auth import get_current_user
from ..models import BranchCreate, BranchUpdate, BranchOut

router = APIRouter()


@router.get("", response_model=list[BranchOut])
def list_branches(
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        rows = db.execute(
            """
            SELECT b.id, b.name,
                   COUNT(d.id) AS display_count
            FROM branches b
            LEFT JOIN displays d ON d.branch_id = b.id
            GROUP BY b.id
            ORDER BY b.id
            """
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list branches: {str(e)}")


@router.get("/tree")
def branches_tree(
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    """Returns full nested data: branches -> displays -> caseStudies"""
    try:
        branches = db.execute(
            "SELECT id, name FROM branches ORDER BY id"
        ).fetchall()

        result = []
        for branch in branches:
            displays_rows = db.execute(
                "SELECT id, name FROM displays WHERE branch_id = ? ORDER BY id",
                (branch["id"],),
            ).fetchall()

            displays = []
            for disp in displays_rows:
                cs_rows = db.execute(
                    """SELECT id, category, title, bullet_points, thumbnails, main_image, sort_order, is_published
                       FROM case_studies WHERE display_id = ? ORDER BY sort_order, id""",
                    (disp["id"],),
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

                displays.append(
                    {
                        "id": disp["id"],
                        "name": disp["name"],
                        "pages": {"caseStudies": case_studies},
                    }
                )

            result.append(
                {
                    "id": branch["id"],
                    "name": branch["name"],
                    "displays": displays,
                }
            )

        return result
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to build branches tree: {str(e)}"
        )


@router.post("", response_model=BranchOut, status_code=201)
def create_branch(
    body: BranchCreate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Branch name is required")

        existing = db.execute(
            "SELECT id FROM branches WHERE LOWER(name) = LOWER(?)", (name,)
        ).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Branch name already exists")

        cursor = db.execute("INSERT INTO branches (name) VALUES (?)", (name,))
        db.commit()
        return {"id": cursor.lastrowid, "name": name, "display_count": 0}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create branch: {str(e)}")


@router.put("/{branch_id}", response_model=BranchOut)
def update_branch(
    branch_id: int,
    body: BranchUpdate,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Branch name is required")

        branch = db.execute(
            "SELECT id FROM branches WHERE id = ?", (branch_id,)
        ).fetchone()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

        duplicate = db.execute(
            "SELECT id FROM branches WHERE LOWER(name) = LOWER(?) AND id != ?",
            (name, branch_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=400, detail="Branch name already exists")

        db.execute("UPDATE branches SET name = ? WHERE id = ?", (name, branch_id))
        db.commit()

        display_count = db.execute(
            "SELECT COUNT(*) AS cnt FROM displays WHERE branch_id = ?", (branch_id,)
        ).fetchone()["cnt"]

        return {"id": branch_id, "name": name, "display_count": display_count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update branch: {str(e)}")


@router.delete("/{branch_id}", status_code=204)
def delete_branch(
    branch_id: int,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    try:
        branch = db.execute(
            "SELECT id FROM branches WHERE id = ?", (branch_id,)
        ).fetchone()
        if not branch:
            raise HTTPException(status_code=404, detail="Branch not found")

        display_count = db.execute(
            "SELECT COUNT(*) AS cnt FROM displays WHERE branch_id = ?", (branch_id,)
        ).fetchone()["cnt"]
        if display_count > 0:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete branch with active displays",
            )

        db.execute("DELETE FROM branches WHERE id = ?", (branch_id,))
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete branch: {str(e)}")
