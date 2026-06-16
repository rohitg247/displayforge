# Ambient playback — full fix-attempt history (what was tried, why it failed, what came next)

_Authored: 2026-06-16. Companion to `docs/ambient-playback-findings-and-fallback.md` (which has the
shipped design + sources). This file is the chronological causal chain: each attempt, the evidence that
it failed, and why that pointed to the next one. Sourced from `changes.md`, `change.md`, and the git
history of `src/pages/AmbientViewerPage.jsx`._

## How to count this
There are **9 documented fix rounds before the current one**, so the 2026-06-16 hybrid is the **10th
overall**. Grouped by *strategy* (the three mid-May "pre-decode the next clip" rounds are one idea), it
is the **8th distinct approach**. Numbered below as rounds 1–9 (prior) + round 10 (current).

The problem throughout: on the Samsung **Tizen browser** there is one hardware video decoder, the HW
video plane composites *above* HTML, `canvas.drawImage(video)` returns black, and a hidden `<video>` is
not decoded — so every `<video>.src` swap costs a ~1.3–1.6 s black gap that cannot be pre-warmed or
covered by a canvas. These walls are *why* each attempt failed the way it did.

---

### Round 1 — Pre-buffer (dual-layer, hidden frame-0 freeze) · 2026-05-11 · `20c9794`
- **Tried:** two stacked layers; decode item N+1 on the inactive (`opacity:0`) layer and freeze it at
  frame 0, then flip on transition.
- **Failed because:** Tizen WebKit **does not decode a `<video>` on an `opacity:0` layer**, so the
  "pre-buffered" clip had nothing decoded at flip → black/stall. (Worked on laptop, which caches in
  memory — hiding the bug.)
- **Led to →** guard the flip path and add a time-based readiness fallback (Round 2).

### Round 2 — Pre-buffer hardening (onCanPlay mutex + 300 ms fallback) · 2026-05-12
- **Tried:** `prebufferFrozenRef` mutex against re-entrant `onCanPlay`, `expectedLayerRef=-1`, and a
  300 ms "treat as ready" timeout.
- **Failed because:** `onCanPlay` **never fires for a hidden-layer video** on the panel, and the timeout
  marked it "ready" by elapsed time while nothing had actually decoded → still black at the flip.
- **Led to →** keep the video composited (not `opacity:0`) so it would decode (Round 3).

### Round 3 — Off-screen translate decode + backdrop hold · 2026-05-18
- **Tried:** keep the inactive video `opacity:1` but `translateX(-200vw)` (composited, off-screen) so it
  decodes; hold the outgoing video as a backdrop during video→image.
- **Failed because:** Tizen suppresses decode on **any non-visible** `<video>`, however it's hidden;
  every swap still resolved via the time fallback with `rs<3` → black.
- **Led to →** abandon dual-layer pre-decode entirely; one visible `<video>` + a cover (Round 4).

### Round 4 — Single `<video>` + canvas bridge rewrite · 2026-05-26 · `529a304`
- **Tried:** one persistent `<video>`; on a swap, `drawImage` the outgoing last frame to a canvas, raise
  it, change `src`, reveal when the first frame is painted (rAF + `currentTime>0`×2).
- **Failed because:** ~50 % of swaps still blacked — and the canvas probe later proved
  `drawImage(video)` returns **pure black** on this panel (the HW plane composites above the canvas).
- **Led to →** stop yanking the cover early; widen timeouts (Round 5).

### Round 5 — Remove in-swap reload + 4 s timeout + paintability gate · 2026-05-27 · `503daa2`
- **Tried:** removed the destructive mid-swap `load()` (it reset `readyState` and aborted `play()` with
  `AbortError`), raised the swap timeout 2 s→4 s, released the cover only when `readyState>=2 &&
  currentTime>0`.
- **Failed because:** fixed *that* class, but video→video still blacked — the cover itself (canvas) was
  black, so there was nothing real over the decoding plane.
- **Led to →** replace the black canvas with a cover that actually paints: a server `<img>` (Round 6).

### Round 6 — Hide plane + server last-frame poster cover · 2026-06-01 · `34907a4`
- **Tried:** set the `<video>` to `opacity:0` during decode and raise a **server-extracted last-frame
  poster `<img>`** (a real image is immune to the plane/`drawImage` issues). Added the poster pipeline
  (`extract_last_frame`) + `normalize_video` (faststart) to shorten the gap.
