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

*Rule: every future edit session must append a new dated section to this file showing before/after for every changed snippet.*
