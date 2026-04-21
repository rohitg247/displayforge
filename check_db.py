import sqlite3
c = sqlite3.connect('server/signage.db')
tables = c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
for (table,) in tables:
    print(f"\n{'='*40}")
    print(f"TABLE: {table}")
    print('='*40)
    rows = c.execute(f"SELECT * FROM {table}").fetchall()
    if rows:
        for row in rows:
            print(row)
    else:
        print("(empty)")
