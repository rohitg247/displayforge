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

conn.commit()
conn.close()
print('Done.')
