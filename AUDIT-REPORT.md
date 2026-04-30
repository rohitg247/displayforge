# TECHNICAL AUDIT REPORT: Actis Digital Signage Platform

**Date**: Current analysis  
**Project**: `project/` (React + FastAPI digital signage CMS for Actis)  
**Scope**: Full structure/stack/architecture review (no fixes)

## 1. PROJECT STRUCTURE

### Full Folder/File Tree (recursive listing)
```
project/
├── .gitignore
├── bun.lockb
├── check_db.py, check_path.py, check_schema.py, migrate.py (DB utils)
├── components.json, eslint.config.js
├── index.html (Vite entry)
├── package(-lock).json (FE deps)
├── postcss.config.js, tailwind.config.js, vite.config.js, vitest.config.js
├── README.md (Lovable guide)
├── public/ (favicon, svg, robots.txt)
├── server/ (FastAPI backend)
│   ├── __init__.py, auth.py, config.py (dotenv, settings), database.py
│   ├── main.py (app entry + seed)
│   ├── models.py, schema.sql (SQLite DDL), requirements.txt
│   ├── db_queries.md, routers/ (6 APIRouters: auth/branches/etc.)
│   └── uploads/ (static media)
└── src/ (React app)
    ├── App.jsx/main.jsx/index.css (root)
    ├── assets/ (Actis logo/images)
    ├── components/admin/ (ActisButton/Card/etc.), layout/ (AdminLayout/Nav), ui/ (shadcn)
    ├── context/AppContext.jsx, hooks/, lib/utils.js (cn())
    ├── pages/ (~12 pages + duplicates like ' copy.jsx')
    ├── routes/ProtectedRoute.jsx
    ├── services/api.js (fetch client)
    └── test/ (vitest setup)
```

**Entry Points**:
- FE: `index.html` → `src/main.jsx` → `App.jsx` (Router/QueryClient)
- BE: `server/main.py` (FastAPI, lifespan: init_db/seed)

**Configs**: package.json, vite/tailwind/postcss, requirements.txt, schema.sql, server/config.py
**Unusual**: Duplicate pages (e.g., DisplayViewerPage copy.jsx), bun.lockb

**Size**: Medium (150 files)

## 2. TECH STACK

- **FE**: React 18.3, Vite 5.4 (port 8080), Tailwind 3.4 + shadcn/Radix, React Router 6
- **BE**: FastAPI 0.115, Uvicorn 0.30, SQLite (signage.db)
- **Data/State**: TanStack Query 5.83, React Context, Zod, React Hook Form
- **Auth**: JWT (HS256, 8h expiry), Argon2 hash
- **UI**: Framer Motion, Lucide, Sonner toast, Recharts
- **Test**: Vitest + RTL/Jest-DOM
- **Other**: clsx, tailwind-merge/animate

**No**: ORM (raw SQL), GraphQL/tRPC, Docker, TS (plain JS)

## 3. ARCHITECTURE & DATA FLOW

**Flow**:
1. FE Vite dev → localhost:8080
2. API calls (api.js) → BE localhost:8000 (VITE_API_URL)
3. BE: Routers → raw SQLite queries (no ORM)

