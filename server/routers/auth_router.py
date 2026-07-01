import secrets
import sqlite3
import time
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from ..database import db_dependency
from ..auth import verify_password, create_token, create_device_token, get_current_user
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


# ==================================================================================================
# Display-URL device auth (Part D). A kiosk display authenticates ONCE — via QR pairing (an admin
# approves it from a phone) or an email/password fallback — and receives a long-lived, revocable
# httpOnly `actis_device` cookie. Gated by DISPLAY_AUTH_ENABLED (see auth.get_display_viewer).
# ==================================================================================================

# In-memory pending pairings: code -> {created, token, branch_id, display_type, display_id, label}.
# Short-lived + single-use. NOTE: process-local — assumes a single API worker (this deployment runs one
# uvicorn worker). If scaled to multiple workers, move this to a `pair_codes` DB table.
_PENDING_PAIRS: dict = {}


def _purge_pairs() -> None:
    cutoff = time.time() - settings.DEVICE_PAIR_CODE_TTL_SECONDS
    for code in [c for c, v in _PENDING_PAIRS.items() if v["created"] < cutoff]:
        _PENDING_PAIRS.pop(code, None)


def _set_device_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.DEVICE_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=settings.AUTH_COOKIE_SECURE,      # keep OFF on a plain-http LAN or the TV won't send it
        samesite=settings.AUTH_COOKIE_SAMESITE,
        max_age=settings.DEVICE_JWT_EXPIRE_DAYS * 24 * 3600,
        path="/",
    )


def _create_device(db: sqlite3.Connection, branch_id, display_type, display_id, label) -> str:
    """Insert a display_devices row and return its device JWT (carrying the row's jti)."""
    jti = uuid.uuid4().hex
    db.execute(
        "INSERT INTO display_devices (jti, branch_id, display_type, display_id, label) VALUES (?, ?, ?, ?, ?)",
        (jti, branch_id, display_type, display_id, label),
    )
    db.commit()
    return create_device_token(jti, branch_id, display_type, display_id)


class DeviceLoginRequest(BaseModel):
    email: str
    password: str
    branch_id: Optional[int] = None
    display_type: Optional[int] = None
    display_id: Optional[int] = None
    label: Optional[str] = None


class PairStartRequest(BaseModel):
    branch_id: Optional[int] = None
    display_type: Optional[int] = None
    display_id: Optional[int] = None
    label: Optional[str] = None


class PairApproveRequest(BaseModel):
    code: str


@router.post("/device-login")
def device_login(body: DeviceLoginRequest, response: Response, db: sqlite3.Connection = Depends(db_dependency)):
    """Password fallback: authenticate a display with admin credentials → set the device cookie."""
    row = db.execute("SELECT id, password_hash FROM users WHERE email = ?", (body.email,)).fetchone()
    if not row or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = _create_device(db, body.branch_id, body.display_type, body.display_id, body.label)
    _set_device_cookie(response, token)
    return {"status": "ok"}


@router.post("/pair/start")
def pair_start(body: PairStartRequest):
    """Called by the DISPLAY. Returns a short-lived, single-use code; the display shows its QR
    (…/pair/<code>) and polls GET /pair/<code> until an admin approves it."""
    _purge_pairs()
    code = secrets.token_urlsafe(6)
    _PENDING_PAIRS[code] = {
        "created": time.time(),
        "token": None,
        "branch_id": body.branch_id,
        "display_type": body.display_type,
        "display_id": body.display_id,
        "label": body.label,
    }
    return {"code": code, "expires_in": settings.DEVICE_PAIR_CODE_TTL_SECONDS}


@router.post("/pair/approve")
def pair_approve(
    body: PairApproveRequest,
    db: sqlite3.Connection = Depends(db_dependency),
    user: dict = Depends(get_current_user),
):
    """Called by an AUTHENTICATED admin (e.g. from a phone that scanned the QR). Creates the device
    row for the pending code so the polling display can pick up its cookie."""
    _purge_pairs()
    pending = _PENDING_PAIRS.get(body.code)
    if pending is None:
        raise HTTPException(status_code=404, detail="Pairing code expired or invalid")
    if pending["token"] is None:
        pending["token"] = _create_device(
            db, pending["branch_id"], pending["display_type"], pending["display_id"], pending["label"]
        )
    return {"status": "approved"}


@router.get("/pair/{code}")
def pair_poll(code: str, response: Response):
    """Called by the DISPLAY on a poll. Once approved, sets the device cookie and consumes the code."""
    _purge_pairs()
    pending = _PENDING_PAIRS.get(code)
    if pending is None:
        return {"status": "expired"}
    if pending["token"]:
        _set_device_cookie(response, pending["token"])
        _PENDING_PAIRS.pop(code, None)  # single-use
        return {"status": "approved"}
    return {"status": "pending"}


@router.get("/devices")
def list_devices(db: sqlite3.Connection = Depends(db_dependency), user: dict = Depends(get_current_user)):
    """Admin: list authorized display devices (for the Devices management view)."""
    rows = db.execute(
        """SELECT id, branch_id, display_type, display_id, label, created_at, last_seen_at, revoked
           FROM display_devices ORDER BY revoked, id DESC"""
    ).fetchall()
    return {"devices": [dict(r) for r in rows]}


@router.post("/devices/{device_id}/revoke")
def revoke_device(device_id: int, db: sqlite3.Connection = Depends(db_dependency), user: dict = Depends(get_current_user)):
    """Admin: revoke a device — enforced on the next viewer request via the jti lookup."""
    db.execute("UPDATE display_devices SET revoked = 1 WHERE id = ?", (device_id,))
    db.commit()
    return {"status": "ok"}
