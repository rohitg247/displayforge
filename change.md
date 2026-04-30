# Change Log — Code Snippet Diffs

This file documents every code-level change made to the project, showing the exact before and after for each snippet. Updated after every edit session.

---

## Session 1 — 27 April 2026, 12:22
**Topic:** 5 Display Viewer Issues

---

### 1. `src/services/api.js` — Fix fallback URL port

**Before:**
```js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
```
**After:**
```js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8888';
```

---

### 2. `src/App.jsx` — Sonner toast position

**Before:**
```jsx
<Sonner />
```
**After:**
```jsx
<Sonner position="top-right" />
```

---

### 3. `vite.config.js` — Add full preview block (port + proxy)

**Before:**
```js
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  plugins: [...],
```
**After:**
```js
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  preview: {
    port: 3200,
    host: '::',
    proxy: {
      '/api':     { target: process.env.VITE_API_URL || 'http://localhost:8888', changeOrigin: true },
      '/uploads': { target: process.env.VITE_API_URL || 'http://localhost:8888', changeOrigin: true },
    },
  },
  plugins: [...],
```

---

### 4. `src/pages/DisplayViewerPage.jsx` — Media URLs: absolute → relative

**Before (line 16):**
```js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const aboutImages = [about1, about2, about3, about4];
```
**After:**
```js
const aboutImages = [about1, about2, about3, about4];
```

**Before (line 85, inside `getImageUrl`):**
```js
if (path.startsWith('/uploads/')) return `${API_BASE}${path}`;
```
**After:**
```js
if (path.startsWith('/uploads/')) return path;
```

---

### 5. `src/pages/AmbientViewerPage.jsx` — Five changes

#### 5a. Remove API_BASE, keep IMAGE_DURATION

**Before:**
```js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const IMAGE_DURATION = 8000;
```
**After:**
```js
const IMAGE_DURATION = 8000;
```

#### 5b. Add refs for load-event-driven layer activation

**Before:**
```js
const timerRef = useRef(null);
const initializedRef = useRef(false);
```
**After:**
```js
const timerRef = useRef(null);
const initializedRef = useRef(false);
const pendingActivateRef = useRef(null);
const loadFallbackRef = useRef(null);
```

#### 5c. Add handleLayerReady + armLayerActivation callbacks

**Before:** *(nothing — these were new additions after the fetchData definition)*

**After:**
```js
// Activate a layer only after its media has loaded; fallback after 2s for slow TV hardware
const handleLayerReady = useCallback((layerIdx) => {
  if (pendingActivateRef.current !== layerIdx) return;
  if (loadFallbackRef.current) { clearTimeout(loadFallbackRef.current); loadFallbackRef.current = null; }
  pendingActivateRef.current = null;
  setActiveLayer(layerIdx);
}, []);

const armLayerActivation = useCallback((layerIdx) => {
  if (loadFallbackRef.current) clearTimeout(loadFallbackRef.current);
  pendingActivateRef.current = layerIdx;
  loadFallbackRef.current = setTimeout(() => {
    if (pendingActivateRef.current === layerIdx) {
      pendingActivateRef.current = null;
      setActiveLayer(layerIdx);
    }
  }, 2000);
}, []);
```

#### 5d. Replace 50ms setTimeout with armLayerActivation (advance + applyPendingIfNeeded)

**Before (`applyPendingIfNeeded`):**
```js
// Small delay to let src load before fading
setTimeout(() => setActiveLayer(inactiveLayer), 50);
```
**After:**
```js
armLayerActivation(inactiveLayer);
```

**Before (`advance`):**
```js
// Small delay for preload, then fade
setTimeout(() => setActiveLayer(inactiveLayer), 50);
```
**After:**
```js
armLayerActivation(inactiveLayer);
```

#### 5e. renderLayer — relative src, onLoad/onCanPlay, preload="auto"

