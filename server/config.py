from pathlib import Path
from dotenv import load_dotenv
import os

# Load .env from project root (one level above server/)
load_dotenv(Path(__file__).parent.parent / ".env")


class Settings:
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-me-in-production")
    DATABASE_PATH: str = os.getenv(
        "DATABASE_PATH", str(Path(__file__).parent / "signage.db")
    )
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", str(Path(__file__).parent / "uploads"))
    CORS_ORIGINS: list = os.getenv(
        "CORS_ORIGINS", "http://localhost:8080,http://localhost:5173"
    ).split(",")
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 480  # 8 hours
    # Auth session cookie: an httpOnly cookie mirrors the JWT so any same-origin tab (e.g. a preview
    # popup opened via window.open) is authenticated without the per-tab sessionStorage token. The
    # Bearer header still works (fallback for cross-origin dev). Set AUTH_COOKIE_SECURE=true in prod
    # (HTTPS); leave false for local http. SameSite=lax is fine since admin + preview are same-origin.
    AUTH_COOKIE_NAME: str = "actis_session"
    AUTH_COOKIE_SECURE: bool = os.getenv("AUTH_COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
    AUTH_COOKIE_SAMESITE: str = os.getenv("AUTH_COOKIE_SAMESITE", "lax")
    MAX_IMAGE_SIZE: int = 5 * 1024 * 1024  # 5MB
    ALLOWED_IMAGE_TYPES: set = {"image/jpeg", "image/png", "image/webp"}
    ALLOWED_MEDIA_TYPES: set = {"image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"}
    MAX_VIDEO_SIZE: int = 50 * 1024 * 1024  # 50MB
    # Seamless-loop concat: keep audio in the built loop file? OFF by default (the panel player is
    # muted, and dropping audio keeps every segment's stream layout uniform for a clean `-c copy`
    # join). Flip to "true" (env var) later to retain/normalise audio — the concat builder already
    # handles it (gives images a silent track and re-encodes only audio, never the video). No code
    # change needed to enable.
    AMBIENT_PLAYLIST_AUDIO: bool = os.getenv("AMBIENT_PLAYLIST_AUDIO", "false").lower() in ("1", "true", "yes")
    # Default on-screen seconds for an image segment when no per-item duration is set.
    AMBIENT_IMAGE_SECONDS: int = int(os.getenv("AMBIENT_IMAGE_SECONDS", "5"))

    # --- Image-safety contract (uploads) ----------------------------------------------------------
    # An uploaded image whose long/short side exceeds the Tizen FullHD ceiling (1920x1080, mirrored for
    # portrait) is auto-DOWNSCALED once at upload (Lanczos, aspect preserved, never upscaled) — one
    # high-quality resample beats letting the panel re-downsample every render, and it removes the
    # oversized-decode memory risk. See media_utils.normalize_image.
    # Aspect tolerance: how far an image's aspect ratio may deviate from the display's target
    # (16:9 landscape / 9:16 portrait) before it is flagged. 0.05 = 5%.
    AMBIENT_IMAGE_ASPECT_TOLERANCE: float = float(os.getenv("AMBIENT_IMAGE_ASPECT_TOLERANCE", "0.05"))
    # STRICT: hard-REJECT (HTTP 400) an off-aspect image instead of accepting it with a warning.
    # Default OFF (warn only) so uploads are never blocked unexpectedly.
    AMBIENT_IMAGE_STRICT: bool = os.getenv("AMBIENT_IMAGE_STRICT", "false").lower() in ("1", "true", "yes")

    # --- Display-URL device auth (Part D) ---------------------------------------------------------
    # Master switch for gating the public display URLs (/:branch/1/:id, /:branch/2/:id + debug-log)
    # behind a one-time, revocable device session. Default OFF so existing displays keep rendering
    # with no login until this is deliberately enabled and each display is paired.
    DISPLAY_AUTH_ENABLED: bool = os.getenv("DISPLAY_AUTH_ENABLED", "false").lower() in ("1", "true", "yes")
    # Persistent httpOnly cookie holding the display's device JWT (separate from the admin session).
    DEVICE_COOKIE_NAME: str = os.getenv("DEVICE_COOKIE_NAME", "actis_device")
    # Device sessions are kiosk-lived: a long JWT expiry (days) + server-side revocation via the
    # display_devices table (a revoked jti is rejected on every viewer request, so this is a backstop).
    DEVICE_JWT_EXPIRE_DAYS: int = int(os.getenv("DEVICE_JWT_EXPIRE_DAYS", "3650"))
    # QR pairing codes are short-lived + single-use.
    DEVICE_PAIR_CODE_TTL_SECONDS: int = int(os.getenv("DEVICE_PAIR_CODE_TTL_SECONDS", "600"))


settings = Settings()
