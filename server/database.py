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
    conn.commit()
    conn.close()
