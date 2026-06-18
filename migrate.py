import sqlite3

conn = sqlite3.connect('server/signage.db')
cur = conn.cursor()

migrations = [
    "ALTER TABLE ambient_displays ADD COLUMN active_playlist TEXT NOT NULL DEFAULT 'A'",
    "ALTER TABLE ambient_displays ADD COLUMN announcement_label TEXT DEFAULT 'Actis welcomes'",
    "ALTER TABLE ambient_displays ADD COLUMN announcement_name TEXT DEFAULT ''",
    "ALTER TABLE ambient_displays ADD COLUMN announcement_title TEXT DEFAULT ''",
    "ALTER TABLE ambient_displays ADD COLUMN announcement_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE ambient_media ADD COLUMN playlist TEXT NOT NULL DEFAULT 'A'",
    "ALTER TABLE ambient_media ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
    "ALTER TABLE ambient_media ADD COLUMN poster_path TEXT DEFAULT NULL",
    "ALTER TABLE ambient_media ADD COLUMN duration INTEGER DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN playlist_video_path TEXT DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN playlist_video_sig TEXT DEFAULT NULL",
    "ALTER TABLE case_studies ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0",
    # Draft-staging publish workflow
    "ALTER TABLE ambient_displays ADD COLUMN draft_orientation TEXT DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_label TEXT DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_name TEXT DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_title TEXT DEFAULT NULL",
    "ALTER TABLE ambient_displays ADD COLUMN draft_announcement_enabled INTEGER DEFAULT NULL",
    "ALTER TABLE ambient_media ADD COLUMN live_sort_order INTEGER DEFAULT NULL",
    "ALTER TABLE ambient_media ADD COLUMN draft_removed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE ambient_media ADD COLUMN thumb_path TEXT DEFAULT NULL",
]

for sql in migrations:
    try:
        cur.execute(sql)
        print('OK:', sql[:60])
    except Exception as e:
        print('SKIP:', e)

# One-time: mark all existing media as live so nothing breaks
cur.execute("UPDATE ambient_media SET status = 'live'")
print(f'Marked {cur.rowcount} existing media rows as live')

# Seed draft_* display columns = live values, and live_sort_order = sort_order for live media
cur.execute(
    """UPDATE ambient_displays SET
           draft_orientation          = COALESCE(draft_orientation, orientation),
           draft_announcement_label   = COALESCE(draft_announcement_label, announcement_label),
           draft_announcement_name    = COALESCE(draft_announcement_name, announcement_name),
           draft_announcement_title   = COALESCE(draft_announcement_title, announcement_title),
           draft_announcement_enabled = COALESCE(draft_announcement_enabled, announcement_enabled)"""
)
cur.execute("UPDATE ambient_media SET live_sort_order = sort_order WHERE live_sort_order IS NULL")
print('Seeded draft display columns and live_sort_order')

conn.commit()
conn.close()
print('Done.')
