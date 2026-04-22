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
    MAX_IMAGE_SIZE: int = 5 * 1024 * 1024  # 5MB
    ALLOWED_IMAGE_TYPES: set = {"image/jpeg", "image/png", "image/webp"}
    ALLOWED_MEDIA_TYPES: set = {"image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"}
    MAX_VIDEO_SIZE: int = 50 * 1024 * 1024  # 50MB


settings = Settings()