**Before:**
```js
const src = `${API_BASE}${item.file_path}`;
...
<video ref={videoRefs[layerIdx]} src={src} muted playsInline
  onEnded={isActive ? handleVideoEnd : undefined}
  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
...
<img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
```
**After:**
```js
const src = item.file_path; // relative — proxied through vite preview to backend
...
<video ref={videoRefs[layerIdx]} src={src} muted playsInline
  preload="auto"
  onCanPlay={() => handleLayerReady(layerIdx)}
  onEnded={isActive ? handleVideoEnd : undefined}
  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
...
<img src={src} alt="" onLoad={() => handleLayerReady(layerIdx)}
  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
```

#### 5f. Color band — extracted to always-visible full-width strip

**Before:** Color band was inside `{showAnnouncement && (...)}` conditional, 85% width, positioned at bottom of welcome box.

**After:** Color band moved outside conditional, `position: absolute, bottom: 0, left: 0, width: '100%'` — always visible regardless of announcement state. Announcement box repositioned to `bottom: 'clamp(5px, 0.9vh, 10px)'` to sit above the band.

#### 5g. Announcement bar — reduced padding and font sizes

**Before:**
```js
padding: 'clamp(12px, 2vh, 26px) 0'
fontSize: 'clamp(11px, 1.4vw, 18px)'  // label
fontSize: 'clamp(16px, 2.2vw, 30px)'  // name
fontSize: 'clamp(13px, 1.6vw, 22px)'  // title
```
**After:**
```js
padding: 'clamp(6px, 1vh, 14px) 0'
fontSize: 'clamp(9px, 1.1vw, 14px)'   // label
fontSize: 'clamp(13px, 1.8vw, 24px)'  // name
fontSize: 'clamp(11px, 1.3vw, 18px)'  // title
```

---

## Session 2 — 27 April 2026, 12:30
**Topic:** 4 Follow-up Fixes (image duration, publish state, upload state, dev proxy)

---

### 1. `src/pages/AmbientViewerPage.jsx` — Image display duration

**Before:**
```js
const IMAGE_DURATION = 8000;
```
**After:**
```js
const IMAGE_DURATION = 5000;
```

---

### 2. `src/pages/AmbientDisplaysPage.jsx` — Publish: await fetchDisplays for instant state update

**Before:**
```js
const handlePublishAndSetLive = async (displayId) => {
  try {
    await api.publishPlaylist(displayId, activeTab);
    toast.success(`Playlist ${activeTab} published`);
    fetchDisplays();
    fetchMedia(displayId, activeTab);
  } catch (err) { toast.error(err.message); }
};
```
**After:**
```js
const handlePublishAndSetLive = async (displayId) => {
  try {
    await api.publishPlaylist(displayId, activeTab);
    toast.success(`Playlist ${activeTab} published`);
    await fetchDisplays();
    fetchMedia(displayId, activeTab);
  } catch (err) { toast.error(err.message); }
};
```

---

### 3. `src/pages/AmbientDisplaysPage.jsx` — Upload: await fetchMedia for instant grid update

**Before (`handleUpload`):**
```js
await api.uploadAmbientMedia(expandedId, files, activeTab);
toast.success('Media uploaded');
fetchMedia(expandedId, activeTab);
fetchDisplays();
```
**After:**
```js
await api.uploadAmbientMedia(expandedId, files, activeTab);
toast.success('Media uploaded');
await fetchMedia(expandedId, activeTab);
fetchDisplays();
```

**Before (`handleDeleteMedia`):**
```js
await api.deleteAmbientMedia(mediaId);
toast.success('Media deleted');
fetchMedia(expandedId, activeTab);
fetchDisplays();
```
**After:**
```js
await api.deleteAmbientMedia(mediaId);
toast.success('Media deleted');
await fetchMedia(expandedId, activeTab);
fetchDisplays();
```

---

### 4. `vite.config.js` — Add proxy to server block for local dev

**Before:**
```js
server: {
  host: "::",
  port: 8080,
  hmr: { overlay: false },
},
```
**After:**
```js
server: {
  host: "::",
  port: 8080,
  hmr: { overlay: false },
  proxy: {
    '/api':     { target: process.env.VITE_API_URL || 'http://localhost:8000', changeOrigin: true },
    '/uploads': { target: process.env.VITE_API_URL || 'http://localhost:8000', changeOrigin: true },
  },
},
```

