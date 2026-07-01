import sqlite3
from pathlib import Path
from .config import settings


def get_db() -> sqlite3.Connection:
    # check_same_thread=False: FastAPI dispatches a sync `yield` dependency's setup and teardown as two
    # separate threadpool calls, which can land on different OS threads — sqlite3's default same-thread
    # check then raises mid-request. Safe here because each request gets its own private connection
    # (opened and closed within db_dependency below), never shared across requests/threads concurrently.
    conn = sqlite3.connect(settings.DATABASE_PATH, check_same_thread=False)
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

    # Display-URL device auth (Part D): one row per authorized display device. `jti` is the device
    # JWT's id; revocation is enforced server-side by looking `jti` up here on every viewer request.
    # Already scoped per branch + display; a future client_id/tenant_id column extends it to multi-tenant.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS display_devices (
               id           INTEGER PRIMARY KEY AUTOINCREMENT,
               jti          TEXT NOT NULL UNIQUE,
               branch_id    INTEGER,
               display_type INTEGER,
               display_id   INTEGER,
               label        TEXT,
               created_at   TEXT NOT NULL DEFAULT (datetime('now')),
               last_seen_at TEXT,
               revoked      INTEGER NOT NULL DEFAULT 0
           )"""
    )

    # Idempotent column adds for existing production databases (schema.sql's CREATE TABLE
    # IF NOT EXISTS never alters an existing table). Safe to run on every startup.
    for stmt in (
        "ALTER TABLE ambient_media ADD COLUMN poster_path TEXT DEFAULT NULL",
        "ALTER TABLE ambient_media ADD COLUMN duration INTEGER DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN playlist_video_path TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN playlist_video_sig TEXT DEFAULT NULL",
        # Draft-staging publish workflow: working copies of display config + media order/removal.
        "ALTER TABLE ambient_displays ADD COLUMN draft_orientation TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_label TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_name TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_title TEXT DEFAULT NULL",
        "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_enabled INTEGER DEFAULT NULL",
        "ALTER TABLE ambient_media ADD COLUMN live_sort_order INTEGER DEFAULT NULL",
        "ALTER TABLE ambient_media ADD COLUMN draft_removed INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE ambient_media ADD COLUMN thumb_path TEXT DEFAULT NULL",
    ):
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass  # column already exists

    # Seed the new draft/published columns so existing displays behave exactly as before until edited:
    #   draft_* := current live values (admin/preview shows the live config until a draft edit is made)
    #   live_sort_order := sort_order for already-live media (so the published order is unchanged)
    conn.execute(
        """UPDATE ambient_displays SET
               draft_orientation          = COALESCE(draft_orientation, orientation),
               draft_announcement_label   = COALESCE(draft_announcement_label, announcement_label),
               draft_announcement_name    = COALESCE(draft_announcement_name, announcement_name),
               draft_announcement_title   = COALESCE(draft_announcement_title, announcement_title),
               draft_announcement_enabled = COALESCE(draft_announcement_enabled, announcement_enabled)"""
    )
    conn.execute(
        "UPDATE ambient_media SET live_sort_order = sort_order WHERE live_sort_order IS NULL AND status = 'live'"
    )

    conn.commit()
    conn.close()
