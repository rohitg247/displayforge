# SQLite Database Inspector - signage.db

> Run all commands from `project/server/` directory with venv activated.
> All queries use Python scripts to avoid PowerShell quote escaping issues.

---

## 1. List All Tables

```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); print([r[0] for r in c.execute('SELECT name FROM sqlite_master WHERE type=''table''').fetchall()]); c.close()"
```
**Expected**: `['users', 'branches', 'displays', 'case_studies']`

---

## 2. View Data Per Table

### Users
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.row_factory=sqlite3.Row; [print(dict(r)) for r in c.execute('SELECT id, email, created_at FROM users').fetchall()]; c.close()"
```
**Expected**: `{'id': 1, 'email': 'admin@actis.com', 'created_at': '2026-03-08 ...'}`

### Branches
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.row_factory=sqlite3.Row; [print(dict(r)) for r in c.execute('SELECT * FROM branches').fetchall()]; c.close()"
```
**Expected**: `{'id': 1, 'name': 'Actis HQ', 'created_at': '...'}`

### Displays
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.row_factory=sqlite3.Row; [print(dict(r)) for r in c.execute('SELECT * FROM displays').fetchall()]; c.close()"
```
**Expected**: `{'id': 1, 'branch_id': 1, 'name': 'Main Lobby Display', 'created_at': '...'}`

### Case Studies
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.row_factory=sqlite3.Row; [print(dict(r)) for r in c.execute('SELECT id, display_id, category, title, sort_order FROM case_studies').fetchall()]; c.close()"
```
**Expected**: `{'id': 1, 'display_id': 1, 'category': 'Corporate', 'title': 'Digital Transformation for Enterprise', 'sort_order': 0}`

---

## 3. CRUD Commands

### INSERT

**Add user**:
```powershell
python -c "import sqlite3; from argon2 import PasswordHasher; c=sqlite3.connect('signage.db'); c.execute('INSERT INTO users (email, password_hash) VALUES (?, ?)', ('user@actis.com', PasswordHasher().hash('password123'))); c.commit(); print('User added'); c.close()"
```

**Add branch**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('INSERT INTO branches (name) VALUES (?)', ('Actis Mumbai',)); c.commit(); print('Branch added'); c.close()"
```

**Add display**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('INSERT INTO displays (branch_id, name) VALUES (?, ?)', (1, 'Lobby Screen 2')); c.commit(); print('Display added'); c.close()"
```

**Add case study**:
```powershell
python -c "import sqlite3, json; c=sqlite3.connect('signage.db'); c.execute('INSERT INTO case_studies (display_id, category, title, bullet_points, sort_order) VALUES (?, ?, ?, ?, ?)', (1, 'Finance', 'Banking Platform', json.dumps(['Point 1', 'Point 2']), 0)); c.commit(); print('Case study added'); c.close()"
```

### UPDATE

**Rename branch**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('UPDATE branches SET name=? WHERE id=?', ('Actis Pune', 1)); c.commit(); print('Updated', c.total_changes, 'row(s)'); c.close()"
```

**Update case study title**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('UPDATE case_studies SET title=? WHERE id=?', ('New Title Here', 1)); c.commit(); print('Updated', c.total_changes, 'row(s)'); c.close()"
```

### DELETE

**Delete case study by id**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('DELETE FROM case_studies WHERE id=?', (1,)); c.commit(); print('Deleted', c.total_changes, 'row(s)'); c.close()"
```

**Delete display by id** (cascades to its case studies):
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('PRAGMA foreign_keys=ON'); c.execute('DELETE FROM displays WHERE id=?', (1,)); c.commit(); print('Deleted'); c.close()"
```

**Delete branch by id** (cascades to displays and case studies):
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('PRAGMA foreign_keys=ON'); c.execute('DELETE FROM branches WHERE id=?', (1,)); c.commit(); print('Deleted'); c.close()"
```

---

## 4. Foreign Key Checks (Joins)

**Branches with display count**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); [print(r) for r in c.execute('SELECT b.id, b.name, COUNT(d.id) AS displays FROM branches b LEFT JOIN displays d ON d.branch_id=b.id GROUP BY b.id').fetchall()]; c.close()"
```
**Expected**: `(1, 'Actis HQ', 2)`

**Full tree: branch -> display -> case study count**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); [print(r) for r in c.execute('SELECT b.name, d.name, COUNT(cs.id) FROM branches b LEFT JOIN displays d ON d.branch_id=b.id LEFT JOIN case_studies cs ON cs.display_id=d.id GROUP BY d.id ORDER BY b.id, d.id').fetchall()]; c.close()"
```
**Expected**: `('Actis HQ', 'Main Lobby Display', 2)`, `('Actis HQ', 'Conference Room A', 0)`, `('Actis Dubai', 'Reception Display', 1)`

**Orphan check (displays without valid branch)**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); r=c.execute('SELECT d.* FROM displays d LEFT JOIN branches b ON b.id=d.branch_id WHERE b.id IS NULL').fetchall(); print('Orphans:', len(r)); c.close()"
```
**Expected**: `Orphans: 0`

---

## 5. JSON Column Preview

**View bullet_points**:
```powershell
python -c "import sqlite3, json; c=sqlite3.connect('signage.db'); [print('CS #' + str(r[0]) + ':', json.loads(r[1])) for r in c.execute('SELECT id, bullet_points FROM case_studies').fetchall()]; c.close()"
```
**Expected**: `CS #1: ['Reduced operational costs by 40%', 'Implemented cloud-first infrastructure', 'Achieved 99.9% uptime SLA']`

**View thumbnails**:
```powershell
python -c "import sqlite3, json; c=sqlite3.connect('signage.db'); [print('CS #' + str(r[0]) + ':', json.loads(r[1])) for r in c.execute('SELECT id, thumbnails FROM case_studies').fetchall()]; c.close()"
```
**Expected**: `CS #1: []` (empty until images are uploaded)

**Count bullet points per case study**:
```powershell
python -c "import sqlite3, json; c=sqlite3.connect('signage.db'); [print('CS #' + str(r[0]) + ' (' + r[1] + '):', len(json.loads(r[2])), 'bullets') for r in c.execute('SELECT id, title, bullet_points FROM case_studies').fetchall()]; c.close()"
```

---

## 6. Clean DB (DELETE ALL Data)

**Delete all case studies**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('DELETE FROM case_studies'); c.commit(); print('All case studies deleted'); c.close()"
```

**Delete all displays** (cascades case studies):
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('PRAGMA foreign_keys=ON'); c.execute('DELETE FROM displays'); c.commit(); print('All displays deleted'); c.close()"
```

**Delete all branches** (cascades displays and case studies):
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('PRAGMA foreign_keys=ON'); c.execute('DELETE FROM branches'); c.commit(); print('All branches deleted'); c.close()"
```

**Full reset (drop all data, keep tables)**:
```powershell
python -c "import sqlite3; c=sqlite3.connect('signage.db'); c.execute('PRAGMA foreign_keys=ON'); [c.execute('DELETE FROM ' + t) for t in ['case_studies','displays','branches','users']]; c.commit(); print('All data deleted'); c.close()"
```

**Nuclear reset (delete DB file, re-seed on next server start)**:
```powershell
del signage.db
```
> Restart the server to recreate with seed data.
