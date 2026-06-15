CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    NOT NULL UNIQUE,
    password_hash TEXT  NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS displays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS case_studies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    display_id    INTEGER NOT NULL REFERENCES displays(id) ON DELETE CASCADE,
    category      TEXT    NOT NULL DEFAULT '',
    title         TEXT    NOT NULL,
    bullet_points TEXT    NOT NULL DEFAULT '[]',
    thumbnails    TEXT    NOT NULL DEFAULT '[]',
    main_image    TEXT    DEFAULT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_published  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ambient_displays (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id             INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL,
    orientation           TEXT    NOT NULL DEFAULT 'landscape',
    active_playlist       TEXT    NOT NULL DEFAULT 'A',
    announcement_label    TEXT    DEFAULT 'Actis welcomes',
    announcement_name     TEXT    DEFAULT '',
    announcement_title    TEXT    DEFAULT '',
    announcement_enabled  INTEGER NOT NULL DEFAULT 0,
    playlist_video_path   TEXT    DEFAULT NULL,
    playlist_video_sig    TEXT    DEFAULT NULL,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ambient_media (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ambient_display_id  INTEGER NOT NULL REFERENCES ambient_displays(id) ON DELETE CASCADE,
    file_path           TEXT    NOT NULL,
    media_type          TEXT    NOT NULL,
    playlist            TEXT    NOT NULL DEFAULT 'A',
    sort_order          INTEGER NOT NULL DEFAULT 0,
    status              TEXT    NOT NULL DEFAULT 'draft',
    poster_path         TEXT    DEFAULT NULL,
    duration            INTEGER DEFAULT NULL,   -- per-image on-screen seconds (NULL = default); ignored for video
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

