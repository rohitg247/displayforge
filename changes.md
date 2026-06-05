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
