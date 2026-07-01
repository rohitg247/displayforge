import sqlite3
import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from .config import settings
from .database import db_dependency

ph = PasswordHasher()
# auto_error=False: a missing Authorization header is NOT an instant 401 — we then fall back to the
# httpOnly session cookie (set on login), so a preview popup tab is authenticated without the token.
security = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return ph.verify(hashed, password)
    except VerifyMismatchError:
        return False


def create_token(user_id: int, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc)
        + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def get_current_user(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    # Prefer the Bearer header (existing behaviour); fall back to the httpOnly session cookie so a
    # same-origin preview popup (no per-tab token) is still authenticated.
    token = credentials.credentials if credentials else request.cookies.get(settings.AUTH_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(token)
    # A device token is NOT an admin session — never let it satisfy admin-only endpoints.
    if payload.get("typ") == "device":
        raise HTTPException(status_code=401, detail="Not authenticated")
    return payload


# --------------------------------------------------------------------------------------------------
# Display-URL device auth (Part D). A kiosk display authenticates ONCE (QR pairing or password) and
# gets a long-lived, httpOnly `actis_device` cookie. Revocation is enforced server-side by looking the
# token's `jti` up in `display_devices` on EVERY viewer request (the JWT signature alone is not trusted).
# --------------------------------------------------------------------------------------------------

def create_device_token(jti: str, branch_id, display_type, display_id) -> str:
    payload = {
        "typ": "device",
        "jti": jti,
        "branch_id": branch_id,
        "display_type": display_type,
        "display_id": display_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=settings.DEVICE_JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def _has_valid_admin(request: Request, credentials) -> bool:
    """True if a valid ADMIN session is present (Bearer header or admin session cookie)."""
    token = credentials.credentials if credentials else request.cookies.get(settings.AUTH_COOKIE_NAME)
    if not token:
        return False
    try:
        payload = decode_token(token)
    except HTTPException:
        return False
    return payload.get("typ") != "device"


def get_display_viewer(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: sqlite3.Connection = Depends(db_dependency),
) -> None:
    """Authorize a LIVE display-viewer read.

    No-op (public — current behaviour) unless ``DISPLAY_AUTH_ENABLED``. When enabled, allow EITHER an
    admin session OR a valid, **non-revoked** device cookie; revocation is enforced by a `jti` lookup in
    `display_devices` on every call. Raises 401 otherwise (the viewer then shows the display login)."""
    if not settings.DISPLAY_AUTH_ENABLED:
        return
    if _has_valid_admin(request, credentials):
        return
    token = request.cookies.get(settings.DEVICE_COOKIE_NAME)
    if token:
        try:
            payload = decode_token(token)
        except HTTPException:
            payload = None
        if payload and payload.get("typ") == "device":
            row = db.execute(
                "SELECT id, revoked FROM display_devices WHERE jti = ?", (payload.get("jti"),)
            ).fetchone()
            if row and not row["revoked"]:
                db.execute(
                    "UPDATE display_devices SET last_seen_at = datetime('now') WHERE id = ?", (row["id"],)
                )
                db.commit()
                return
    raise HTTPException(status_code=401, detail="Display not paired")
