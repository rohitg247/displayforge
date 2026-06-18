import sqlite3
from fastapi import APIRouter, Depends, HTTPException, Response
from ..database import db_dependency
from ..auth import verify_password, create_token
from ..config import settings
from ..models import LoginRequest, LoginResponse

router = APIRouter()


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, response: Response, db: sqlite3.Connection = Depends(db_dependency)):
    try:
        row = db.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?",
            (body.email,),
        ).fetchone()

        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        token = create_token(row["id"], row["email"])
        # Mirror the JWT into an httpOnly cookie so a preview popup (window.open) is authenticated
        # without the per-tab sessionStorage token. The token is also returned for the Bearer header.
        response.set_cookie(
            key=settings.AUTH_COOKIE_NAME,
            value=token,
            httponly=True,
            secure=settings.AUTH_COOKIE_SECURE,
            samesite=settings.AUTH_COOKIE_SAMESITE,
            max_age=settings.JWT_EXPIRE_MINUTES * 60,
            path="/",
        )
        return {"token": token, "user": {"id": row["id"], "email": row["email"]}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Login failed: {str(e)}")


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(key=settings.AUTH_COOKIE_NAME, path="/")
    return {"status": "ok"}
