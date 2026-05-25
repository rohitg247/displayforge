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

---

## 2026-05-12 — Addendum: Tizen `onCanPlay` reliability fallback

**File:** `src/pages/AmbientViewerPage.jsx`

### Problem
On the physical Samsung TV, `onCanPlay` does not fire for videos mounted on a hidden (inactive) layer. All prior fixes assumed `onCanPlay` would eventually arrive. On-device result: `prebufferedLayerRef` stays `null`, `handleVideoEnd` falls through to `requestTransition` (slow path), enters `LOADING_NEXT`, then gets stuck permanently because `onCanPlay` never fires for the remounted element either.

On-device log showing the stuck state:
```
State: LOADING_NEXT
Active Layer: 0
Pre-buffer: none
L0: ambient-4-1778561794-0.mp4  ACTIVE
L1: ambient-4-1778561804-0.mp4

27.36s - onEnded [0]
2.09s  - prebuffer mounted [1] ambient-4-1778561804-0.mp4
2.08s  - startDisplayClock
2.08s  - setActiveLayer → 0
```

### Root cause
Samsung Tizen WebKit suppresses `onCanPlay` for `<video>` elements whose containing layer has `opacity: 0`. The pre-buffer video is always on the inactive (opacity 0) layer. `preload="auto"` still causes the browser to decode the video into its buffer regardless of `onCanPlay`.

### Fix
Added a 300ms fallback `setTimeout` at the end of `startDisplayClock`, after the pre-buffer mounting block. If `prebufferedLayerRef.current` is still `null` after 300ms, it is set to `inactiveLayer` — treating the video as pre-buffered based on decode time rather than `onCanPlay`. Three guards prevent a stale timeout from a previous cycle misfiring: state must still be `DISPLAYING`, `expectedLayerRef` must still equal this cycle's `inactiveLayer`, and `prebufferedLayerRef` must still be `null`.

On desktop (where `onCanPlay` fires within milliseconds), the timeout fires after 300ms but the `prebufferedLayerRef.current === null` guard is already false — the fallback is a no-op.

### Changes
- 1 `setTimeout` block (14 lines) added at the end of `startDisplayClock`, before the closing `}, [])`.
- No new refs, no new state, no deps changes, no structural changes.

---

## 2026-05-18 — Per-Transition Decode + Backdrop + Diagnostic Overlay

**Files:** `src/pages/AmbientViewerPage.jsx`, `vite.config.js`

**Symptom on Tizen TV (10.1.1.332:3200):** Black flashes / stutter at every transition, despite the prior pre-buffer architecture. The user can only photograph the `?debug=true` overlay — no live console. Plays end-to-end so JS parses and media loads; the problem is the flip itself.

**Working hypothesis:** The 300 ms `onCanPlay`-suppression fallback (prior session) marks the pre-buffered layer "ready" by elapsed time alone — but Tizen WebKit suppresses video decode on `opacity: 0` layers entirely, so when the flip happens the new active video has nothing decoded yet and `play()` triggers a fresh decode → 200-700 ms of black before first frame paints.

Seven coordinated changes plus a build-target tightening.

### Change 1 — `renderLayer` opacity/transform rules (video composited off-screen, image still crossfades)

Previously the inactive layer was hidden via `opacity: 0` for both image and video. Tizen suppresses decode on opacity-zero video. Replaced with a media-type-aware rule:

- Image: keep `opacity: isActive ? 1 : 0` and the 500 ms opacity transition. Crossfade is unchanged.
- Video: `opacity: 1` always; the inactive video is moved off-screen via `transform: translateX(-200vw)` so it is composited (and therefore decoded) without being visible. Active video sits at `transform: none`.

A new `offscreen` boolean captures the rule: `isVideo && !isActive && outgoingHoldRef.current !== layerIdx`. The `outgoingHoldRef` exception is what Change 5 uses to keep a just-departed video on-screen as a backdrop for an incoming image's fade.

Refs block at top of component gains `outgoingHoldRef = useRef(null)`.