---

---

## Session 3 — 27 April 2026, 16:15
**Topic:** Phase 1 — Production Database Persistence & Backup

---

### 1. `.dockerignore` — Created (new file)

**Before:** File did not exist. Entire project directory was sent as Docker build context, including `server/signage.db`, `server/uploads/`, `node_modules/`, `.env`, `venv/`, `.git/`, etc.

**After:**
```
# Python
__pycache__/
*.pyc
*.pyo
.pytest_cache/
venv/

# Database and uploaded media — must live on the Docker volume, never baked into the image
server/signage.db
server/signage.db.bak1
server/signage.db.bak2
server/uploads/

# Frontend build artifacts and dependencies
node_modules/
dist/

# Environment and secrets
.env

# Git and editor
.git/
.claude/
```

---

### 2. `server/main.py` — Add shutil import

**Before:**
```python
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
```
**After:**
```python
from contextlib import asynccontextmanager
from pathlib import Path
import shutil
from fastapi import FastAPI
```

---

### 3. `server/main.py` — Add backup_db() function

**Before:** *(function did not exist)*

**After:**
```python
def backup_db():
    """Rotate backups before startup: signage.db → .bak1 → .bak2. Keeps last 2 backups."""
    db_path = Path(settings.DATABASE_PATH)
    if not db_path.exists():
        return
    bak1 = Path(str(db_path) + '.bak1')
    bak2 = Path(str(db_path) + '.bak2')
    if bak1.exists():
        bak1.replace(bak2)
    shutil.copy2(db_path, bak1)
```

---

### 4. `server/main.py` — Update lifespan to call backup_db() first

**Before:**
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    seed_db()
    yield
```
**After:**
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    backup_db()
    init_db()
    seed_db()
    yield
```

---

### 5. `server/database.py` — Document init_db() safety and schema change policy

**Before:**
```python
def init_db():
    conn = get_db()
    schema_path = Path(__file__).parent / "schema.sql"
    conn.executescript(schema_path.read_text())
    conn.commit()
    conn.close()
```
**After:**
```python
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
```

---

*Rule: every future edit session must append a new dated section to this file showing before/after for every changed snippet.*

---

## Session 4 — 29 April 2026
**Topic:** Phase 2 — URL Redesign + AmbientViewer Stabilisation

---

### 1. `src/App.jsx` — Replace viewer routes

**Before:**
```jsx
<Route path="/branch/:id" element={<DisplayViewerPage />} />
<Route path="/ambient/:id" element={<AmbientViewerPage />} />
```
**After:**
```jsx
<Route path="/:branchId/1/:id" element={<DisplayViewerPage />} />
<Route path="/:branchId/2/:id" element={<AmbientViewerPage />} />
```

---

### 2. `src/pages/AmbientDisplaysPage.jsx` — Update Preview window.open (line 268)

**Before:**
```js
onClick={() => window.open(`/ambient/${display.id}?preview=true&playlist=${activeTab}`, '_blank')}
```
**After:**
```js
onClick={() => window.open(`/${display.branch_id}/2/${display.id}?preview=true&playlist=${activeTab}`, '_blank')}
```

---

### 3. `src/pages/AmbientDisplaysPage.jsx` — Update View window.open (line 275)

**Before:**
```js
onClick={() => window.open(`/ambient/${display.id}`, '_blank')}
```
**After:**
```js
onClick={() => window.open(`/${display.branch_id}/2/${display.id}`, '_blank')}
```

---

### 4. `src/pages/CaseStudyEditorPage.jsx` — Add branchId derivation (after line 41)

**Before:** *(line did not exist)*

**After:**
```js
const branchId = state.branches.find(b => b.displays.some(d => d.id === Number(displayId)))?.id;
```

---

### 5. `src/pages/CaseStudyEditorPage.jsx` — Update Preview window.open (line 221)

