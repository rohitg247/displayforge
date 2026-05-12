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
- **Case B (new):** when `transitionStateRef === 'DISPLAYING'`, this is a pre-buffer completion callback. For video: `play()` → `pause()` → `currentTime = 0` (synchronous, Tizen-safe). Sets `prebufferedLayerRef = layerIdx`. After setting `prebufferedLayerRef`, now also sets `expectedLayerRef.current = -1` to stop the `onCanPlay` re-trigger loop (see bug fix below). Does not touch the state machine.
- **Case A (existing, small change):** for video items, now calls `startDisplayClock(nextItem)` immediately after entering `DISPLAYING`, which kicks off the pre-buffer cycle for the item after this one.

#### `handleVideoEnd()` — modified
- **Fast path:** if `prebufferedLayerRef !== null`, does an instant layer flip (`setActiveLayer`). The autoplay useEffect fires after re-render and calls `play()` from frame 0. Then calls `startDisplayClock` to pre-buffer the next item.
- **Slow path (unchanged):** if pre-buffer was not ready, falls back to `requestTransition()`.

#### `requestTransition()` — updated
Added `prebufferedLayerRef.current = null` after `applyPendingIfNeeded()` returns true (playlist reset).

Added **fast path** (same pattern as `handleVideoEnd`): if `prebufferedLayerRef.current !== null` when the image timer fires, the pre-buffered video is flipped in immediately instead of remounting the video element via a `layerSeq` increment. This means image→video transitions (including the playlist loop reset) also benefit from the pre-buffer — no video reload, no black screen.

Updated `useCallback` deps to include `startDisplayClock` and `logEvent` (required by the new fast path).

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

---

## 2026-05-12 — Two Production Bug Fixes (AmbientViewerPage)

**File:** `src/pages/AmbientViewerPage.jsx`

**Platforms targeted:** Samsung Internet for Tizen (WebKit), LG webOS (Chromium), Android TV (Chrome), desktop Chrome/Firefox/Safari. Both fixes are browser-agnostic.

### Bug 1 — `onCanPlay` re-trigger loop causing black screen on video-to-video transitions

**Symptom:** After the layer flip, the pre-buffered video stayed frozen on the Samsung TV. Debug logs showed 5+ identical `play()` → `pause()` → `onCanPlay` cycles within the same millisecond for the same video on the same layer during every pre-buffer cycle.

**Root cause:** In `handleLayerReady` Case B, calling `play()` to start the freeze sequence causes certain WebKit builds (including Tizen) to re-fire `onCanPlay`. `expectedLayerRef.current` was never cleared after the pre-buffer was marked ready, so the guard `layerIdx !== expectedLayerRef.current` passed on every re-fire. Each iteration called `play()` again, perpetuating the loop. On Tizen's event queue, a `pause()` from a late loop iteration landed after the autoplay useEffect's `play()` at layer-flip time, leaving the active video frozen at frame 0.

**Fix:** After `prebufferedLayerRef.current = layerIdx`, immediately set `expectedLayerRef.current = -1`. Since `-1` is never a valid layer index, any subsequent `onCanPlay` for the same video hits the guard and returns early. Exactly one freeze cycle runs; the video stays cleanly paused at frame 0 until the layer flip.

**Change:** 1 line added in `handleLayerReady` Case B (plus a comment).

### Bug 2 — `requestTransition` discarded pre-buffer on image→video transitions, causing black screen at playlist loop reset

**Symptom:** When the last item in the playlist was an image and the first item was a video, a visible black screen appeared at the loop wrap. The pre-buffer had already loaded and frozen the first video at frame 0, but the transition caused it to reload from scratch.

**Root cause:** `requestTransition` (called by the image display timer) had no fast path. It always incremented `layerSeq[inactiveLayer]`, which changed the React `key` on the video element, unmounting and remounting it. This discarded the pre-buffered frame and forced a network/decode reload. On Tizen (slower media pipeline than desktop), the reload took long enough to produce a visible black screen. Desktop browsers cached the video in memory, masking the issue entirely.

**Fix:** Added fast path to `requestTransition` (identical structure to `handleVideoEnd`'s fast path): if `prebufferedLayerRef.current !== null`, flip the layer immediately without touching `layerSeq`. The autoplay useEffect fires `play()` from frame 0 on the now-active layer. `startDisplayClock` then pre-buffers the item after this one on the newly-inactive layer. Updated `useCallback` deps to include `startDisplayClock` and `logEvent`.

**Change:** 13 lines added in `requestTransition` (fast path block + comment); deps array updated.

### Verification checklist (on-device)
1. Deploy with `?debug=true`
2. **Video-to-video**: event log shows exactly **one** `play()`/`pause()` pair per pre-buffer cycle — no repeat iterations
3. **Loop reset (image → first video)**: log shows `setActiveLayer → N (pre-buffer fast path)` at the transition; no black screen
4. **Full loop**: run 3+ complete loops; no black frames on any transition
5. **Regression (desktop)**: pre-buffer still works, debug overlay shows correct state, images fade correctly

---

## 2026-05-12 — Addendum: `prebufferFrozenRef` synchronous mutex

**File:** `src/pages/AmbientViewerPage.jsx`

### Problem
The `expectedLayerRef.current = -1` guard (from the fix above) did not stop the `onCanPlay` loop on-device. Logs still showed 5+ `play()`/`pause()` cycles per pre-buffer event.

### Root cause
`expectedLayerRef` is assigned `-1` at the **end** of Case B, after `play()` has already been called. On certain Tizen WebKit builds, `onCanPlay` fires **synchronously during `play()`** — before JavaScript yields back to the event loop. At that re-entrant call, `expectedLayerRef.current` still holds the original layer index (the `-1` assignment has not yet executed), so the guard passes and a second freeze cycle starts. `expectedLayerRef = -1` only stops *async* re-fires in future event-loop ticks; it cannot stop synchronous re-entry within the same tick.

### Fix
Added `prebufferFrozenRef = useRef(false)` — a boolean mutex that is set to `true` **before** `play()` is called. Any re-entrant `onCanPlay` (whether synchronous or asynchronous) immediately hits `if (prebufferFrozenRef.current) return` at the top of Case B. Exactly one freeze cycle runs per pre-buffer event. The `expectedLayerRef = -1` line is kept as a secondary guard for belt-and-suspenders coverage of async re-fires.

The mutex is reset to `false` in `startDisplayClock` before each new pre-buffer cycle begins, so it is clean for every video item that needs to be frozen.

### Changes
- New ref `prebufferFrozenRef = useRef(false)` added to refs block (with explanatory comment)
- `handleLayerReady` Case B: `if (prebufferFrozenRef.current) return` added as primary guard; `prebufferFrozenRef.current = true` set immediately before `vr.play()`
- `startDisplayClock`: `prebufferFrozenRef.current = false` reset before the pre-buffer block
- 4 lines added total, 0 deleted, no structural changes
