from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from .database import init_db, get_db
from .auth import hash_password
from .config import settings
from .routers import auth_router, branches_router, displays_router, case_studies_router, uploads_router, ambient_router
import json


def seed_db():
    """Insert initial data if users table is empty."""
    db = get_db()
    user_count = db.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]
    if user_count == 0:
        # Create default admin user
        db.execute(
            "INSERT INTO users (email, password_hash) VALUES (?, ?)",
            ("admin@actis.com", hash_password("admin123")),
        )

        # Seed branches
        db.execute("INSERT INTO branches (name) VALUES (?)", ("Actis HQ",))
        db.execute("INSERT INTO branches (name) VALUES (?)", ("Actis Dubai",))

        # Seed displays
        db.execute(
            "INSERT INTO displays (branch_id, name) VALUES (?, ?)",
            (1, "Main Lobby Display"),
        )
        db.execute(
            "INSERT INTO displays (branch_id, name) VALUES (?, ?)",
            (1, "Conference Room A"),
        )
        db.execute(
            "INSERT INTO displays (branch_id, name) VALUES (?, ?)",
            (2, "Reception Display"),
        )

        # Seed case studies
        db.execute(
            """INSERT INTO case_studies (display_id, category, title, bullet_points, sort_order)
               VALUES (?, ?, ?, ?, ?)""",
            (
                1,
                "Corporate",
                "Digital Transformation for Enterprise",
                json.dumps(
                    [
                        "Reduced operational costs by 40%",
                        "Implemented cloud-first infrastructure",
                        "Achieved 99.9% uptime SLA",
                    ]
                ),
                0,
            ),
        )
        db.execute(
            """INSERT INTO case_studies (display_id, category, title, bullet_points, sort_order)
               VALUES (?, ?, ?, ?, ?)""",
            (
                1,
                "Healthcare",
                "Smart Hospital Management System",
                json.dumps(
                    [
                        "Streamlined patient intake process",
                        "Real-time bed management dashboard",
                        "Integrated with existing EMR systems",
                    ]
                ),
                1,
            ),
        )
        db.execute(
            """INSERT INTO case_studies (display_id, category, title, bullet_points, sort_order)
               VALUES (?, ?, ?, ?, ?)""",
            (
                3,
                "Retail",
                "Omnichannel Retail Experience",
                json.dumps(
                    [
                        "Unified online and offline customer journey",
                        "AI-powered inventory management",
                        "Increased customer retention by 35%",
                    ]
                ),
                0,
            ),
        )

        db.commit()
    db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    Path(settings.UPLOAD_DIR).mkdir(exist_ok=True)
    seed_db()
    yield


app = FastAPI(title="Actis Digital Signage API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded images
app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

app.include_router(auth_router.router, prefix="/api/auth", tags=["auth"])
app.include_router(branches_router.router, prefix="/api/branches", tags=["branches"])
app.include_router(displays_router.router, prefix="/api/displays", tags=["displays"])
app.include_router(
    case_studies_router.router, prefix="/api/case-studies", tags=["case-studies"]
)
app.include_router(uploads_router.router, prefix="/api/uploads", tags=["uploads"])
app.include_router(ambient_router.router, prefix="/api/ambient", tags=["ambient"])