- **Failed because:** initially the poster cover was inactive (`poster_path` NULL — backfill not run),
  so swaps fell back to the black canvas; `bridge px luma=0` confirmed `drawImage` is black on-device.
- **Led to →** make the poster the sole, guaranteed cover and harden the cut (Round 7).

### Round 7 — v2.2 poster-freeze (smart poster, hard-cut, video→image via poster) · 2026-06-02 · `9681311`
- **Tried:** non-black last-frame extraction (luma probe), instant hard-cut to the poster (no fade),
  routed **video→image** through the poster too, capped encodes to FullHD@30.
- **Failed because:** on the real panel the poster masking **still showed black AND regressed
  mid-playlist**; the persistent black was specifically the **loop restart** (last→first). Poster timing
  was too fragile on this firmware.
- **Led to →** stop masking a per-clip gap; remove the gap entirely with one continuous file (Round 8).

### Round 8 — v3.0 seamless-loop (single whole-playlist concat) · 2026-06-14 · `1fcf23a`
- **Tried:** join the entire live playlist into ONE MP4 (stream-copy where possible, images/odd clips
  re-encoded), play it on one `<video>`, loop by seeking to 0 just before EOF — no src swaps at all.
- **Failed because:** (a) **baked images into 1080p H.264 4:2:0 → quality loss**, and (b) the mixed
  stream-copy↔re-encode joins were **not timestamp-re-stamped** → decode-stall **seams**; the seek-to-0
  was also unreliable near EOF.
- **Led to →** harden the loop restart mechanism (Round 9).

### Round 9 — v3.1 loop-hardened (setInterval watchdog, 1.5 s lead) · 2026-06-15 · `5a7293b`
- **Tried:** removed the `loop` attribute, polled with a ~100 ms `setInterval` (rAF is throttled),
  raised the pre-end seek lead 0.25 s→1.5 s, retried the seek each tick, `load()` only as a last resort.
- **Failed because:** the **on-device logs the user captured** showed the real defeat — the file still
  **froze on the seams (`rs=2 ns=1`) at ct≈24 s / ct≈35 s on BOTH the TV and a laptop**, and at the loop
  the seek was rejected → `load()` → black. Hardening the loop couldn't fix a malformed file, and the
  quality loss from Round 8 remained.
- **Led to →** the current fix: stop baking a single file; go full-quality per-item and only join videos
  losslessly (Round 10).

---

### Round 10 — v4 full-quality hybrid (THIS fix) · 2026-06-16
Based directly on the findings above:
- **Retire the whole-playlist concat** → kills the seams (Round 8/9) and the image quality loss.
- **Per-item engine for any playlist with an image**: native full-res `<img>` images (quality), videos
  from their own files.
- **`normalize_video` 3-state** (skip byte-for-byte / lossless remux / CRF-18 only when forced) +
  **lossless PNG posters** → no video or poster quality loss.
- **Lossless video-run concat** for adjacent videos behind a strict gate (codec/profile/level, w×h, fps,
  **time_base**, **SAR**, **start_pts==0/no edit list**) + a lossless timing widener → motion-seamless
  adjacent videos with none of the Round-8 seams.
- **Cyclic wrap-run + rotation** for the video→video loop wrap (first & last both video) → the wrap plays
  *inside* one lossless clip; the loop's file boundary becomes a safe video→image edge. This is the case
  poster-timing (Round 7) never solved.
- **MSE gapless loop** for all-video playlists (no image to absorb the restart) → one fragmented lossless
  clip looped via Media Source Extensions; never ends/reloads/seeks.
- **Escalation if a true black remains on-panel:** native AVPlay `.wgt` (the only platform-guaranteed
  gapless path) — runbook in `docs/ambient-playback-findings-and-fallback.md` §8.

**Why this one is different from all nine before it:** every prior round either *masked* a per-clip gap
(Rounds 1–7, defeated by the Tizen plane/decoder walls) or *removed* the gap at the cost of quality and
with a broken build (Rounds 8–9). Round 10 removes the gap **only for video↔video** (lossless joins +
MSE) while keeping images out of any video entirely — so it satisfies *both* "no black" and "no quality
loss" for the first time, with AVPlay as the documented guarantee for the residual browser-only risk.