**Routing**:
- FE: React Router (/admin/* protected, /branch/:id viewer)
- BE: /api/{auth,branches,displays,case-studies,uploads,ambient}

**Data**: REST CRUD, TanStack cache, FormData uploads (/uploads static)

**Env**: server/.env (SECRET_KEY etc.), auto-seed default admin@actis.com/admin123

## 4. KEY FEATURES

**Purpose**: Actis corporate digital signage CMS (displays case studies/media).

- Admin: CRUD Branches → Displays/Ambient → Case Studies (thumbnails/bullets)
- Viewers: /branch/:id (case studies), /ambient/:id (playlists A/B videos/images + announcements)
- Uploads: Images/videos (size limits 5-50MB)
- No roles/multi-tenant (single admin)

## 5. CODE QUALITY

- Consistent shadcn/Tailwind patterns
- **Dead**: Duplicate ' copy.jsx' files
- Hardcodes: SECRET_KEY='change-me...', admin pass 'admin123' (main.py seed)
- No TODOs visible
- Raw SQL (models.py), JS no TS

## 6. DEPENDENCIES

**FE Major** (package.json):
```
react/dom 18.3 • @tanstack/react-query 5.83 • react-router-dom 6.30
shadcn: Radix primitives 1.x, clsx 2.1, tailwind-merge 2.6
forms: react-hook-form 7.61, zod 3.25
UI: framer-motion 12.34, lucide-react 0.462, recharts 2.15
```
**BE** (requirements.txt):
```
fastapi 0.115 • uvicorn 0.30 • pydantic 2.x • PyJWT 2.9 • argon2-cffi 23.1
```

No outdated/security issues.

## 7. RED FLAGS

- **Security**: Exposed defaults/creds, no rate-limit/IP whitelist
- **Perf**: SQLite prod? Potential N+1 queries, heavy FE bundle
- **Broken/Incomplete**: Duplicates, commented api.js code, empty tests
- **Missing**: Error boundaries, types, prod hardening, migrations beyond migrate.py
- **Other**: JS-only (risky), no CI/CD/Docker

**Demo**: `cd project && npm run dev` (FE) + `cd server && venv activate && uvicorn main:app --reload --port 8000`

Audit complete – codebase unchanged.

---

## Fix: 5 Display Viewer Issues
**Date:** 27 April 2026
**Time:** 12:22

### Files Modified
| File | Change |
|------|--------|
| `src/pages/AmbientViewerPage.jsx` | Media src changed to relative URL, color band extracted to always-visible, announcement bar padding/fonts reduced, load-event-driven layer activation, preload="auto" added to video |
| `src/pages/DisplayViewerPage.jsx` | getImageUrl changed to relative URL, removed unused API_BASE |
| `src/services/api.js` | Fallback port corrected from 8000 to 8888 |
| `vite.config.js` | Added full preview block with port 3200, host, and proxy for /api and /uploads |
| `src/App.jsx` | Added position="top-right" to Sonner Toaster |

### Issues Resolved
1. Media not displaying on TV — relative URLs + vite proxy
2. Color band now always visible at full width bottom
3. Announcement bar height reduced
4. Toast position changed to top-right
5. Black screen flash on media loop eliminated via onCanPlay/onLoad activation

---

## Fix: 4 Follow-up Fixes
**Date:** 27 April 2026
**Time:** 13:24

### Files Modified
| File | Change |
|------|--------|
| `src/pages/AmbientViewerPage.jsx` | IMAGE_DURATION reduced from 8000ms to 5000ms |
| `src/pages/AmbientDisplaysPage.jsx` | `await fetchDisplays()` in handlePublishAndSetLive for instant "Live" badge update after publish; `await fetchMedia()` in handleUpload and handleDeleteMedia for instant media grid update |
| `vite.config.js` | Added proxy for `/api` and `/uploads` to `server` block (local dev) targeting `process.env.VITE_API_URL \|\| 'http://localhost:8000'` |

### Issues Resolved
1. Image display duration reduced from 8s to 5s
2. Publish now reflects instantly in admin panel (no manual refresh needed)
3. Uploaded and deleted media now appear/disappear instantly in the media grid
4. View and Preview links now work in local development via Vite dev server proxy

---

## Phase 1: Production Database Persistence & Backup
**Date:** 27 April 2026
**Time:** 16:15

### Files Modified
| File | Change |
|------|--------|
| `.dockerignore` | Created — excludes `server/signage.db`, `server/uploads/`, `node_modules/`, `dist/`, `.env`, `venv/`, `__pycache__/`, `*.pyc`, `.git/`, `.claude/` from Docker build context |
| `server/main.py` | Added `import shutil`; added `backup_db()` function; updated `lifespan` to call `backup_db()` before `init_db()` |
| `server/database.py` | Added comment to `init_db()` documenting schema safety and migrate.py usage policy |

### Issues Resolved
1. Database and uploads directory can no longer be baked into the Docker image — `.dockerignore` prevents `COPY server/ server/` from including them
2. Container startup now rotates backups: `signage.db → .bak1 → .bak2` (max 2 backups kept on the `/data` volume)
3. `init_db()` confirmed safe for production — `CREATE TABLE IF NOT EXISTS` only, no DROP TABLE; schema change policy documented in code


---

## Phase 2: URL Redesign + AmbientViewer Stabilisation
**Date:** 29 April 2026
**Time:** Session 4

### Files Modified
| File | Change |
|------|--------|
| `src/App.jsx` | Replaced `/branch/:id` and `/ambient/:id` routes with `/:branchId/1/:id` (DisplayViewerPage) and `/:branchId/2/:id` (AmbientViewerPage) |
| `src/pages/AmbientDisplaysPage.jsx` | Preview and View `window.open` calls updated to new URL format using `display.branch_id` |
| `src/pages/CaseStudyEditorPage.jsx` | Derived `branchId` from `state.branches`; Preview `window.open` updated to new URL format |
| `src/pages/AmbientViewerPage.jsx` | Full rewrite: state-machine playback engine, `layerSeq` forced remount, video instant-cut, orientation-aware color bar, all race conditions fixed |
| `src/pages/AmbientViewerPage_New_Ver.jsx` | Deleted (merged into AmbientViewerPage.jsx) |

### Issues Resolved
1. Viewer URLs now encode branch and display-type: `/:branchId/:displayType/:displayId`
2. ID stability confirmed — SQLite AUTOINCREMENT guarantees IDs never reused after deletion
3. Even-item playlist loop reset stall fixed — `layerSeq` key forces DOM remount so `onCanPlay`/`onLoad` always fires
4. Media skipping fixed — `transitionStateRef` gate prevents `handleVideoEnd` firing during ongoing transition
5. Video transitions are now instant cuts (no opacity fade); image-to-image crossfade retained at 500ms
6. Initial load bug fixed — `expectedLayerRef` allows layer 0's `onCanPlay` to be accepted during init
7. Stale closure bug fixed — all playback callbacks use `activeLayerRef` + stable `[]` deps
8. Color bar height is now orientation-aware: portrait `clamp(8px, 1.35vh, 15px)`, landscape `clamp(10px, 1.8vh, 20px)`
