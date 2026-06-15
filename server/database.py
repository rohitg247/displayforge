import sqlite3
from pathlib import Path
from .config import settings


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def db_dependency():
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    # schema.sql uses CREATE TABLE IF NOT EXISTS — safe to run on an existing production
    # database. It will never drop or overwrite data. To make schema changes, use
    # migrate.py from the project root (local dev only). For production schema changes,
    # run ALTER TABLE statements manually against the /data/signage.db volume.
    conn = get_db()
    schema_path = Path(__file__).parent / "schema.sql"
    conn.executescript(schema_path.read_text())

    # Idempotent column adds for existing production databases (schema.sql's CREATE TABLE
    # IF NOT EXISTS never alters an existing table). Safe to run on every startup.
    for stmt in (
        "ALTER TABLE ambient_media ADD COLUMN poster_path TEXT DEFAULT NULL",
        "ALTER TABLE ambient_media ADD COLUMN duration INTEGER DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN playlist_video_path TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN playlist_video_sig TEXT DEFAULT NULL",
    ):
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass  # column already exists

    conn.commit()
    conn.close()
