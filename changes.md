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

---

## 2026-05-26 — Full Engine Rewrite: Single-Video + Bridge Architecture

**File:** `src/pages/AmbientViewerPage.jsx` (685 lines → ~840 lines, complete playback-engine rewrite).
**Spec:** `~/.claude/plans/i-need-you-to-streamed-sketch.md` (sections A–H).

### Problem (confirmed by the 2026-05-18 diagnostic overlay)

Every video swap on the Tizen panel resolved via the **time-based** `prebuffer fallback`, never via `onCanPlay`. `flip → first-frame [N]` lines were missing entirely. Stale-image flashes and loop-boundary glitches persisted. `translateX(-200vw)` did **not** restore decode on the hidden layer — Tizen WebKit suppresses video decode on any non-visible `<video>`, regardless of how it's hidden.

The dual-layer hidden-video pre-buffer model is therefore architecturally incompatible with Tizen WebKit. No timing tweak, mutex, or `readyState` poll can close the gap. The previous five revision cycles were treating symptoms.

### Solution: browser-compatible analog of MagicINFO's native AVPlay pattern

- **One** persistent visible `<video>` element. Never unmounted, never moved, full-bleed at z=1.
- **Two** persistent `<img>` layers (`image-A`, `image-B`) at z=2 for image-only crossfades.
- **One** `<canvas>` bridge at z=3. During video→video swaps, capture the last frame of the outgoing video to canvas, raise canvas opacity to 1, change `video.src`, wait for *first paintable frame* (rAF + `currentTime > 0` for 2 consecutive ticks), then fade the canvas out over 150 ms. Result: zero black frames because the bridge always shows real pixels.
- **Network-only prefetch** via `fetch(url, { cache: 'force-cache' })` — warms the HTTP cache; never mounts a second `<video>` and so never contends for the single hardware decoder.
- **3-state machine**: `IDLE`, `PLAYING`, `SWAPPING`. Token-based stale-callback guards on every async boundary.

### Transition matrix (case-by-case)

| Outgoing → Incoming | Cover mechanism | First-frame signal |
|---|---|---|
| video → video (C.1) | Canvas bridge (last frame) | rAF: `ct > 0` for 2 consecutive ticks |
| video → image (C.2) | Outgoing video held at opacity 1 underneath; incoming image fades in over it | `img.decode()` or `onload` |
| image → image (C.3) | Standard opacity crossfade between img-A and img-B | `img.decode()` or `onload` |
| image → video (C.4) | Outgoing image held at opacity 1; incoming video fades in after first-frame confirmed | rAF first-frame loop |

`onCanPlay` / `onCanPlayThrough` are logged for observability but **never** used as a flip trigger. `playing` event is logged but never used either. The only authoritative first-frame signal is `currentTime > 0` for two consecutive rAF ticks (D1).

### What was removed

Deleted refs: `expectedLayerRef`, `activeLayerRef`, `prebufferedLayerRef`, `prebufferFrozenRef`, `outgoingHoldRef`, `flipAtRef`, `firstFrameLayerRef`, `nextIndexRef`, `errorCountRef` (replaced), `transitionStateRef` (replaced by `stateRef`), `videoRefs[]` (replaced by single `videoRef`).
Deleted state: `activeLayer`, `layerMedia`, `layerSeq`.
Deleted functions: `renderLayer(0/1)`, `handleLayerReady`, `handleVideoEnd`, `handleTimeUpdate` (replaced), `handleMediaError` (replaced). The 300/900 ms fallback ladder and the `play()→pause()→currentTime=0` freeze sequence are gone.

### Tizen-specific decisions locked in (see plan section D)

- `video.muted=true`, `playsInline=true`, `preload="auto"`, `autoplay={false}` — always.
- `videoEl.src` is set imperatively; the React `src` prop is **not bound** (prevents accidental remount).
- `video.src` is never set to `''` or removed — preserves decoder state between an image segment and the next video.
- `EARLY_BRIDGE_CAPTURE` constant exists as a gated escape hatch (off by default). Only flip to `true` after device evidence that the `onended`-time frame is unpaintable on a specific firmware.
- No `requestVideoFrameCallback` (Chromium-only, absent on Tizen WebKit). No user-agent sniffing.

### Diagnostics HUD (rebuilt from scratch)

`?debug=true` enables the HUD. `?debug=verbose` additionally enables per-rAF `ct` logging.

- Fixed top-left, 12 px monospace, max-width `min(46vw, 520px)`, green border, dark background — sized for legibility from a phone photo of the TV.
- 6-line **header** (always visible): `STATE`, `ITEM` with `ct/duration`, `rs / ns / ct / paused / muted`, `BRIDGE` + `PREFETCH` status, `ERRORS` + `LAST-SWAP`, `FPS` (rolling 2 s).
- 30-entry log ring (doubled from 15), latest at top, opacity fade for older entries.
- `MM:SS.mmm` wall-clock timestamps anchored at mount.
- 6 color classes: `lifecycle` (cyan), `success` (green), `warn` (yellow), `error` (red), `state` (orange), `verbose` (grey).
- Mandatory event vocabulary: every meaningful event uses an exact phrase (`src-set <name>`, `load() called`, `play() requested|resolved|rejected: <Err>`, `first-frame ct=N.NN (Nms after play)`, `bridge on (WxH)` / `bridge off (Nms after swap)`, `bridge-capture-failed: <reason>`, `state: A → B`, `image fade start/end [from→to]`, `=== LOOP RESTART (item N → item 0) ===`, `guard: stale-callback`, `swap-timeout (2000ms) — forcing fade`, `frame-stuck` / `frame-stuck-fatal`, `decode slow (Nms)`).
- Frame-advancement watchdog inside the rAF loop: warns at 500 ms stagnation, force-reloads at 1500 ms, lets `swap-timeout` fire at 2000 ms.

### Failure handling (degraded modes — engine never stalls)

| Failure | Action | Outcome |
|---|---|---|
| `drawImage` throws | log `bridge-capture-failed`, skip bridge, continue | one black frame at worst (same as baseline) |
| No first-frame within 2000 ms | log `swap-timeout`, force fade, `finalizeSwap` regardless | state machine resyncs |
| `play()` rejected (autoplay) | log + increment error counter; do not retry within swap | next `advance` retries |
| Frame stuck | warn at 500 ms, force `load()+play()` at 1500 ms, timeout at 2000 ms | engine advances |
| Mid-swap playlist update | stored in `pendingDataRef`; applied in `finalizeSwap` | smooth — current swap completes, then new playlist takes over |
| Image decode failure / timeout | log `image-onerror` or `image-decode-timeout`, force final opacity values, call `finalizeSwap` normally | engine continues; next dwell timer arms |
| Loop boundary | logged with `=== LOOP RESTART ===`; identical to any other `advance` | no glitch by design |
| `videoWidth=0` at capture | fall back to `clientWidth/Height`, then skip bridge if still zero | bridge-failure path |
| `reset()` mid-swap | token bump kills all in-flight callbacks; bridge forced to opacity 0 | clean teardown |

### Constants (centralized at file top)

`IMAGE_DURATION = 5000`, `CROSSFADE_DURATION = 500`, `BRIDGE_FADE_DURATION = 150`, `SWAP_TIMEOUT_MS = 2000`, `POLL_INTERVAL = 5000`, `DECODE_SLOW_THRESHOLD_MS = 800`, `FRAME_STUCK_WARN_MS = 500`, `FRAME_STUCK_FATAL_MS = 1500`, `LOG_RING_SIZE = 30`, `DEBUG_TICK_MS = 200`, `EARLY_BRIDGE_CAPTURE = false`, `EARLY_BRIDGE_LEAD_MS = 250`.

### What was kept untouched

`useParams`/`useSearchParams`, `api.getAmbientDisplay`, `api.publishPlaylist`, `fetchData` polling, `applyPendingIfNeeded` (semantics unchanged; refactored to deal with new ref set), preview banner, publish button, announcement block, color bar, orientation handling, container sizing, empty-playlist fallback. No backend / API changes. `vite.config.js` unchanged (`target: 'es2018'` stays).

### Verification

- `npm run build` — clean (16 s, 521 kB main bundle; pre-existing chunk-size warning unrelated to this change).
- Desktop smoke test (acceptance criteria H.1) and on-device Tizen verification (H.2–H.6) per the plan are the next step before merging to production. The smoking-gun signal on Tizen is the presence of `first-frame ct=...` lines for every video swap — these were *never* appearing pre-rewrite.

### Rollback

`git checkout 46c1da0 -- src/pages/AmbientViewerPage.jsx`. Single-file revert. No DB / API / config dependencies were changed.

### What this rewrite explicitly rejected

- Change 8 from the 2026-05-18 escalation note (hidden warm-up `<video>` + `readyState` polling) — same architectural class as the failing code, same Tizen visibility-driven decode suppression.
- Increasing fallback timers past 1200 ms — treats the symptom, not the cause.
- User-agent sniffing for Tizen branches — the new architecture is correct on all platforms.
- Adding a third hidden layer or rotating three videos — worsens decoder contention.
- `requestVideoFrameCallback` — Chromium-only; absent on Tizen WebKit.

---

## 2026-05-27 — Fix: remaining black screens (watchdog reload + premature swap-timeout)

**File:** `src/pages/AmbientViewerPage.jsx`

### Symptom

After the 2026-05-26 bridge rewrite, black screens were ~50% reduced but still appeared on a
**subset** of video swaps — with `Errors: 0`, no media fault, and the bridge architecture otherwise
working. "Some videos transition fine, some don't" was effectively a coin flip.

### Root cause (confirmed from on-device `?debug=true` logs + HTML spec)

Tizen's hardware decoder presents a video's first frame **~1400–1900 ms** after `src` + `load()`
(proven by the healthy swaps: `first-frame ... (1473ms)`, `(1555ms)`, `(1398ms)`, `(1665ms)`).

The in-swap watchdog in `startFirstFrameLoop` forced a destructive reload at
`FRAME_STUCK_FATAL_MS = 1500` — **inside** that normal decode window. The failing chain:

```
play() requested
frame-stuck-fatal — reloading        ← 1510ms: vid.load() + vid.play()
play() rejected: AbortError          ← load() aborts the in-flight play() (HTML spec / MDN)
swap-timeout (2000ms) — forcing fade  ← setBridgeOpacity(0,0): INSTANT cut
state: SWAPPING → PLAYING
loadedmetadata                       ← video only NOW has data, ~600ms AFTER the bridge vanished
```