### Change 2 — Drop the `play() → pause() → currentTime = 0` freeze in `handleLayerReady` Case B

The synchronous freeze sequence had to exist only because the inactive video was on an `opacity: 0` layer and the team wanted to guarantee frame 0 at flip. With Change 1, Tizen actually decodes the off-screen layer and the video sits naturally at `currentTime = 0` since `play()` was never called. Removed the `vr.play().catch() / vr.pause() / vr.currentTime = 0` lines. `prebufferFrozenRef = true` and `expectedLayerRef = -1` are kept as safety belts against residual `onCanPlay` re-fires.

Event log message changed from `onCanPlay/onLoad [N]` to `prebuffer ready via onCanPlay [N] — <filename>` for differentiation against the fallback path.

### Change 3 — `?debug=true` overlay instrumentation

The user can photograph the overlay. Every diagnostic that doesn't make it into the photo is wasted. Added:

- **`flipAtRef` + `firstFrameLayerRef`** refs. At every fast-path flip and at slow-path Case A, record `performance.now()` and the layer to watch. New `handleTimeUpdate(layerIdx)` on the `<video>` element fires on the next `timeupdate`, computes `performance.now() - flipAtRef.current`, logs `flip → first-frame [N]: <Nms>`, and disarms (`firstFrameLayerRef = -1`). Other layers' timeupdates are filtered out by the guard. This is the single number that says whether decode-ahead actually worked.
- **`onError` on `<video>` and `<img>`.** New `handleMediaError(layerIdx, item)` increments `errorCountRef`, captures `videoElement.error.code` when present, logs `onError [N] <filename> code=N`. Overlay header shows `Errors: N` in red when > 0.
- **`play()` outcome logging.** The autoplay `useEffect` previously did `.play().catch(() => {})` — silently swallowing `NotAllowedError`. Now: capture the returned promise, feature-detect (`typeof p.then === 'function'` for very old WebKit that returns undefined), then `.then` logs `play() resolved [N]` and `.catch` logs `play() rejected [N]: <ErrorName>`. A photograph of `NotAllowedError` would mean Tizen's autoplay policy is blocking and unblock the next round of work.
- **`flipRs` at every flip.** Read `videoRefs[readyLayer].current.readyState` immediately after `setActiveLayer(readyLayer)` and append it to the log line, e.g. `setActiveLayer → 1 (fast path, rs=4)`. `rs=4` (HAVE_ENOUGH_DATA) or `rs=3` is healthy; `rs<3` means decode-ahead failed.
- **Pre-buffer resolution differentiation.** Case B logs `prebuffer ready via onCanPlay [N]`. The fallback logs `prebuffer fallback [N] ready (rs=N)` (or `prebuffer late-fallback [N]` for the 1.2 s budget end). The distribution of these tells us whether `onCanPlay` even fires on Tizen now that the layer is translated rather than transparent.
- **`OutgoingHold: <layer|none>`** in the overlay header so a photograph during a video→image fade shows which layer is the held backdrop.

### Change 4 — `vite.config.js` build target

Added `build: { target: 'es2018' }` inside `defineConfig`. Tizen version on the target TV is unknown; pre-2020 Tizen Chromium (≤ 76) does not parse optional chaining or nullish coalescing. Vite 5's default `'modules'` ships those unchanged. ES2018 transpiles them down without losing useful syntax.

### Change 5 — Outgoing-video backdrop hold for Video → Image transitions

Without this, every video→image transition shows a 500 ms fade from **black** (the container background) to the image because Change 1's off-screen translate moves the just-departed video out of view the moment it becomes inactive.

