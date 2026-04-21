import sqlite3
from fastapi import APIRouter, Depends, HTTPException
from ..database import db_dependency
from ..auth import verify_password, create_token
from ..models import LoginRequest, LoginResponse

router = APIRouter()


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: sqlite3.Connection = Depends(db_dependency)):
    try:
        row = db.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?",
            (body.email,),
        ).fetchone()

        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        token = create_token(row["id"], row["email"])
        return {"token": token, "user": {"id": row["id"], "email": row["email"]}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Login failed: {str(e)}")
