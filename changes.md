# Changelog

## 2026-05-11 — Pre-Buffer Architecture (AmbientViewerPage)

**File:** `src/pages/AmbientViewerPage.jsx`

### Problem fixed
The viewer was **reactive**: it waited for a video to end before loading the next one. This meant load pressure fell exactly at the transition moment, causing black frames or stuttering on Samsung Tizen displays.

### Solution
**Proactive pre-buffer**: as soon as item N starts displaying, item N+1 is silently mounted on the inactive layer, play()→pause()→currentTime=0'd, and held frozen at frame 0. When item N ends, the swap is instant — frame 0 is already GPU-decoded and painted.

### Changes

#### New refs added
- `prebufferedLayerRef` — `null | 0 | 1`, tracks which layer has a video frozen at frame 0
- `eventLogRef` — rolling array of the last 15 timestamped debug events

#### New state/helpers
- `isDebug` — `searchParams.get('debug') === 'true'`, reads URL param
- `[, setDebugTick]` state — 200ms ticker that forces debug overlay re-renders
- `logEvent(label)` — pushes a `performance.now()`-stamped entry to `eventLogRef`

#### `startDisplayClock(item)` — modified
After setting `DISPLAYING` and optionally starting the image timer, immediately pre-buffers the next item on the inactive layer (`setLayerMedia` + `setLayerSeq`). Resets `prebufferedLayerRef = null` to mark the start of a new cycle.

#### `handleLayerReady(layerIdx)` — modified
- **Case B (new):** when `transitionStateRef === 'DISPLAYING'`, this is a pre-buffer completion callback. For video: `play()` → `pause()` → `currentTime = 0` (synchronous, Tizen-safe). Sets `prebufferedLayerRef = layerIdx`. Does not touch the state machine.
- **Case A (existing, small change):** for video items, now calls `startDisplayClock(nextItem)` immediately after entering `DISPLAYING`, which kicks off the pre-buffer cycle for the item after this one.

#### `handleVideoEnd()` — modified
- **Fast path:** if `prebufferedLayerRef !== null`, does an instant layer flip (`setActiveLayer`). The autoplay useEffect fires after re-render and calls `play()` from frame 0. Then calls `startDisplayClock` to pre-buffer the next item.
- **Slow path (unchanged):** if pre-buffer was not ready, falls back to `requestTransition()`.

#### `requestTransition()` — minimal change
Added `prebufferedLayerRef.current = null` after `applyPendingIfNeeded()` returns true (playlist reset). Everything else unchanged — images still use this full slow path.

#### `applyPendingIfNeeded()` — modified
Added `prebufferedLayerRef.current = null` inside the `if (currentPaths !== newPaths)` block to discard stale pre-buffers when the playlist resets.

#### Debug overlay — new
Visible only when URL contains `?debug=true`. Fixed top-left, `zIndex: 999`, `pointer-events: none`. Shows:
- Current state machine value
- Active layer index
- Pre-buffer status
- Per-layer filename with ACTIVE/PRE-BUFFERED labels
- Rolling event log (last 15 entries, fading opacity)

### Fallback plan
If frame drops or stuttering persist on Samsung hardware → manually switch to Option 2 (static frame 0 + immediate `play()` on swap). No runtime auto-detection — too fragile for production TV hardware.