- New `outgoingHoldRef = useRef(null)` — `null | 0 | 1`, layer index of an outgoing video being kept on-screen.
- In `handleVideoEnd`'s fast path, *before* `setActiveLayer`, capture `departingLayer = activeLayerRef.current` and the `nextItem`. If `nextItem.media_type === 'image'`: set `outgoingHoldRef.current = departingLayer`, log `outgoingHold start [N]`, schedule a clear at `CROSSFADE_DURATION`. The clear is guarded — only nulls the ref if it still equals `departingLayer` — so a rapid second transition can't have its hold overwritten.
- The `renderLayer` `offscreen` rule (Change 1) consults `outgoingHoldRef.current !== layerIdx`, so the held video stays at `transform: none`, opacity 1, zIndex 1. The incoming image fades in over the top (zIndex 2, opacity 0 → 1). Net visual: smooth crossfade from video's last frame to the image.
- In `startDisplayClock`, the new pre-buffer mount on the inactive layer would otherwise unmount the held video immediately (via `setLayerSeq[inactiveLayer] += 1`). Added `mountDelay = outgoingHoldRef.current === inactiveLayer ? CROSSFADE_DURATION : 0`. The mount + the readiness-check `setTimeout` block are wrapped in `mountPrebuffer()` and called via `setTimeout(mountPrebuffer, mountDelay)`. Stale-cycle guards re-check state and `expectedLayerRef` before mounting.

### Change 6 — Pre-buffer readiness check + late-fallback (replaces unconditional 300 ms fallback)

The prior 300 ms fallback marked the inactive video pre-buffered regardless of actual `readyState`. Replaced with:

- At 300 ms, read `videoElement.readyState`. If `>= 3` (HAVE_FUTURE_DATA) — or if next item is image — mark ready: `prebuffer fallback [N] ready (rs=N)`.
- Else log `prebuffer fallback [N] rs=N — waiting` and schedule a `+900 ms` retry (total budget ~1.2 s).
- At 1.2 s, mark ready regardless and log `prebuffer late-fallback [N] (rs=N)`. A small gap is better than missing the flip entirely.

This is gated by `transitionStateRef === 'DISPLAYING'` and `expectedLayerRef === inactiveLayer` at both points, so a stale timeout from a previous cycle can't misfire after a real transition has moved on.

### Change 7 — Loop-boundary marker

The pre-buffer for item 0 is mounted during item N-1's `DISPLAYING` phase via the `% length` wraparound — so loop boundaries reuse the same code paths as Cases 1-3 with the full duration of item N-1 as decode time. No code is needed beyond a diagnostic marker.

At both fast-path flip sites (in `handleVideoEnd` and in `requestTransition`'s fast path), added one line before the `currentIdxRef.current = nextIndexRef.current` update:
```js
if (nextIndexRef.current === 0 && currentIdxRef.current !== 0) {
  logEvent('=== LOOP RESTART ===');
}
```
A photograph of the overlay will show the marker between transition rows so we can spot whether glitches cluster at the boundary.

### Verification plan

Deploy to `http://10.1.1.332:3200/<branchId>/2/<displayId>?debug=true` with a playlist of `[video, image, video, image]` (exercises Video→Image, Image→Video, Video→Video with short videos, and the loop boundary). Photograph the overlay during 3 full loops.

Healthy signal in the photo:
- Every `setActiveLayer → N (fast path, rs=N)` has `rs=3` or `rs=4`.
- `flip → first-frame [N]: <Nms>` rows are under 50 ms for video transitions.
- `prebuffer ready via onCanPlay [N]` dominates; `prebuffer fallback ... ready` is occasional; `prebuffer late-fallback` never appears.
- `outgoingHold start [N]` and `outgoingHold end [N]` appear in pairs around every video→image transition.
- `=== LOOP RESTART ===` appears at the expected place.
- `Errors: 0`.
- No `play() rejected: NotAllowedError`.

If `rs=2` recurs at flips, Tizen suppresses decode on translated layers too — escalation Change 8 (separate hidden warm-up `<video>` with `readyState` polling, **not** `requestVideoFrameCallback` which is Chromium-only and absent on Tizen WebKit) becomes the next step. Not in this PR.

### Constants & invariants

- All new code references `CROSSFADE_DURATION` (the existing single constant) rather than the literal `500`. The 300 ms / 900 ms in the readiness fallback are intentionally distinct values and remain inline.
- No new dependencies, no state machine restructuring, no backend changes.
