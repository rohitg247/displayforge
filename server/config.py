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


settings = Settings()