**Before:**
```js
onClick={() => window.open(`/branch/${displayId}?preview=true`, '_blank')}
```
**After:**
```js
onClick={() => window.open(`/${branchId}/1/${displayId}?preview=true`, '_blank')}
```

---

### 6. `src/pages/AmbientViewerPage.jsx` — Full rewrite (state-machine playback engine)

The file was replaced entirely. Key changes versus the previous version:

#### 6a. State machine via `transitionStateRef`
**Before:** Transition authority split across multiple independent mechanisms (setTimeout 50ms, onEnded, onLoad/onCanPlay, polling).  
**After:** Single `transitionStateRef` with states `INIT → LOADING_NEXT → FADING → DISPLAYING`. Every transition point checks the current state before acting.

#### 6b. `layerSeq` forced media remount
**Before:** *(not present)*  
**After:**
```js
const [layerSeq, setLayerSeq] = useState([0, 0]);
// ...
setLayerSeq(prev => { const next = [...prev]; next[inactiveLayer] += 1; return next; });
// In renderLayer:
<video key={layerSeq[layerIdx]} ... />
<img key={layerSeq[layerIdx]} ... />
```
Forces DOM remount on every intentional media load — ensures `onCanPlay`/`onLoad` fires even when the same `src` returns on the same layer (even-item playlist loop reset bug).

#### 6c. `activeLayerRef` + `expectedLayerRef` — stable callbacks, no stale closures
**Before:** Callbacks had `activeLayer` in closure deps and were recreated on every transition. `startDisplayClock` (deps `[]`) called a stale `requestTransition` after the first transition.  
**After:**
```js
const activeLayerRef = useRef(0);   // always-current mirror of activeLayer state
const expectedLayerRef = useRef(0); // which layer we're waiting to fire ready
```
`applyPendingIfNeeded`, `requestTransition`, `handleLayerReady` all use `activeLayerRef.current` instead of captured `activeLayer`. All callbacks are stable (no stale closure issue).

#### 6d. `handleLayerReady` guard — fixes initial load
**Before:**
```js
const inactiveLayer = activeLayer === 0 ? 1 : 0;
if (layerIdx !== inactiveLayer) return;  // blocked layer 0 on init
```
**After:**
```js
if (layerIdx !== expectedLayerRef.current) return;  // expectedLayerRef=0 at init
```

#### 6e. Video transitions — skip FADING delay
**Before:** Both image and video waited `CROSSFADE_DURATION` (500ms) in FADING state before entering DISPLAYING.  
**After:**
```js
if (nextItem?.media_type !== 'image') {
  transitionStateRef.current = 'DISPLAYING'; // instant for video
} else {
  setTimeout(() => { startDisplayClock(nextItem); }, CROSSFADE_DURATION);
}
```

#### 6f. CSS transition — images only
**Before:**
```js
transition: `opacity ${FADE_DURATION}ms ease-in-out`,  // applied to all layers
```
**After:**
```js
transition: item.media_type === 'image' ? `opacity ${CROSSFADE_DURATION}ms ease` : 'none',
```

#### 6g. Color bar height — orientation-aware
**Before:**
```js
height: 'clamp(5px, 0.9vh, 10px)',  // same for all orientations
```
**After:**
```js
const colorBarHeight =
  orientation === 'portrait'
    ? 'clamp(8px, 1.35vh, 15px)'   // 1.5× original
    : 'clamp(10px, 1.8vh, 20px)';  // 2× original
```
Announcement overlay `bottom` offset updated to `colorBarHeight` to stay above the band.

#### 6h. `IMAGE_DURATION` and `FADE_DURATION` constants
**Before:** `const IMAGE_DURATION = 5000; const FADE_DURATION = 800;`  
**After:** `const IMAGE_DURATION = 5000; const CROSSFADE_DURATION = 500;`

---

### 7. `src/pages/AmbientViewerPage_New_Ver.jsx` — Deleted

Reference implementation file removed after merge into `AmbientViewerPage.jsx`.
