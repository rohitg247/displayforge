# save as check_schema.py
import sqlite3
conn = sqlite3.connect('signage.db')
cur = conn.cursor()
cur.execute("PRAGMA table_info(ambient_displays)")
print("ambient_displays columns:")
for row in cur.fetchall():
    print(" ", row[1])
cur.execute("PRAGMA table_info(ambient_media)")
print("ambient_media columns:")
for row in cur.fetchall():
    print(" ", row[1])
conn.close()