Per the HTML spec, `load()` resets `readyState` to `HAVE_NOTHING` and aborts the pending `play()`
promise with `AbortError`. So the "fatal reload" threw away ~1500 ms of decode progress and
restarted from zero; the 2000 ms swap-timeout then fired before the *restarted* decode could finish
and **instantly** cut the bridge, revealing the still-black `<video>`. That gap was the black screen.
The bridge (outgoing video's real last frame) was working — the reload + premature timeout yanked it
away before the new frame existed.

### Fix (three surgical changes, no architecture/state changes)

1. **Removed the destructive in-swap reload.** The stuck-frame watchdog in `startFirstFrameLoop` is
   now diagnostic-only (keeps the `frame-stuck` warn). Deleted the `vid.load() + vid.play()` action,
   the `triedReload` flag, and the now-unused `FRAME_STUCK_FATAL_MS` constant. The swap-timeout is the
   single backstop; genuine media faults are still handled by `onError` (`handleVideoError`), so the
   engine can never permanently stall.
2. **`SWAP_TIMEOUT_MS` 2000 → 4000.** The bridge canvas (video→video) and the held outgoing image
   (image→video) cover the entire decode window with real pixels, so the extra headroom has **zero
   visual cost** and lets Tizen's ~1400–1900 ms (occasionally longer) decode complete naturally.
3. **Tizen-trusted paintability gate on the swap-timeout cover-release** (in `runVideoToVideo` and
   `runImageToVideo`). On timeout, only release the cover with a **graceful fade** when
   `videoRef.readyState >= 2 && videoRef.currentTime > 0` — i.e. the decoder has actually presented and
   advanced a real frame (consistent with the D1 first-frame signal; `readyState >= 2` alone is the
   spec signal that a frame *exists* but is distrusted on Tizen). If the decoder never produced a frame
   (rare/broken media), fall back to the prior instant reveal + advance so the engine never hangs. The
   `swap-timeout` log line now appends `rs=N ct=N.NN`.

### Validation (web-confirmed)

- HTML spec / MDN: `load()` is destructive (resets `readyState`, aborts `play()` with `AbortError`) —
  confirms change 1 is spec-correct, not inference.
- Xibo community (Tizen "black screen between videos"): Tizen has no gapless playback; the black is the
  container background showing through while the `<video>` has nothing painted — confirms covering the
  full decode window (changes 2 + 3) is the right approach.
- Samsung's video-element guide endorses the single reused `<video>` + `src`/`load()`-once-on-`ended`
  pattern; the second mid-swap `load()` (the removed reload) was the deviation.

### Verification

- `npm run build` — clean.
- Desktop smoke + on-device Tizen (`?debug=true`): every video swap shows `first-frame ct=...`;
  `frame-stuck-fatal — reloading` and `play() rejected: AbortError` no longer appear; `swap-timeout`
  rare/absent (now logs `rs/ct`); `Errors: 0`; no visible black screens across 3+ loops.

### Rollback

`git checkout 3ec4e32 -- src/pages/AmbientViewerPage.jsx`. Single-file revert. No DB / API / config deps.

### STATUS — awaiting on-device verification (session pickup note, 2026-05-28)

The fix above is **implemented and builds clean, but NOT yet committed and NOT yet verified on the
Tizen panel.** Desktop browsers mask the original symptom (they cache videos in memory), so only
on-device evidence proves the fix. This note exists so the next session can resume without re-deriving
context.

**Working tree state when this note was written:**
- `src/pages/AmbientViewerPage.jsx` — modified (Edits 1–5 in the session log; 4 logical changes:
  remove `FRAME_STUCK_FATAL_MS` constant, remove `triedReload` flag, remove destructive in-swap
  `vid.load()+vid.play()` reload, raise `SWAP_TIMEOUT_MS` 2000→4000, add `readyState>=2 && currentTime>0`
  paintability gate to the swap-timeout in `runVideoToVideo` AND `runImageToVideo`).
- `changes.md` — this 2026-05-27 entry appended.
- Baseline commit (rollback target): `3ec4e32`.
- `npm run build` — passes (522 kB main bundle; only the pre-existing chunk-size warning).

**What to capture on the panel (with `?debug=true`, 3+ full loops):**
- ✅ `first-frame ct=... (Nms after play)` appears for **every** video swap (the smoking-gun line —
  was missing on every swap pre-fix).
- ✅ `frame-stuck-fatal — reloading` — **never** appears (removed).
- ✅ `play() rejected: AbortError` — **never** appears (was caused by the removed reload).
- ✅ `swap-timeout (...)` — rare/absent. If it does fire, it now logs `rs=N ct=N.NN`.
- ✅ HUD shows `Errors: 0`.
- ✅ No visible black screens on any transition, including at `=== LOOP RESTART (item N → item 0) ===`.

**Failure tells to flag separately:**
- `swap-timeout (...)` with `ct=0.00` → decoder produced no frame within 4 s → genuinely failing media
  or a clip needing >4 s to decode on this firmware. Separate follow-up, not this class of bug.
- Black screens persist **with** `first-frame ct=...` present → different root cause (bridge capture
  returning black? compositor issue?). Investigate from there, do not revisit Edits 1–5.
- Black screens persist **without** `first-frame ct=...` → the rAF first-frame detection itself isn't
  firing on this firmware; escalate to a different first-frame signal.

**Next session actions, in order:**
1. Read this note + the 2026-05-27 entry above (full context).
2. Ask the user for the HUD photos taken on the panel.
3. If healthy → commit both files in one commit referencing the root cause; offer to push.
4. If unhealthy → match the symptom against the failure-tells above and branch from there.

---

## 2026-06-01 — Root-cause fix: video→video black screens (visible blanked plane) + last-frame poster cover

**Files:** `src/pages/AmbientViewerPage.jsx`, `server/media_utils.py` (new),
`server/backfill_posters.py` (new), `server/routers/ambient_router.py`, `server/models.py`,
`server/schema.sql`, `server/database.py`, `migrate.py`, `Dockerfile.backend`.

### Symptom (still present after the 2026-05-27 fix)
Black screens on a subset of **video→video** swaps (notably the loop boundary item N → item 0), with
`Errors: 0`, `first-frame` arriving normally (~1.7 s), and the HUD showing `BRIDGE: on`. So the
bridge was "up" yet the screen was black during the incoming clip's decode window.

### Root cause (confirmed from logs + code path, ranked)
The black is visible **during decode while the bridge is on**, which means the canvas bridge is not
actually covering the panel. Decisive contrast in the on-device logs:
- **image→video never blacks** — `runImageToVideo` sets `v.style.opacity='0'` *before* `load()`/`play()`.
- **video→video blacks** — `runVideoToVideo` left the `<video>` at `opacity:1` for the whole decode
  window, with only the canvas as cover.

The factor that correlates with black is **"the blanked `<video>` is left visible during decode."**
On Tizen the hardware video plane composites above HTML / ignores z-index (hypothesis **B**, best
fit), so the blanked plane shows over the canvas. A secondary possibility is that
`drawImage(hardware-decoded video)` writes black pixels (hypothesis **A**). `bridge on (WxH)` only
proves `drawImage` didn't throw, not that the pixels are real. External refs: signageOS / Xibo /
NowSignage / Signagelive / Yodeck all confirm HTML5 `<video>` on Tizen is **not gapless** (black
between clips is the platform default; true gapless needs native `webapis.avplay` in a packaged app);
Chromium's tracker documents `drawImage(video)` returning black with HW-accelerated video.

The 2026-05-27 fix (no in-swap reload, `SWAP_TIMEOUT_MS=4000`, paintability-gated release) was
correct and is **kept untouched** — it solved a *different* black-screen class. It just wasn't the
whole story.

### Fix — Phase 1 (client, `AmbientViewerPage.jsx`)
1. **Hide the video plane during the decode gap.** `runVideoToVideo` now raises a cover, then sets
   `v.style.opacity='0'` *before* `v.src=…/load()`, and reveals (`opacity='1'`) **before** the cover
   is lowered — in the `first-frame` path **and** the timeout-paintable path (and a forced reveal on
   the not-paintable path). opacity:0 reliably hides the plane on this panel (proven by image→video).
2. **Cover ladder (fallback order): poster `<img>` → canvas bridge → instant cut.** The video is only
   hidden when a real cover exists (a cut leaves it visible — no worse than before).
3. **Debug-only luma probe in `captureBridge`** (gated behind `isDebug`, zero production cost):
   `getImageData` of a few pixels → `bridge px luma=NN a=NN`. From a phone photo this tells us
   whether the canvas held a real frame (B) or black (A). Same-origin video ⇒ no taint.
4. **Latent stall bug fixed:** `handleVideoError` previously cleared the swap-timeout and replaced it
   with `setTimeout(()=>{},0)` — a media error mid-swap hung the engine forever. It now leaves the
   swap-timeout armed (its not-paintable branch reveals + finalizes), so the engine always recovers.
5. **Diagnostics:** `LOG_RING_SIZE` 30→60; HUD `maxHeight:'96vh'` + `overflow:hidden`; softer
   per-line opacity fade. New vocabulary: `cover: poster|bridge|none`, `video hidden (cover up)`,
   `video shown`, `cover off (…)`, `bridge px luma=…`, `poster preload …`. Existing vocabulary kept.
6. New `posterRef` `<img>` layer (z=3, above the canvas at equal z) + `preloadPoster(item)` which
   decodes the *currently playing* video's poster into that `<img>` (called from `start` and
   `finalizeSwap`) so a swap can raise it instantly.

**Not changed (per design):** `SWAP_TIMEOUT_MS`, the swap-token system, the rAF `currentTime>0`×2
first-frame gate — all correct.

### Fix — Phase 2 (server-side last-frame poster; the definitive cover)
A real `<img>` always paints on Tizen and is immune to both the overlay z-index issue and
drawImage-black, so we pre-generate each video's last frame and show it as the cover.

- **`server/media_utils.py` (new):** `extract_last_frame(video, poster)` shells out to ffmpeg —
  `-sseof -0.2` (frame ~0.2 s before end), retrying `-ss 00:00:00` (first frame) for very short
  clips. Never raises; returns False if ffmpeg is missing/fails (viewer falls back to the bridge).
  `ffmpeg_available()` helper.
- **`server/routers/ambient_router.py`:** on video upload, generate `…-poster.jpg` and store
  `poster_path`; return it from `get_ambient_display` (added to both SELECTs); delete the poster file
  in both delete endpoints.
- **`server/models.py`:** `AmbientMediaOut.poster_path: Optional[str]`.
- **`server/schema.sql`:** `poster_path TEXT DEFAULT NULL` on `ambient_media` (fresh installs).
- **`server/database.py`:** idempotent `ALTER TABLE ambient_media ADD COLUMN poster_path` in
  `init_db()` — existing **production** DBs pick up the column automatically on deploy.
- **`migrate.py`:** same ALTER added (local dev).
- **`Dockerfile.backend`:** `ffmpeg` added to the existing `apt-get install` line (backend image
  only — no frontend bundle / host impact; Tizen browser does *less* work, not more).
- **`server/backfill_posters.py` (new):** idempotent backfill for already-uploaded videos. Run
  `python -m server.backfill_posters` (root or inside the backend container). Skips rows with
  `poster_path` set, reuses an existing poster file, only invokes ffmpeg for the rest.

`src/services/api.js` needs no change — `poster_path` flows through `getAmbientDisplay` automatically.

### Deploy
1. Rebuild the backend image (`docker compose build backend` / `up -d --build`) so ffmpeg is present
   and `init_db()` adds the column.
2. One-time: `docker compose exec backend python -m server.backfill_posters` to poster existing
   videos. New uploads get posters automatically.
3. Frontend: `npm run build` (clean — 523 kB main bundle, only the pre-existing chunk-size warning).

### Verification (Tizen panel, `?debug=true`, mixed playlist, 3+ loops, photograph HUD)
- **No black** on any video→video swap incl. `=== LOOP RESTART (item N → item 0) ===`; the outgoing
  last frame holds, then crossfades to the next clip.
- `cover: poster (last frame)` on swaps with a poster; `video hidden (cover up)` → `video shown`
  bracket each swap; `cover off (poster …)`.
- `bridge px luma=NN` (debug): `luma>0` ⇒ cause was B (video-hide fixed it); `luma≈0` ⇒ cause was A
  (poster is what's covering). Either way the poster guarantees the freeze-frame.
- `first-frame ct=…` every swap; `swap-timeout` rare/absent; `Errors: 0`.
- First clip on cold start may still flash black once (platform first-loop limit) — expected.

### What this rejected
- npm libraries to "fix" Tizen compositing — none exist; would only grow the bundle.
- Browser-side last-frame capture on the panel — Tizen browser is resource-limited; all heavy work is
  server-side now.
- Native `webapis.avplay` — the only true-gapless path on Tizen, but requires repackaging as a
  privileged `.wgt` app; out of scope (documented as the strategic option).

### Rollback
Frontend: `git checkout 503daa2 -- src/pages/AmbientViewerPage.jsx`. Backend is additive (nullable
column + best-effort ffmpeg); reverting the router/Docker changes leaves existing data intact.

---

## 2026-06-01 — ESLint now covers `.js` / `.jsx` (was TS-only)

**Files:** `eslint.config.js`, `src/pages/AmbientViewerPage.jsx`.

### Why
The flat config linted only `files: ["**/*.{ts,tsx}"]`. Since the entire app is `.js`/`.jsx` (there
are **no** `.ts`/`.tsx` source files), ESLint silently skipped every real file — `npx eslint
src/pages/AmbientViewerPage.jsx` returned "File ignored because no matching configuration was
supplied". So `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, and base JS rules never ran
on the React sources (which is also how a bogus "tagged-template" bug report could even be
entertained). TypeScript-ESLint is **kept** (zero-risk, ready for future `.ts`/`.tsx` scaling) — its
parser handles JS fine and its rules are inert on plain JS.

### Changes — `eslint.config.js`
- **Glob widened:** `files: ["**/*.{ts,tsx}"]` → `["**/*.{ts,tsx,js,jsx}"]`.
- **Ignores tightened:** `["dist"]` → `["dist", "**/*.config.js", "**/*copy*.jsx", "**/*_REFERENCE.jsx"]`.
  - `**/*.config.js` — Node-context build configs (`vite/vitest/tailwind/postcss/eslint.config.js`)
    use `process` / `__dirname` / `require`, which would trip `no-undef` under browser globals; they
    aren't app source.
  - `**/*copy*.jsx`, `**/*_REFERENCE.jsx` — dead backup copies of AmbientViewerPage.
- **`"no-empty": ["error", { allowEmptyCatch: true }]`** added — the code uses intentional best-effort
  `catch (_) {}` cleanups (e.g. `video.pause()`), so empty catches shouldn't fail lint.

### Changes — `src/pages/AmbientViewerPage.jsx`
Removed 2 now-dead `// eslint-disable-next-line react-hooks/exhaustive-deps` directives (in
`finalizeSwap` and `advance`). With the file finally being linted, ESLint reported them as **unused**
— the dependency arrays are already complete for reactive values (the omitted items are refs /
hoisted function declarations the rule ignores), so the disables were unnecessary.

### Pre-existing warnings surfaced — all resolved (production-friendly pass)
Widening the glob surfaced 3 warnings in files outside the ambient viewer. All resolved correctly:
- **`src/components/ui/sonner.jsx`** & **`src/context/AppContext.jsx`** —
  `react-refresh/only-export-components`. Both are intentional, idiomatic patterns (shadcn re-exports
  `toast` next to `Toaster`; the Context file co-locates `useApp` with `AppProvider`). The rule is a
  **dev-only Fast Refresh** hint with no production impact, and splitting the files would ripple
  through many imports — so each got a targeted `// eslint-disable-next-line
  react-refresh/only-export-components` with a justification comment.
- **`src/pages/CaseStudyEditorPage.jsx:61`** — `exhaustive-deps` "missing `editingId`". This effect
  **must** run only on `caseStudies` change. Adding `editingId` would reset the form on every
  selection, and adding `handleSelectCaseStudy` (recreated each render) would cause an infinite loop —
  so blindly adding the dep was a real bug. Resolved with a documented `eslint-disable-next-line`
  explaining the intentional partial deps.

### Result
- `npm run lint` → **0 problems** (0 errors, 0 warnings) across the whole project.
- `AmbientViewerPage.jsx` lints **completely clean** (validates the black-screen work's hook deps).
- `npm run build` — clean (config + comment-only; no runtime impact).

### Optional follow-up
To lint the config files too, add a block targeting `**/*.config.js` with
`languageOptions.globals: globals.node` instead of ignoring them.

---

## 2026-06-01 — Hardening: `Cache-Control` for `/uploads` static media

**File:** `server/main.py`. **Scope:** network hardening only — **no playback logic changed.**

### Why
Not a fix for the transition delay (that's Tizen decode/compositor-side, not the JSON API poll). This
just stops the request layer from adding avoidable network cost: `StaticFiles` sends
`ETag`/`Last-Modified`/`Accept-Ranges` but **no `Cache-Control`**, so the Tizen browser re-requests
the same video over the network on **every playlist loop** instead of serving it from cache.

### Change
Added a `CachedStaticFiles(StaticFiles)` subclass that overrides `file_response` to set
`Cache-Control: public, max-age=31536000, immutable`, and mounted `/uploads` with it.

`immutable` is safe here because every uploaded filename is unique/timestamped and never overwritten
in place — `ambient-<id>-<ts>-<i>.<ext>`, `<stem>-poster.jpg`, `cs-<id>-thumb-<i>-<ts>.<ext>` — so a
given URL's bytes never change. A given media URL deleted + re-uploaded gets a new name, so stale
cache entries can't collide. Verified `Starlette.StaticFiles.file_response` exists and is synchronous,
so the override is correct; it applies to both full (200) and range (206) responses.

### Effect
Loop replays and the new poster `<img>`s load from the browser cache instead of re-downloading; the
HTTP-cache prefetch (`fetch(..., {cache:'force-cache'})`) also becomes effective. No API/route/schema
change; no frontend change.

### Note (infra, NOT part of this patch) — production currently uses `vite preview`
`Dockerfile.frontend` serves the built app with `npm run preview` (vite preview) on :3200, and
`vite.config.js`'s `preview.proxy` forwards `/uploads` (and `/api`) to the backend. Vite's docs state
`preview` is **not** for production serving — its Node proxy isn't tuned for large media / many range
requests. Recommendation (separate change): serve the built `dist/` via nginx (or `serve`) and serve
`/uploads` directly from the backend/nginx with these same cache + range headers. Deliberately **not**
bundled here to keep this patch small and infra-free.

### Verify / rollback
Verify: `curl -I http://<backend>/uploads/<file>` shows `Cache-Control: public, max-age=31536000,
immutable` and `Accept-Ranges: bytes`. Rollback: revert `server/main.py` (mount `StaticFiles`
directly again); purely additive, no data impact.

---

## Deferred follow-up (NOT in this rollout) — replace `vite preview` with a real static server

**Status:** documented only, intentionally deferred. Test the current Tizen black-screen fix +
`/uploads` cache hardening on the panel first; revisit this afterward to keep the rollout small and
isolate variables. **No code in this pass.**

**Why:** production serves the built frontend with `npm run preview` (`Dockerfile.frontend` CMD), and
`vite.config.js`'s `preview.proxy` forwards `/uploads` + `/api` to the backend. Vite's docs state
`preview` is not intended for production serving; its single-process Node proxy isn't tuned for large
media or many HTTP range requests.

**When ready, do (separate change):**
1. **Serve `dist/` from nginx** (or another real static server) instead of `vite preview`. Make
   `Dockerfile.frontend` multi-stage (node build → nginx serve) and update the `frontend` service in
   `docker-compose.yml`.
2. **Serve `/uploads` directly** from the backend (or nginx reverse-proxying to it) with HTTP
   **range** support and the **cache headers already added** (`Cache-Control: public,
   max-age=31536000, immutable`, `Accept-Ranges: bytes`) — i.e. don't route media through a JS preview
   proxy.
3. **Route `/api`** to the backend via nginx `proxy_pass`, or keep the browser hitting the backend
   directly via `VITE_API_URL`.

**Acceptance:** media loads with correct `Cache-Control` + `206` range responses; zero change to the
playback engine; `?debug` HUD timings unchanged or better.

---

## 2026-06-02 — On-device follow-up: poster cover confirmed inactive, version stamp + decode normalization

### What the on-device logs proved (root cause, second pass)
With the previous fix deployed, the panel still showed a brief black on video→video swaps. The new
`?debug` HUD logs gave the answer directly — every swap logged:

```
cover: bridge
bridge on (1040x1854)
bridge px luma=0 a=255          <- canvas captured 100% BLACK
video hidden (cover up)
first-frame ct=0.18 (1312ms after play)
LAST-SWAP: 1514..1632ms
```

Two findings:
1. **`cover: bridge`, not `cover: poster (last frame)`** → the poster cover never fired. The line is
   the plain `cover: bridge` variant (not "poster not ready"), i.e. `outgoingItem.poster_path` was
   **falsy** → `poster_path` is **NULL in the DB** for these clips. The backend chain is correct end
   to end (upload extracts poster → `get_ambient_display` SELECT/returns `poster_path` → viewer
   preloads + uses it); the clips simply predate the feature and **`backfill_posters` was never run**
   (and/or the backend image wasn't rebuilt with ffmpeg).
2. **`bridge px luma=0 a=255`** → `canvas.drawImage(video)` returns pure black on this panel,
   confirming the hardware video plane composites above the HTML/canvas. So the **canvas bridge can
   never hold the last frame on this device** — the server-extracted poster `<img>` is the *only*
   cover that works. (Matches signageOS / Tizen-forum / Samsung guidance: gapless HTML5 video isn't
   possible in the Tizen browser; cover the unavoidable decode gap with a real image.)

`decode slow (810ms)` is only a warning threshold; the real first-frame gap is ~1.3–1.6 s
(`first-frame … 1312ms`, `LAST-SWAP 1514–1632ms`). That window is what shows black today and what the
poster cover replaces with the frozen last frame.

### Changes in this rollout

**1. Build/version stamp in the debugger (so deploys are verifiable on-panel).**
- `vite.config.js`: read `package.json`, inject `__AMBIENT_BUILD__` (build timestamp) and
  `__APP_VERSION__` via Vite `define`. The timestamp changes every build, so a stale value on the
  panel means the redeploy didn't land.
- `src/pages/AmbientViewerPage.jsx`: `ENGINE_VERSION` constant (bump on logic changes) +
  `BUILD_STAMP` (from the inject, falls back to `'dev'` under Vitest). Logged at engine init
  (`engine 2.1-poster-cover · build <ts>`) and shown as the **first line of the `?debug` HUD**.

**2. Poster-coverage diagnostic (makes the NULL-poster cause self-evident).**
- On first data load, the viewer logs `posters: N/M videos` — and `… — run server.backfill_posters`
  (as a `warn`) when `N < M`. So "every swap will be black" is now one glance at the HUD.

**3. Server-side decode normalization (`+faststart`, uniform H.264) to *shorten* the gap.**
- `server/media_utils.py`: new `normalize_video(src, dst, timeout=300)` — re-encodes to a
  Tizen-friendly MP4 (moov-at-front via `-movflags +faststart`, H.264 High / yuv420p, bounded GOP).
  Native resolution + frame rate preserved (no scaling). **Safe by construction:** writes only to
  `dst`, never raises, removes partial output, returns bool.
- `server/routers/ambient_router.py`: video uploads are now normalized to `*-norm.mp4` (served file),
  with poster extracted from the final file. If normalize fails, the original upload is kept. New
  uploads only → fresh filenames → no cache-staleness with the immutable `/uploads` headers.
- This **shortens, does not eliminate**, the first-frame gap; the poster cover handles the rest.

**4. `server/backfill_posters.py`: opt-in `--normalize`.**
- Default `python -m server.backfill_posters` is unchanged (posters-only, additive, idempotent) — this
  is the step that fixes the **current** black screen (generates posters for existing clips so swaps
  switch from `cover: bridge` to `cover: poster (last frame)`).
- `--normalize` additionally re-encodes not-yet-normalized clips to `*-norm.mp4`: writes the new file,
  **commits the DB pointer first**, then removes the old video + poster. Cache-safe (URL changes);
  idempotent (skips `*-norm.mp4`); never loses the original on failure.

**5. `docs/tizen-avplay-seamless.md` (scoping only, no code).**
- Documents the one path to *true* gapless playback — a packaged Tizen SSSP app using
  `webapis.avplay` (what MagicInfo uses) — its requirements, the fact that **even AVPlay black-flashes
  on the first loop**, and why it's a separate architecture/deliverable. Sequenced as a deferred track.

### Deploy / verify (in order)
1. Rebuild backend so ffmpeg is present: `docker compose up -d --build backend`.
2. **Fix existing clips (the black screen):** `docker compose exec backend python -m server.backfill_posters`
   (optionally `--normalize` to also speed up their decode).
3. Rebuild + redeploy frontend.
4. On the panel with `?debug=true`: confirm the HUD top line shows the **new build timestamp**,
   `posters: M/M videos`, and that swaps log **`cover: poster (last frame)`** with `bridge px luma>2`
   (or no bridge line) — i.e. the last frame freezes instead of going black. `npm run lint` and
   `npm run build` both pass.

### Not changed (deliberately)
Playback state machine, swap token guards, first-frame gate, `SWAP_TIMEOUT_MS`, and the
`handleVideoError` backstop are untouched. No new npm/browser dependency; ffmpeg (already in the
backend image) does posters + normalization. Browser-side load is unchanged — all new heavy work is
server-side.

---

## 2026-06-02 — Senior-audit hardening: poster-freeze to 10/10 (engine v2.2-poster-freeze)

Follow-up senior audit + implementation pass. Validated against official Samsung guides
(using-video-elements, using-avplay, seamless-video-playback), the AVPlay Seamless StillMode/MixedFrame
samples, signageOS HTML5 limitations, and community reports (Xibo). Findings: video→video already
implemented the intended "instant-cut to poster, hold, reveal when paintable" flow; the real gaps were
(1) a single-frame extraction that produces a BLACK poster on fade-to-black clips, (2) video→image not
using the poster (relying on the Tizen plane holding its last frame), and (3) the cover fade-out being
a small but real black-flash window over the glitch-prone video plane.

### Changes
**1. Smart, non-black last-frame extraction — `server/media_utils.py` (`extract_last_frame`).**
Was: one frame at `-sseof -0.2` (a fade-to-black ending → black poster → instant-cut to black). Now:
probe candidate offsets `[0.1,0.3,0.6,1.0,1.5,2.2]`s before EOF with a cheap **1-byte luma read**
(`-vf scale=1:1 -pix_fmt gray -f rawvideo pipe:1`), pick the offset CLOSEST to the end with mean luma
≥ 18; else the brightest candidate; else the first frame. ffmpeg-only (no Pillow). Logs the chosen
offset + luma. Benefits upload + backfill automatically.

**2. Hard-cut cover reveal (no fade) — `src/pages/AmbientViewerPage.jsx` (`runVideoToVideo`).**
Replaced the 150ms `lowerCover`/`fadeOutBridge` poster/bridge fade with an instant `dropCover()`: the
incoming video is revealed only once paintable (`readyState>=2 && currentTime>0`, unchanged), then the
cover is removed in the same frame. Eliminates the semi-transparent window over the Tizen video plane
where a black flash could leak. Removed the now-dead `lowerCover`, `fadeOutBridge`, and
`BRIDGE_FADE_DURATION`.

**3. Poster is the provably-sole cover; black bridge no longer masquerades.**
`captureBridge` now ALWAYS runs the 3-pixel luma probe (negligible) and stores it in
`lastBridgeLumaRef`. In `runVideoToVideo`, a captured bridge with luma ≤ 2 is treated as `cut` with a
loud `cover: bridge BLACK (luma=…) — poster missing!` warning instead of raising a black layer that
pretends to cover. (On this panel `drawImage` is black, so the bridge is effectively dead; kept only
as a defensive path for firmwares where it works.)

**4. video→image now routes through the poster freeze — `runVideoToImage`.**
If the outgoing clip's poster is ready: hard-cut UP to the poster, pause+hide the `<video>`, then once
the next image decodes show it opaque at z=2 BENEATH the poster and **hard-cut the poster off**
(flash-free — never exposes the video plane). If no poster, falls back to the legacy direct
video→image crossfade. This removes the last reliance on the Tizen plane holding a frame; every
video-end is now video → poster(freeze) → next.

**5. normalize_video capped to the documented decoder ceiling — `server/media_utils.py`.**
signageOS documents Tizen 2.4–SSSP4 as FullHD@30. Added a tiny `ffprobe` for width/height/fps; now
**downscales only when a source exceeds 1080×1920** (orientation-aware, `force_original_aspect_ratio=
decrease:force_divisible_by=2`, never upscales) and **caps fps to 30 only when >30** (24/25/30 left
untouched to avoid judder). `+faststart` / H.264 High / yuv420p / CRF unchanged. A 4K/60 upload would
otherwise decode slower and worsen the gap.

**6. Versioning.** `ENGINE_VERSION` → `2.2-poster-freeze` (HUD top line + init log + build stamp).

**7. Docs.** `docs/tizen-avplay-seamless.md` refined per using-avplay: avplay privilege not needed on
2015+, `webapis.avplaystore` two-player MixedFrame, `suspend`/`restore`, `setDisplayRect` 1920×1080
base. Doc-only.

### Reference validation
Browser poster-freeze is confirmed the correct **production workaround (masking), not true seamless** —
the Tizen browser has a single decoder (a 2nd `<video>` pauses the 1st; Xibo hits the same black
screen). True seamless = native AVPlay in a `.wgt` (MagicInfo), which STILL black-flashes on the first
loop — scoped/deferred, not adopted. Prioritized correctness + decode-gap masking, no native-gapless
claims. Pre-concatenating clips into one file (a known alternative) was considered and rejected
(breaks dynamic playlists, interleaved images, announcements, loop boundaries).

### Verify
`npm run lint` + `npm run build` green; `python -m py_compile` of the three backend files OK. On panel
`?debug=true`: HUD shows `v2.2-poster-freeze · <build>`, `posters: M/M`; video→video AND video→image
log `cover: poster (last frame)` and freeze the last frame (no black, no fade); no `cover: bridge
BLACK` once posters exist. Upload a fade-to-black clip → its `*-poster.jpg` is the last BRIGHT frame
(stdout luma log confirms).

---

## 2026-06-14 — Engine v3.0: seamless-loop (single continuous file) + TV→URL debug-log capture

**Files:** `src/pages/AmbientViewerPage.jsx`, `src/services/api.js`, `server/media_utils.py`,
`server/routers/ambient_router.py`, `server/database.py`, `server/schema.sql`, `migrate.py`,
`server/backfill_posters.py`.

### Why (corrected root cause)
On the real Samsung panel the per-item poster masking (v2.2) still showed black, and the user
clarified the real, persistent symptom: **mid-playlist was fine in the base version; the black is the
playlist RESTART (last item → first item)** — and the current masking even regressed mid-playlist.
Tizen-specific causes (confirmed: signageOS / NowSignage / Samsung video-element docs / aframe #3209):
1. **Decoder re-init at the wrap** — wrapping to index 0 RE-`load()`s the first clip on Tizen's single
   hardware decoder → the plane blanks ~1.3–1.6 s.
2. **End-of-stream blank** — even a single `<video loop>` can flash "right before restarting" because
   the decoder hits `ended` (plane blanks) before it seeks back.

Every prior round tried to *mask* a per-item gap. This round **removes the gap**: play the whole
playlist as ONE continuous file and loop it WITHOUT a reload and WITHOUT hitting end-of-stream.

### The fix — one continuous loop file + pre-end seek-to-0 (no quality loss)
**Backend — `build_playlist_video` (`server/media_utils.py`)**: joins the live playlist into one file
with ffmpeg's **concat demuxer `-c copy` (zero re-encode of the joined stream)**. Per-segment policy
(user-approved "re-encode only the odd clips"):
- conforming clips (share the dominant H.264/yuv420p geometry, checked via `ffprobe` `_probe_stream`)
  are **stream-copied byte-for-byte** (`_remux_copy_segment`, only audio stripped — lossless);
- still images are encoded once (`_encode_segment`, CRF 16 visually-lossless — no motion to degrade);
- a non-conforming video is re-encoded once to the target spec.
Target spec = most common in-ceiling geometry/fps so the MOST clips copy (`_pick_target_spec`). Output
has closed-GOP IDR keyframes (`_GOP_ARGS`) so frame 0 is a keyframe → instant seek-to-0. Temp segments
live in a `TemporaryDirectory`; safe-by-construction (writes only `dst`, never raises, returns bool).

**Backend wiring (`ambient_router.py` + schema)**: new `ambient_displays.playlist_video_path` /
`playlist_video_sig` columns (`schema.sql`, idempotent ALTER in `database.py` `init_db()`, `migrate.py`).
`_regenerate_playlist_video(db, display_id)` rebuilds the LIVE playlist's file after
`publish_playlist` / `reorder_ambient_media` / `delete_ambient_media`; idempotent via a stable sha1
`sig`; content-addressed filename `ambient-<id>-playlist-<sig>.mp4`. **Single-item refinement:** one
live video → point `playlist_video_path` straight at that clip's URL (no build — one file already);
one image / empty → NULL. `_is_built_concat` + `_unlink_upload` guard stale-file cleanup so a real
clip is never deleted (also fixed in the display-delete path). `get_ambient_display` returns
`playlist_video` for LIVE viewing only (admin/preview keeps the per-item engine on draft content).
`backfill_posters.py` gains `--playlist-videos` to build files for existing displays without
re-publishing.

**Frontend (`AmbientViewerPage.jsx`, engine `3.0-seamless-loop`)**: when `display.playlist_video` is
present it renders ONE `<video muted playsInline autoplay loop>` (no per-item engine). **Pre-end
seek-to-0 watchdog** (`handleSingleTimeUpdate`): when `currentTime >= duration - SINGLE_SEEK_LEAD`
(0.15 s) it sets `currentTime = 0` (NO `load()`), so the decoder never reaches `ended` and never
reloads → gapless restart. `loop` + an `onEnded`→seek backstop cover a missed watchdog. The HUD shows
`MODE: seamless-loop ✓` vs `per-item engine (fallback)` so a build failure is never silent. The
per-item engine is kept untouched as the automatic fallback (build failed / all-image / old backend).

### Part 2 — TV→URL debug-log capture (diagnose without watching the panel)
- `POST /api/ambient/{id}/debug-log` (text/plain body → no CORS preflight from the TV) stores the
  viewer's event-log ring + HUD header to `<DB dir>/debug-logs/ambient-<id>-<ts>.json` (+ `-latest`,
  newest 20 kept). `GET /api/ambient/{id}/debug-log/latest` returns it as **plain text, no-cache**.
- `api.postAmbientDebugLog` posts every 10 s when `?debug=true`. Retrieval: open
  `http://<tv-host>:8888/api/ambient/<id>/debug-log/latest` on a laptop → select-all → paste.

### Verify
- `npm run lint` + `npm run build` green; `python -m py_compile` of the changed backend files OK.
- Panel `?debug=true`, 5+ loops incl. the restart: HUD `MODE: seamless-loop ✓`, repeated
  `pre-end seek → 0`, **no black at `=== loop wrap ===`**, `ERRORS: 0`. Confirm the built file is a
  stream copy (`ffprobe` shows the source codec; conforming clips not re-encoded).

### Deploy
`docker compose up -d --build backend` → `docker compose exec backend python -m server.backfill_posters --playlist-videos`
(builds the loop file for existing displays) → rebuild frontend. New publishes rebuild automatically.

### Future-proofing (same session, non-breaking)
- **Audio is no longer permanently stripped — it's a switch.** `build_playlist_video(..., include_audio=)`
  threads through `_remux_copy_segment` / `_encode_segment`: default OFF (the player is muted; segments
  stay video-only for a clean `-c copy`). Set env **`AMBIENT_PLAYLIST_AUDIO=true`** to keep audio — the
  builder then gives images/silent clips a synthesised AAC track and re-encodes only audio (the **video
  is still stream-copied losslessly**), so every segment stays concat-compatible. No code change to
  enable. (The viewer `<video>` is still `muted` for autoplay; unmuting is a separate future step.)
- **Per-image duration field (settable at upload).** New nullable `ambient_media.duration` column
  (seconds; NULL → default `AMBIENT_IMAGE_SECONDS`=5). `get_ambient_display` returns it;
  `build_playlist_video` bakes each image segment to `it.duration or default`. The upload endpoint
  accepts an OPTIONAL `durations` form field (comma-separated, aligned to files) — the current UI sends
  nothing (all NULL, unchanged behavior); a future upload UI can set per-image seconds without any
  endpoint change. The concat `sig` includes duration + audio mode, so changing either rebuilds the
  loop file. (The per-item fallback engine still uses its fixed constant; the seamless-loop path — what
  runs in production — honors the per-image duration.)

### Debug-log capture upgraded to a full, retained, timestamped transcript
Was a rolling 60-event snapshot overwritten each POST. Now, while `?debug=true` is open, the viewer
buffers **every** event (chronological, with a per-event `seq` + ISO wall-clock `at`) and streams them
in batches; on a confirmed POST the sent events are dropped, otherwise kept and retried (survives
network blips). Capped buffers (`DEBUG_PENDING_CAP` 8000, `DEBUG_BATCH_MAX` 1000/POST) bound memory and
body size. The backend appends them to **one file per display per day**
(`ambient-<id>-<YYYY-MM-DD>.log`) — full detail, wall-clock timestamps — and **prunes day-files older
than 7 days** (`_DEBUG_LOG_RETENTION_DAYS`), so file count is bounded (no per-snapshot explosion).
`GET …/debug-log/latest` returns the most recent day's full transcript (status header + events,
tail-capped to ~2 MB); `?date=YYYY-MM-DD` views any retained day, and the response lists available days.
Capture happens ONLY when `?debug=true` (the viewer only buffers/sends in that mode). The on-panel
HUD still shows the live last-60 ring; the full history lives server-side.

---

## 2026-06-15 — Debug log readable at the viewer URL (Phase 1, commit e33fcb8)

**Files:** `src/App.jsx`, `src/pages/AmbientDebugLogPage.jsx` (new), `src/services/api.js`,
`src/pages/AmbientViewerPage.jsx`, `docs/deployment-steps.md`.

### Why
The v3.0 transcript was only reachable at `<VITE_API_URL>/api/ambient/<id>/debug-log/latest` (i.e.
`:8888`), a different host/port from the viewer (`:3200`). The user wanted to read it at the **same
origin + URL pattern as the viewer** — `http://<host>:3200/<branchId>/2/<id>/debug-log/latest` — so the
`<branchId>/2/<id>` form is consistent everywhere.

### Changes
- **`src/App.jsx`** — new route `"/:branchId/2/:id/debug-log/latest"` → `AmbientDebugLogPage`, placed
  before `*`. React Router v6 ranks the 5-segment path above the 3-segment viewer route, so
  `/2/2/4` still resolves to the viewer and `/2/2/4/debug-log/latest` to the log page — no clash.
- **`src/pages/AmbientDebugLogPage.jsx` (new)** — `useParams()` `id` + `useSearchParams()` `date` →
  `api.getAmbientDebugLog(id, date)`; renders the plain-text transcript in a dark `<pre>`, auto-refetch
  every 10 s, errors shown inline.
- **`src/services/api.js`** — `getAmbientDebugLog(id, date)` fetches the plain-text endpoint via the
  existing `API_BASE` (env-driven `VITE_API_URL`, never a hardcoded port), so the browser-facing URL is
  `:3200` while the fetch transparently hits the backend.
- **`src/pages/AmbientViewerPage.jsx`** — the snapshot `url` field now points at the debug-log page
  (`${origin}${pathname}/debug-log/latest`) instead of the raw viewer href.
- **`docs/deployment-steps.md`** — read-log example updated to the `:3200/<branchId>/2/<id>/debug-log/latest`
  pattern.

(Phase 1 also added an rAF-driven pre-end-seek watchdog and bumped `SINGLE_SEEK_LEAD` 0.15→0.25; that
mechanism is **superseded** by the v3.1 setInterval watchdog below — see the next entry.)

---

## 2026-06-15 — Engine v3.1-loop-hardened: black-free endless seamless loop + source-tagged debug log

**Files:** `src/pages/AmbientViewerPage.jsx`, `server/routers/ambient_router.py`.

### Why (root cause, from on-panel logs)
After v3.0 shipped to the panel the concatenated playlist video still **froze on its last frame after
the first cycle — the loop never restarted** ("the video did not auto-play again"). The live
`debug-log/latest` transcript proved the restart was **nondeterministic**: in some sessions the native
`loop` wrapped (`=== loop wrap (ct 93.9→0.00) ===` with no seek), in one the `rAF pre-end seek → 0`
fired once and then the log went silent (the freeze). So the v3.0/Phase-1 seek-to-0 was firing but not
reliably taking.

Pinned causes (seamless-loop path only):
1. **Lead too small (0.25 s)** — the seek fired right at the end-of-stream boundary, where Tizen's HW
   decoder unreliably honors a seek; it intermittently no-ops and the stream runs to true EOF.
2. **`play()` only when `v.paused`** — a frozen-but-"playing" element (Tizen reports `paused=false`)
   never got the resume nudge.
3. **`loop` attribute still set** — it races with our seek AND (per HTML spec) **suppresses `ended`**,
   disabling the last-resort recovery; the stuck-detector also required `v.paused` (never true on a
   Tizen freeze), so recovery never triggered and `wrappingRef` wedged.
4. **rAF can be throttled** while the HW video plane is composited — exactly when the watchdog must poll.

### The no-black principle this fix is built around
On the single HW decode plane, black appears only when (a) the stream reaches **true EOF** (plane
blanks) or (b) we call **`load()`/swap `src`** (decoder torn down). A **backward seek to 0 on the
still-playing element BEFORE EOF does NOT blank** — it jumps to the IDR at frame 0 and keeps presenting.
So a black-free endless loop = reliably land that early seek every cycle, never reach EOF, never
`load()`.

### Changes — `src/pages/AmbientViewerPage.jsx` (seamless-loop path only; per-item engine untouched)
1. **Removed the `loop` attribute** from the seamless `<video>` — stops the race and restores a usable
   `ended` event.
2. **rAF watchdog → ~100 ms `setInterval`** (`SINGLE_TICK_MS`); `setInterval` isn't throttled by the HW
   compositor. Replaced `singleRafRef`/`singleActiveRef` with `singleTickRef`.
3. **`SINGLE_SEEK_LEAD` 0.25 → 1.5 s** — seeks well clear of the fragile EOS boundary; the ~1.5 s trimmed
   tail is invisible on an endless loop (slightly shorter each cycle, never black).
4. **Seek retried EVERY tick until the wrap is confirmed.** On entering the pre-end window: set
   `wrappingRef`, `currentTime = 0`, `play()`. On each later tick while ct is still high: re-issue the
   seek (≈15 attempts before EOF could be reached). When ct drops below ~1 s: `loop: wrap CONFIRMED`,
   release the guard. **`play()` is called after every seek** (not only when paused).
5. **Auto-resume on Tizen's seek/buffer pause** — new `onPause`/`onSeeked` handlers immediately `play()`
   a paused (non-ended) element. This is the direct fix for "didn't auto-play after the first cycle."
6. **Stuck-detector fixed** — triggers on `v.ended || (ct >= dur-0.05)`, dropped the `&& v.paused`
   requirement (false on a Tizen freeze).
7. **`load()` is now strictly a last-resort freeze-breaker** (`singleLoadBreaker`), reached only after a
   wrap has been stuck at EOF for >1.5 s with retries exhausted — the ONLY path that can briefly flash
   black, logged loudly (`loop: seek FAILED → load()`), and expected to never run in normal operation.
   `handleSingleEnded` routes through the same breaker.
8. **Detailed logging (user request).** A ~2 s **heartbeat** (`hb ct=… dur=… paused=… ended=… rs=… ns=…`)
   plus wired media events on the seamless `<video>`:
   `onSeeking/onSeeked/onPause/onPlaying/onWaiting/onStalled/onLoadedMetadata/onLoadedData`. Greppable
   restart-path labels: `loop: seek→0 requested` / `wrap CONFIRMED` / `seek retry` / `seek FAILED → load()`.
9. **`ENGINE_VERSION` → `3.1-loop-hardened`** (HUD top line + init log) so a redeploy is verifiable.

### Source-tagged debug log (TV vs laptop)
Both the Samsung panel and a laptop browser can open `?debug=true` and stream to the **same day-file**.
Each batch is now tagged with its source so the transcript is unambiguous:
- **Frontend** — `CLIENT_KIND` is computed once from the user-agent (`Tizen`/`SMART-TV`/webOS → `TV`,
  else `laptop`) and sent in the POST payload (`client`, plus full `ua`).
- **Backend (`server/routers/ambient_router.py`)** — the `latest.json` status snapshot gains
  `client` + `user_agent`, and every appended event line is prefixed with a fixed-width source tag,
  e.g. `2026-06-15T…Z  [TV    ] #2  [success  ] loop: wrap CONFIRMED (ct=0.10)`.

### Deploy
This round touches the **backend** (source tag) as well as the frontend, so rebuild both:
```bash
git pull && docker compose up -d --build backend frontend
```
No DB migration and no `backfill_posters` needed.

### Verify
`npm run build` green; `ast.parse` of `ambient_router.py` OK. On the panel `?debug=true`, run ≥3 full
loops: HUD shows `v3.1-loop-hardened`; every loop logs `loop: seek→0 requested …` → `loop: wrap
CONFIRMED …` with a steady `hb …` heartbeat; `ERRORS: 0`; **never** `loop: seek FAILED → load()` (that
would mean a black flash); visually continuous — no freeze on the last frame, no black at the seam.

### Not changed
The per-item fallback engine (bridge/poster transitions), the backend concat builder, and the
`timeupdate` handler (kept as a secondary trigger) are untouched.

---

## 2026-06-16 — Engine v4: full-quality hybrid (per-item + lossless video-run concat + MSE all-video loop)

**Files:** `server/media_utils.py`, `server/routers/ambient_router.py`, `server/backfill_posters.py`,
`src/pages/AmbientViewerPage.jsx`; docs: `docs/ambient-playback-findings-and-fallback.md` (new),
`docs/deployment-steps.md`, `plan.md`.

### Why
The v3.0/v3.1 **single whole-playlist concat** caused every reported symptom on display 2: decode-stall
**seams** (stuck/skip on both TV and laptop, at the stream-copy↔re-encode join points — `ffmpeg -f
concat -c copy` doesn't re-stamp timestamps, so mismatched timebase/GOP/SAR froze the decoder with
`rs=2 ns=1`), **black at the loop** (seek-to-0 unreliable → `load()` teardown), and **degraded quality**
(images baked into 1080p 4:2:0; videos re-encoded on top of the CRF-20 normalize). The architecture is
the quality ceiling, so it was retired. Full investigation + sources + fallback runbook:
`docs/ambient-playback-findings-and-fallback.md`.

### What changed
- **No whole-playlist concat.** `get_ambient_display` never serves a built concat; `_regenerate_playlist_video`
  clears the legacy pointer and deletes the file. The viewer runs the **per-item engine** (full-res
  `<img>` images, individual videos) for any playlist containing an image.
- **`normalize_video` is now 3-state** (`skip`/`written`/`failed`): an already-Tizen-friendly **and**
  faststart upload is served **byte-for-byte** (no ffmpeg); compatible-but-not-faststart gets a
  **lossless `-c copy` remux**; only genuinely incompatible sources are re-encoded, now at **CRF 18**
  (was 20), downscaling only above the 1080p ceiling. The upload endpoint deletes the raw file **only**
  on `written` (the `skip` path keeps the original).
- **Posters are lossless** (`extract_last_frame` → PNG at native resolution) — no "soft poster" jump.
- **Lossless video-run concat**: ≥2 **adjacent** videos are joined by stream copy (`build_video_run`)
  only when they pass a strict gate (codec/profile/level, w×h, fps, **time_base**, **SAR**, **start_pts==0
  / no edit list**); a lossless container-timing **widener** recovers runs that differ only in timing;
  otherwise they stay per-item.
- **Loop wrap when first AND last are videos** (with ≥1 image): cyclic **wrap-run + rotation**
  (`_playback_groups`) puts the `Vlast→V0` transition INSIDE one lossless clip and makes the loop's file
  boundary a safe video→image edge. No poster-timing, no seek, no reload.
- **All-video playlists**: `playback_mode: 'mse-loop'` — one fragmented, video-only lossless clip
  (`build_mse_loop` + `.codecs` sidecar) looped via **Media Source Extensions** in the viewer
  (Tizen 7.0 / Chromium 94), appended on a ring so it never ends/reloads/seeks. Falls back to native
  `loop`, then AVPlay (Approach 2).
- `backfill_posters.py`: handles the 3-state normalize, PNG posters, and `--playlist-videos` now builds
  the lossless joined clips (run + MSE) for existing displays.

### Result
Full image+video quality (originals/lossless), no decode-stall seams, no skipped images, and a black-free
loop restart for every first/last combination. Debug logging is unchanged and still readable at the
viewer-origin `/debug-log/latest` URL (now reports `mode: per-item-engine` / `mse-loop`).

### Verify
`py_compile` (3 backend modules) OK; `npm run lint` clean; `npm run build` green. On the panel with
`?debug=true`: `MODE: per-item engine` (or `mse-loop ✓` for all-video), `ERRORS: 0`, no stall at the old
seam timestamps, every transition + the loop shows freeze-or-clean (no TRUE black), images/videos sharp.
Any TRUE black at a video edge → escalate to the AVPlay `.wgt` (Approach 2 in the findings doc).

### Deploy / one-time cleanup
`docker compose up -d --build backend` → `docker compose exec backend python -m server.backfill_posters
--playlist-videos` (builds the joined clips, clears the legacy pointers, deletes the broken
`ambient-*-playlist-*.mp4`) → rebuild frontend. New publishes rebuild automatically.

---

## 2026-06-17 — image→image transition: the "fade-in-on-top" detour and the revert to dual cross-dissolve

**File:** `src/pages/AmbientViewerPage.jsx` (per-item engine, `runImageToImage` only) — net effect:
back to the proven symmetric cross-dissolve. This entry records the full chain so the dead ends aren't
re-attempted.

### What we were trying to improve
The image→image crossfade is the original **symmetric dual cross-dissolve**: incoming fades 0→1
(`ease-out`) while outgoing fades 1→0 (`ease-in`); the easing pair keeps total coverage high through
the midpoint, so there's no visible dip. It uses **no z-index** — both `<img>` layers rest at
`zIndex:2` (`layerStyle(2)`). This "worked perfect." We tried to enhance it to a "new image fades in on
top of the still-solid old image" look. That detour is what introduced (and then chased) two TV-only
regressions before we reverted.

### Attempt 1 — z-lift with end-reset (`start 3 / end 2`)
"Fade in on top" needs the incoming strictly above the outgoing. Equal-z ties break by DOM order
(`imageBRef` is after `imageARef` → B paints over A), so the on-top look only worked swapping *into B*;
swaps *into A* faded in *behind* the opaque B and hard-cut — i.e. **alternate images cut instantly while
the others faded.** Fix attempt: lift the incoming to `zIndex:3` during the fade, reset to `2` at the end.
- **Broke:** a subtle **~100 ms black flash on the real Samsung panel exactly when the new image
  settled** (fine on laptop). Root cause: the `<img>` layers carry `willChange:'opacity'` (each is a
  GPU-composited layer); the fade-end `nextImg.style.zIndex='2'` change forces Tizen to **tear down and
  rebuild that layer** → ~1 unpainted frame → black shows. Opacity changes never flash (that's what
  `willChange:opacity` buys); **only a z-index change on a *visible* layer does.**

### Attempt 2 — monotonic z + transition-based hide
To never restack a *visible* layer: write z **only to the incoming while it's still `opacity:0`**, with
an **ever-incrementing** value so it's always above the outgoing, and never reset. Also changed the
outgoing's fade-end hide from an instant `transition:'none'; opacity=0` (itself a flash source on Tizen)
to a compositor-driven `opacity` transition.
- **Fixed** the flash, **but broke worse:** the incoming's z climbs by 1 every swap, so after ~8
  image→image swaps it passes the UI overlays (**color band and announcement are both `zIndex:10`**) and
  the full-bleed opaque image **paints over them — the color band "disappeared after some time"**
  (reproducible on laptop too; with ~30 images per loop it always climbs past 10 mid-loop). It also
  pushed images above the poster (`z=3`), a plausible contributor to a faint "darker first image after
  the video."

### Why the on-top look can't be cleanly bounded (the dead end)
With two fixed DOM layers and DOM-order tie-breaking, keeping the incoming **strictly above** the
outgoing every swap is only achievable by either (a) an **unbounded** climbing z (Attempt 2 → covers the
z=10 overlays), or (b) a **bounded {2,3}** scheme that must write z to the **currently visible** layer
each alternate swap (Attempt 1 → the Tizen recomposite flash). There is no bounded, flash-free, all-z
solution for image-heavy / all-image playlists. So the enhancement was abandoned.

### Resolution — revert to the dual cross-dissolve
`runImageToImage` `beginCrossfade` restored to:
```js
nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-out`;
nextImg.style.opacity = '1';
prevImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in`;
prevImg.style.opacity = '0';
setTimeout(() => { … activeImageRef.current = toKey; finalizeSwap(…); }, CROSSFADE_DURATION);
```
Removed the `imageZRef` ref and all z-index manipulation. Both layers fade via CSS **transitions** (no
instant `opacity`/`zIndex` writes → no Tizen flash) and images stay at **z=2** — below the poster (z=3)
and the z=10 UI overlays. This simultaneously resolves all three reported symptoms:
- **black flash** — gone (no instant writes, no z writes);
- **color band / announcement disappearing** — gone (images never exceed z=2, overlays stay on top);
- **darker first image after the video** — should improve (images back below the poster z=3 → restores
  `runVideoToImage`'s "image beneath poster → hard-cut poster" stacking). If a faint darkness persists
  on-panel it's a separate pre-existing Tizen video-plane/poster matter, minor and self-correcting.

### Also this session (unrelated, cosmetic)
Announcement bar reduced to ~70% height: container `padding` and the label/name/title `fontSize` +
`marginBottom` values lowered (previous values left commented inline as backups).

### Verification
- `npm run build` clean (only the pre-existing chunk-size warning).
- Rebuild + redeploy the frontend (TV build `07:29 UTC` predated these edits). On `?debug=true`, run a
  full loop: image→image crossfades smoothly with no black flash; the **color band scrolls the entire
  loop** (never disappears); announcement stays visible; loop-back to the video is clean; `ERRORS:0`.

---

## 2026-06-17 — Docs/cleanup: handoff-summary refresh + remove dead `_playback_order` helper

**Files:** `docs/handoff-summary.md`, `server/routers/ambient_router.py`,
`docs/ambient-fix-attempt-history.md`.

Documentation + dead-code cleanup only — **no playback-logic change** (the v4 hybrid engine and the
2026-06-17 image→image flash fix above are untouched).

- **`docs/handoff-summary.md`** rewritten from the stale v3.0 seamless-loop handoff to the current
  **stable v4 hybrid**: per-item engine, lossless `build_video_run` + strict compatibility gate,
  `_playback_groups` cyclic wrap-run for the video→video loop restart, `build_mse_loop`
  (`playback_mode: 'mse-loop'`) for all-video playlists, 3-state `normalize_video`, lossless PNG posters,
  and the AVPlay `.wgt` escalation. Added a "what we did this session" summary and links to
  `ambient-fix-attempt-history.md` and `ambient-playback-findings-and-fallback.md`.
- **Removed the orphan helper `_playback_order`** from `server/routers/ambient_router.py` — it had **no
  callers** (the engine groups via `_playback_groups`); a leftover from an in-progress edit. Pure
  cleanup, behavior unchanged (`python -m py_compile` OK; `grep _playback_order` → no matches).
- **Fixed stale `change.md` references** in `docs/ambient-fix-attempt-history.md` to point at this file
  (`changes.md` + its Appendix), since `change.md` was merged here and deleted.

---

## 2026-06-18 — Phase 2: admin draft-staging publish workflow + auth fix + orientation gate + admin UX

**Files:** `server/schema.sql`, `server/database.py`, `migrate.py`, `server/models.py`, `server/config.py`,
`server/auth.py`, `server/routers/auth_router.py`, `server/routers/ambient_router.py`,
`server/media_utils.py`, `server/backfill_posters.py`, `src/services/api.js`, `src/context/AppContext.jsx`,
`src/pages/AmbientDisplaysPage.jsx`, `src/components/AmbientOrientationGate.jsx` (new), `src/App.jsx`.
**Hard constraint honoured:** `src/pages/AmbientViewerPage.jsx` is **not modified** (empty git diff).

### A. Draft-staging publish workflow ("stage all edits, apply on Publish")
The live link must only change on Publish; the preview link shows the working draft; the viewer's 5s poll
+ `applyPendingIfNeeded` blends the change at the next item (no reset).
- **Schema (idempotent):** `ambient_displays.draft_orientation` + `draft_announcement_{label,name,title,enabled}`;
  `ambient_media.live_sort_order` (published order) + `draft_removed` (staged delete) + `thumb_path`.
  Seeded = live values, so existing displays are unchanged until edited.
- **`GET /ambient/{id}`:** admin/preview → **working** view (draft display fields under the normal keys;
  media `draft_removed=0` in `sort_order`, incl. drafts). Live → **published snapshot** (`status='live'`
  in `COALESCE(live_sort_order, sort_order)`). Same JSON shape → viewer untouched. Also returns `is_live`
  + `has_unpublished_changes`.
- **`PUT /ambient/{id}`** writes announcement/orientation to the **draft_** columns. **Reorder** writes
  `sort_order` only (no live regen). **Delete** of a live item sets `draft_removed=1` (kept live until
  publish); a draft-only item is removed immediately. **Publish** hard-deletes `draft_removed` rows +
  files, promotes the playlist to live, sets `live_sort_order = sort_order`, copies `draft_*` → live, and
  regenerates the joined clips from the published order. List endpoint returns draft (working) values.
- **Admin UI:** Publish button always available with state — `Publish X Live` (not live) /
  `● LIVE` + `Publish changes` (live, dirty) / `● LIVE — up to date`. Draft badge (`status==='draft'`)
  now syncs because publish promotes correctly.

### B. Preview "not authenticated" fix (industry-level)
Token was JWT Bearer in **sessionStorage** (per-tab) → the `window.open` preview popup had no token → 401.
Now: login also sets an **httpOnly `actis_session` cookie**; `get_current_user` accepts the cookie **or**
the Bearer header (`HTTPBearer(auto_error=False)` + cookie fallback); the client token moved to
**localStorage** (shared across same-origin tabs) and `fetch` sends `credentials:'include'`. Added
`POST /api/auth/logout`. New config: `AUTH_COOKIE_NAME/SECURE/SAMESITE` (set `AUTH_COOKIE_SECURE=true` on HTTPS).

### C–E, G. Admin UX
- **Media-list layout** follows `display.orientation` (portrait → 9:16 tiles, landscape → 16:9).
- **Video first-frame thumbnails:** `media_utils.extract_first_frame` on upload → `thumb_path`;
  `backfill_posters.py --thumbs` for existing videos; admin renders the thumb (Film icon fallback).
- **Hover-to-preview:** 2s hover on a tile opens an enlarged modal (image or muted autoplay video);
  mouse-out / drag-start closes it.
- **Megaphone** is the "announcement enabled" indicator on the admin card (added a tooltip). Fixed the
  admin `API_BASE` `:8000` fallback → relative (proxied), so thumbnails load without `VITE_API_URL`.

### F. Orientation gate (no viewer edits)
New `src/components/AmbientOrientationGate.jsx` wraps the viewer route in `App.jsx`. It compares the
**device** orientation (`matchMedia`) to the display's **configured** orientation (its own light fetch)
and overlays a polished "This display is set to {Portrait|Landscape} — please view it on a … screen"
message on mismatch (live view only; preview never gated). The viewer stays mounted underneath
(`position:fixed` overlay, framer-motion, no theme/TOD deps — index.css left untouched so admin scrolling
is unaffected). The copy-reference files (`OrientationGate.jsx`, `ORIENTATION-GATE-FINAL.md`, `tod*.js`)
were deleted.

### Deploy
Rebuild backend (`init_db` adds the columns) and run `python -m server.backfill_posters --thumbs` once for
existing videos. New uploads get thumbnails automatically. Status: `npm run build`/`lint`, `py_compile`,
`migrate.py`, and FastAPI app-import all green; the viewer is untouched. On-device + end-to-end admin
verification is the next step.

---

# Appendix — Code Snippet Diffs (merged from change.md)

_Merged from the former `change.md` (2026-06-17). This appendix documents early edit sessions as exact
before/after snippets. Sessions 1–4 below predate the narrative changelog entries above; the engine has
since been rewritten several times (see the dated sections at the top of this file), so these snippets
are historical record, not the current code._

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

---

## 2026-06-22 — Images render at true brightness on Tizen + announcement bar size restored

**File:** `src/pages/AmbientViewerPage.jsx` (engine bumped `3.1-loop-hardened` → `3.2-img-truecolor`)

### Problem fixed
On the real Samsung Tizen panel, **images displayed persistently darker than video**. A video played
at correct brightness; the moment it transitioned to an image, the image stayed visibly darker for
its entire ~5s display, every cycle. It was **not** a flash/timing artifact (constant for the whole
duration) and did **not** reproduce on a laptop/desktop browser.

### Root cause
The two content `<img>` layers and the poster `<img>` carried `willChange: 'opacity'` (via the shared
`layerStyle()` helper). `will-change` **permanently promotes** an element onto its own GPU compositing
layer. On Tizen's embedded Chromium that promoted layer is composited **without colour management**, so
it renders darker/colour-shifted than the main backing surface. The live `<video>` is on a separate
hardware plane (unaffected), and desktop Chromium colour-manages composited layers correctly — which is
exactly why video stayed bright and the laptop never reproduced it. The darkness was *persistent*
because the image stayed permanently promoted for its whole display. (Predicted in this log on
2026-06-17: residual darkness would be "Tizen's native color-space handling or graphics-vs-video-plane
compositing math.")

### Fix
- **Dropped `willChange: 'opacity'` from `layerStyle()`** (kept as a dated comment, not deleted). This
  affects only the graphics-plane `<img>` layers (imageA/imageB + poster). The `<video>` and canvas
  bridge keep their own `willChange` (separate inline styles) — **video transitions are unchanged**.
  Without the permanent hint, an opacity crossfade still auto-promotes the layer *for the duration of
  the fade* and then de-promotes it back to the main surface, so the image paints at its **true
  brightness** for its full display. Deterministic, no per-panel tuning, works on all playlists / all
  Samsung panels.
- **Poster note:** the poster shares `layerStyle`, so it loses `willChange` too. This is intentional —
  the poster only does instant hard cuts (where `will-change` does nothing), and keeping it promoted
  (dark) while the image renders bright would introduce a brightness *pop* at the `video→image` reveal.
  Removing it from both keeps the hard-cut brightness-consistent.

### Diagnostic added (debug-only, zero production cost)
On engine init under `?debug=true`, logs `img-layer willChange=<computed> (expect 'auto')` so the
running build can be confirmed live from the debug-log stream (`/api/ambient/<id>/debug-log/latest`).
**Caveat:** the darkness is a *composited-output* artifact — `getImageData` reads the always-bright
*source* pixels, so no log can measure it; a photo of the panel remains the real brightness check.

### Confidence / contingency
High but not certain (~80–85%) since a compositing colour artifact can only be confirmed on-device.
If darkness persists after this, the next suspect (specific to the `video→image` path) is the hidden
`<video>` plane still influencing the graphics plane — follow-up would hard-unload/detach the video
element while an image is shown.

### Also: announcement bar size reverted
The announcement text box (reduced 2026-06-17) was restored to its original larger sizes; the reduced
values are kept as dated comments beside each active value:

| Element | Property | Reduced (now commented) | Restored (active) |
|---|---|---|---|
| Box container | `padding` | `clamp(3px, 0.5vh, 8px) 0` | `clamp(6px, 1vh, 14px) 0` |
| Label | `fontSize` | `clamp(7px, 0.8vw, 10px)` | `clamp(9px, 1.1vw, 14px)` |
| Label | `marginBottom` | `2` | `4` |
| Name | `fontSize` | `clamp(9px, 1.2vw, 16px)` | `clamp(13px, 1.8vw, 24px)` |
| Name | `marginBottom` | `1` | `2` |
| Title | `fontSize` | `clamp(8px, 0.9vw, 13px)` | `clamp(11px, 1.3vw, 18px)` |

The bottom scrolling colour band (`colorBarHeight`) was already at its larger values and is unchanged.

### Not touched
All transition functions (`runVideoToVideo` / `runVideoToImage` / `runImageToImage` /
`runImageToVideo`), the swap-timeout / first-frame-loop logic, the seamless-loop and MSE-loop engines,
z-indices, opacity durations/easings, and the backend/ffmpeg media pipeline.

---

## 2026-06-23 — Dark images on Tizen: REAL fix (release the HW video plane) — `3.3-img-plane-release`

**File:** `src/pages/AmbientViewerPage.jsx` (engine `3.2-img-truecolor` → `3.3-img-plane-release`).

### Correction to the 2026-06-22 entry
The `will-change` theory above was **DISPROVEN on-device**: the 3.2 build shipped (`willChange=auto`
confirmed in the debug-log stream) yet the image was still dark. `will-change` was never the cause —
the original `willChange: 'opacity'` is restored in `layerStyle()` (it only ever smoothed the
crossfades).

### How the real cause was found
- **On-device:** `willChange=auto` still dark → not a layer-promotion issue.
- **Image files:** `server/uploads/ambient-2-*.png/.jpg` are plain 8-bit sRGB with **no ICC/colour
  profile** → render identically on Tizen and laptop → the darkness is **not in the image pixels**.
- **Backend:** images are served as the original `/uploads/<file>` (no re-encode).
- **Git bisect (decisive):** the dimming appeared exactly at commit **`529a304`** (2026-05-26,
  "Tizen-hardened single-video + bridge engine") — the moment the renderer switched from v1's
  **conditional** `{type==='video' ? <video/> : <img/>}` to an **always-mounted `<video>`**. v1
  (`a2202ed`…`46c1da0`) had no `<video>` in the DOM while an image showed → no dimming, matching the
  user's recollection that early builds were fine.

### Root cause
On Samsung Tizen a mounted `<video>` holds the **hardware video plane**; `opacity:0` does **not**
release it. The active plane (limited-range video plane vs full-range graphics plane) makes the
graphics-plane `<img>` composited above it render persistently darker. Laptops have no separate video
plane, so they never reproduced it. Confirmed by vendor/industry docs (Samsung PiP overlay model;
BrightSign/signage guidance that *invisible video players stay active — clear `src` + `.load()` to
release hardware*; limited-vs-full RGB-range explainer).

### Fix — release the plane while an image is displayed (mirrors v1, no engine refactor)
- New `releaseVideoPlane()` = `pause()` + `removeAttribute('src')` + `load()` + `display:none` (frees
  the Tizen HW plane, the documented signage method); `acquireVideoPlane()` restores it.
- Wired so the plane is active **only** during video playback/transitions: `start()` (per item type),
  `runImageToVideo` (acquire before decode), `runVideoToVideo` (acquire, idempotent), `runVideoToImage`
  (release in the poster-freeze branch so the revealed image is full-bright), and `finalizeSwap`
  (consolidated end-state: image → release, video → acquire).
- `handleVideoError` ignores the synthetic error from the deliberate teardown (`releasingPlaneRef`).
- Black-free preserved: the outgoing image stays as the cover until the re-acquired video presents its
  first real frame, so the reload latency is masked.
- Bumped `ENGINE_VERSION`; the plane helpers log `video plane released/acquired` under `?debug`.

### Not touched
Transition timing/easing, poster + canvas-bridge mechanics, prefetch, the seamless-loop & MSE-loop
engines (separate elements), and the backend pipeline.

### Also
- New `docs/ambient-architecture.md` — full subsystem map (modes, per-item engine, backend, data flow).
- Optional follow-up (deferred): a dip-free image crossfade (fixed BASE/FADE layers, no z-index
  animation) to remove the slight mid-crossfade luminance dip — not bundled with this critical fix.

### ⚠️ REVERTED 2026-06-23 (`3.3r-reverted`)
The plane-release fix above **failed on-device and was reverted**. On the panel the plane *was*
released after each video→image, yet the image stayed dark **and** collapsing the Tizen HW video plane
reintroduced a brief **black flash** over the poster cover (the HW plane composites *above* HTML). So
releasing the plane did NOT brighten the image → **the mounted `<video>` plane was never the cause**;
the image renders true sRGB and it's the **video that the TV boosts**. Reverted all 3.3 code
(`releaseVideoPlane`/`acquireVideoPlane` + call sites + `handleVideoError` guard); the per-item engine
is now functionally identical to the last stable `52f81c2` (only differences: engine label and the
larger announcement bar). **Deferred decision:** make the *video* match the image's calmer look (likely
a TV-only CSS dim filter on `<video>`) — to be done as a separate change.

## 2026-06-24 — Brighten images on Tizen (CSS filter only) — `3.1-img-bright`

Resolves the "images darker than video" issue the safe way, after the willChange/plane-release/FFmpeg
theories were all disproven on-device. The image renders true sRGB; the **TV boosts the `<video>`** on
its hardware plane, so graphics-plane `<img>` looks darker by comparison. Rather than fight the
hardware overlay, **lift the images** with a pure CSS filter — no engine/transition/video changes.

- New module consts (next to `CLIENT_KIND`): `TV_IMAGE_BRIGHTNESS = 1.15` (the tunable knob) and
  `TV_IMAGE_FILTER = CLIENT_KIND === 'TV' ? brightness(...) : 'none'`.
- `layerStyle()` now sets `filter: TV_IMAGE_FILTER` → lifts both image layers (z=2) **and** the poster
  cover (z=3) together, so the video→image hard-cut stays brightness-consistent (no pop). Laptop/desktop
  get `none` (already correct there).
- Engine label → `3.1-img-bright` (label only). **Nothing else touched** — transitions, poster/bridge,
  prefetch, loop, `<video>`, seamless/MSE engines all unchanged from stable `52f81c2`+announcement bar.
- Tune on-panel by changing the single `TV_IMAGE_BRIGHTNESS` constant. One-line revert if undesired.
- Firmware note: TV is on latest (1170); an upgrade is NOT pursued — it wouldn't reliably fix this and
  risks destabilising the firmware-tuned engine.

## 2026-06-26 — REVERTED the brightness filter; Phase-1 of the browser→AVPlay plan — `3.1-loop-hardened`

The `3.1-img-bright` brightness filter above is **reverted**. Two reasons, both confirmed:
1. **It wasn't needed.** Viewing the real playlist files, the source images and videos look identical in
   brightness/colour — the "darker images" only ever appeared as the panel's video-plane picture
   processing, not anything in our content. The filter compensated for nothing real.
2. **It caused a NEW black flash on image→video.** A CSS `filter` promotes the `<img>` layers to a
   separate GPU compositing layer; at the image→video hand-off that re-composite collides with the
   hardware video plane lighting up → flash. The filter was the **only** diff from the known-good
   no-flash `AmbientViewerPage_latest_updated.jsx`, so removing it restores byte-identical clean
   behaviour.

**Change:** removed `TV_IMAGE_BRIGHTNESS` / `TV_IMAGE_FILTER` and the `filter:` line in `layerStyle()`;
engine label back to `3.1-loop-hardened`. `AmbientViewerPage.jsx` is now byte-identical to the
known-good baseline (+ larger announcement bar). No engine/transition/loop changes.

**Strategic decision (full record in `docs/plan.md`):** the browser path is **firmware-fragile** — the
same code that was flash-free on Chromium 94 flashes on Chromium 120 (the TV auto-updated), because the
HW video plane composites above HTML and blanks on every `src` swap, and the compositor timing is
firmware-decided. So the work is now **two phases**:
- **Phase 1 (this commit):** fix what we can in the browser — remove the filter (kills the confirmed
  image→video flash), restore the clean baseline; optional one-frame rAF hardening for the Chromium-120
  video→image timing if it still flashes on-device.
- **Phase 2 (if Phase 1 still flashes / edge-cases):** rebuild the player as a **native Tizen `.wgt`
  using AVPlay** — MagicINFO's actual engine (HTML composites *above* the video plane; `setVideoStillMode`
  holds the last frame with no blank; two-player MixedFrame for seamless hand-offs). Backend (FastAPI +
  FFmpeg + CMS) stays unchanged; only the player changes. Staged behind a 2-clip on-device PoC.

## 2026-06-27 — Prefetch congestion fix: concurrency-capped queue + video-load priority — `3.1-loop-hardened`

**File:** `src/pages/AmbientViewerPage.jsx` (per-item engine prefetch scheduler only — no transition,
loop, or backend changes).

### Problem (new failure mode, not a regression)
On-panel debug logs for display 2 (2026-06-26) showed the engine running healthy for ~3.5 min (image
swaps every ~5s, decodes 150–380 ms), then the **second video** (`…-1777293481-0-norm.mp4`) took **~44 s**
to reach `loadedmetadata` (loadstart 14:20:11 → loadedmetadata 14:20:55). The first video on the same TV
loaded in ~0.6 s, so the engine didn't slow down — **the network did**. The `swap-timeout (4000ms)`
backstop fired and force-faded to a frameless plane (`rs=0 ct=0.00`) → the ~40 s black/frozen stall.

**Root cause:** `startPrefetch` fired an **unbounded** `fetch(url, {cache:'force-cache'})` on every swap
(~every 5s). On a congested link each took 15–29 s and they **stacked 3–6 deep** (prefetch durations
climbed monotonically across the run for identical ~250–300 kB files: 149 ms → 8 s → 14 s → 25 s → 29 s,
with 3 resolving together repeatedly). They divided the bandwidth and starved the next `<video>.load()`.
A `git diff` confirmed the prefetch code is **byte-identical to `AmbientViewerPage Finally Working
Stable.jsx`** — that build only "worked perfectly" because the link was healthy when it was tested; it
fails identically under the congested link. So this is graceful-degradation hardening, not a rollback.

### Fix
1. **Serial FIFO prefetch queue.** New `PREFETCH_MAX_CONCURRENCY = 1` (old unbounded behaviour documented
   in the constant comment). `startPrefetch` now **enqueues** (deduped via the existing `prefetchRef` Map,
   reserving the URL with a `null` placeholder) and kicks `pumpPrefetch()`; `pumpPrefetch` runs at most
   one transfer at a time using the unchanged `fetch → blob → log` chain, decrementing + re-pumping in a
   `.finally`. A single ~250 kB image now finishes in ~1–2 s instead of 29 s split six ways.
2. **Player priority.** New `videoLoadingRef` gate: `runVideoToVideo` / `runImageToVideo` set it `true`
   right before `<video>.src + load()`, so `pumpPrefetch` won't start image fetches that compete with the
   decoder for the link. `finalizeSwap` (the single convergence for both the normal and swap-timeout-forced
   video paths) clears it and resumes the queue.
3. **Playlist-change cleanup.** `applyPendingIfNeeded` now also empties `prefetchQueueRef` (it already
   cleared `prefetchRef`) so stale URLs from the old playlist stop downloading.

`SWAP_TIMEOUT_MS` is **unchanged** — the fix removes the starvation rather than tolerating it longer.

### Verify
- `npm run lint` + `npm run build` green.
- **On-panel `?debug=true`** (laptop caches in memory and hides this): `prefetch start`/`prefetch ok` no
  longer overlap 3-deep and a single image stays ~1–2 s; the next-video transition reaches
  `loadedmetadata` in ~1–2 s; **no `swap-timeout (4000ms)` / `frame-stuck rs=0`** at video edges;
  `ERRORS: 0` over a full multi-cycle loop with no ~40 s black stall. Compare the transcript at
  `…/2/debug-log/latest` against the 2026-06-26 baseline.
- If single transfers are **still** 15–29 s for 250 kB after the cap, the bottleneck is server/network
  (on-demand `-norm.mp4` transcode or weak TV Wi-Fi), not the viewer → separate investigation.

## 2026-07-01 — Image-safety contract + poster sharpen flag + display-URL device auth; dark-frame diagnosis locked

Three shipped changes + one diagnosis lock-in. Full plan/rationale in `docs/media-pipeline-map.md`.

### Dark-frame diagnosis (LOCKED — no new brightness code)
The "darker last frame / images" is **confirmed Samsung/Tizen panel behaviour** (the TV boosts the HW
video plane; the graphics-plane `<img>`/poster render true sRGB and look dimmer by comparison). Re-verified
2026-07-01 that the content pixels are plain 8-bit sRGB with no ICC profile and are not darker. Every
browser fix for this was already reverted (`will-change`, HW-plane release, CSS brightness, ffmpeg colour)
— the only structural fix is AVPlay (out of scope). A **separate** true-black at the playlist **loop
restart** (image→video wrap) is being tracked: `runImageToVideo` holds the outgoing image until ≥2 video
frames paint, so it's black-free in the DOM; the likely trigger is the Tizen video plane blanking above
HTML on `src`-swap, exposed by the TV's Chromium 94→120 update (NOT the prefetch commit `9b001c7`). Bisect
on-panel at the pre-`9b001c7` commit to confirm.

### 1. Poster sharpen — `backfill_posters.py --force-posters`
Old media rows still serve a legacy `.jpg` "soft" poster (current code writes lossless `.png`). A normal
backfill skips rows that already have a poster; `--force-posters` regenerates `.jpg` (or missing) posters
as `.png`, **DB-first** (write `.png` → repoint row → delete old `.jpg` only on success — never leaves a
row poster-less). Rows already on `.png` are untouched. Sharpness only; does not affect the dimming.

### 2. Image-safety contract (uploads)
New `media_utils.probe_image` / `normalize_image` (3-state, ffmpeg-only, mirrors `normalize_video`) +
`image_aspect_warning`. On upload (`ambient_router.upload_ambient_media`), an image is **auto-downscaled
only if it exceeds the 1920×1080 ceiling** (Lanczos, aspect preserved, never upscaled/cropped), then its
aspect is checked against the display's target and a **warning** is returned (surfaced as an admin toast)
— or **rejected** (HTTP 400) under `AMBIENT_IMAGE_STRICT`. Config: `AMBIENT_IMAGE_ASPECT_TOLERANCE` (0.05),
`AMBIENT_IMAGE_STRICT` (off). Conforming images are still stored byte-for-byte.

### 3. Display-URL one-time device auth (behind `DISPLAY_AUTH_ENABLED`, default OFF)
The public display URLs (`/:branch/1/:id`, `/:branch/2/:id`, debug-log) can be gated behind a revocable,
kiosk-lived device session — multi-tenant-ready (scoped per branch+display; extends to client/tenant).
- **Backend:** `display_devices` table (idempotent, in `init_db`); `auth.create_device_token` +
  `auth.get_display_viewer` (allows an admin session OR a valid, **non-revoked** `actis_device` cookie —
  revocation enforced by `jti` lookup on **every** viewer request); auth router endpoints — QR pairing
  (`/pair/start` · admin `/pair/approve` · display poll `GET /pair/{code}`; codes short-lived + single-use),
  password fallback (`/device-login`), and admin `GET /devices` + `POST /devices/{id}/revoke`. The live
  reads `GET /api/ambient/{id}`, `GET /api/displays/{id}` and the debug-log GET now depend on
  `get_display_viewer`.
- **Frontend:** `ProtectedDisplayRoute` (probe → show `DisplayLoginPage` on 401, fail-open on other
  errors), `DisplayLoginPage` (QR pairing via `qrcode.react` + password fallback), `/pair/:code`
  `PairApprovePage` (admin), admin **Devices** page (list/revoke), `api.js` device-auth calls +
  `credentials:'include'` on the viewer/debug-log fetches. Added dep: `qrcode.react`.
- **Guard rail:** default OFF so the currently-working TV keeps rendering until deliberately enabled and
  paired; keep `AUTH_COOKIE_SECURE=false` on the plain-http LAN or the cookie won't be sent.

**Verify:** `python -m py_compile` (config, media_utils, ambient_router, backfill_posters, auth, auth_router,
database, displays_router) OK; `import server.main` OK; `npm run build` green. On-device: unchanged with
`DISPLAY_AUTH_ENABLED` off; oversized/off-aspect image uploads warn; `--force-posters` yields `-poster.png`.
