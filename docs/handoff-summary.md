# Session handoff — Tizen ambient viewer: full-quality hybrid engine (v4) + flash fix

**For:** the next thread / engineer picking this up.
**Date:** 2026-06-26 (prev 2026-06-22 / 06-17). **Branch:** `main`.
**Status:** **STABLE baseline `3.1-loop-hardened`** (engine == known-good `52f81c2` + larger
announcement bar). Browser-grade; see the two-phase plan below.

> **CURRENT — Update 2026-06-26 (engine `3.1-loop-hardened`) — read this first:**
> Both 2026-06-23 (`3.3-img-plane-release`) and 2026-06-24 (`3.1-img-bright`) experiments were
> **REVERTED**. The viewer is back to the byte-identical known-good no-flash baseline.
> - **Brightness:** a non-issue — source files look identical in brightness; the "darker images" was the
>   panel's video-plane picture processing, not our content. The `3.1-img-bright` CSS filter was removed
>   because it was unneeded **and** it caused an image→video flash (a CSS `filter` promotes the `<img>`
>   to a GPU layer that collides with the video plane at the hand-off).
> - **Flash reality:** the browser path is **firmware-fragile** — code clean on Chromium 94 flashed on
>   Chromium 120 (TV auto-updated). The HW video plane composites above HTML and blanks on every `src`
>   swap; the compositor timing is firmware-decided. The browser cannot guarantee zero-flash across
>   firmwares.
> - **Plan (full record in root `plan.md`, 2026-06-26 section):** **Phase 1** = fix in the browser
>   (this baseline; optional double-rAF hardening of `runVideoToImage` if video→image still flashes).
>   **Phase 2 (if Phase 1 still flashes)** = native Tizen **`.wgt` + AVPlay** (MagicINFO's engine: HTML
>   above the video plane, `setVideoStillMode` holds the last frame, two-player MixedFrame). Backend
>   (FastAPI) unchanged; staged behind a 2-clip on-device PoC.
>
> **SUPERSEDED — Update 2026-06-23 (engine `3.3-img-plane-release`) — REVERTED (caused a black flash):**
> - The 2026-06-22 `willChange` theory was **DISPROVEN on-device** (`willChange=auto` still dark) and
>   reverted. **Real cause:** since commit `529a304` the engine keeps one `<video>` always mounted;
>   on Tizen a mounted `<video>` holds the hardware video plane (opacity:0 doesn't release it), which
>   dims the graphics-plane `<img>` above it. v1's conditional render had no `<video>` during images →
>   no dimming (matches "early builds were fine").
> - **Fix:** `releaseVideoPlane()` (`pause`+`removeAttribute('src')`+`load()`+`display:none`) frees the
>   plane while an image is shown; `acquireVideoPlane()` restores it before video. Wired into `start`,
>   `finalizeSwap`, `runImageToVideo`, `runVideoToVideo`, `runVideoToImage`. Black-free preserved (the
>   image cover masks the re-acquire). No transition logic changed. **Verify on-panel** (brightness is
>   composited output, invisible to logs; `?debug` logs `video plane released/acquired`).
> - New **`docs/ambient-architecture.md`** (full subsystem map). Announcement-bar revert (2026-06-22)
>   stands. Full detail in `changes.md` (2026-06-23 entry).
>
> **Update 2026-06-22 (engine `3.2-img-truecolor`) — SUPERSEDED:** removed `willChange` from the
> `<img>` layers on a colour-management theory; disproven on-device (see 2026-06-23). Announcement bar
> restored to its original larger text/padding (kept).

---

## TL;DR — current state
The single whole-playlist concat (v3.0/v3.1) was **retired** — it baked images (quality loss) and its
mixed stream-copy↔re-encode joins produced decode-stall **seams** (stuck/skip at ct≈24 s / 35 s on TV
*and* laptop) plus a black loop restart. The engine is now a **full-quality hybrid**:

- **Per-item engine** drives any playlist containing an image: full-res `<img>` images + individually
  played videos. No image is ever baked into a video → **no quality loss**.
- **Lossless video-run concat** joins ≥2 *adjacent* videos into one stream-copied clip (motion-seamless,
  byte-identical) behind a strict compatibility gate.
- **Cyclic wrap-run + rotation** makes the **video→video loop restart** black-free by construction (the
  wrap plays *inside* one lossless clip; the file boundary becomes a safe video→image edge).
- **MSE gapless loop** handles all-video playlists (no image to absorb the restart).
- **3-state `normalize_video`** + **lossless PNG posters** keep video and cover quality intact.

This satisfies both hard requirements — no quality loss, and no black on the **originally tested
firmware** — for every first/last combination.

> **Current status (2026-06-26) — important caveat to the above.** The hybrid is black-free on the
> firmware it was tuned on, **but the browser path is firmware-fragile**: the TV auto-updated
> **Chromium 94 → 120**, which shifted the compositor timing and **reintroduced transition flashes with
> the same code**. A browser app therefore **cannot guarantee zero-flash across firmware updates** (the
> HW `<video>` plane composites above HTML and blanks on every `src` swap; the compositor timing is
> firmware-decided). The forward path is now a **two-phase plan** — **Phase 1:** the restored
> `3.1-loop-hardened` browser baseline (optional one-frame `runVideoToImage` hardening); **Phase 2 (if
> it still flashes on-panel):** native Tizen **`.wgt` + AVPlay** (MagicINFO's engine). Full record in
> root **`plan.md`** (2026-06-26 section) + `changes.md`.

---

## What we did this session (2026-06-17)
1. **Diagnosed** the v3.1 breakage from on-device debug-log transcripts: the concat's stream-copy↔
   re-encode joins weren't timestamp-re-stamped → `rs=2 ns=1` decoder freeze at the seams; seek-to-0 at
   the loop fell back to `load()` → black; images baked to 1080p 4:2:0 → quality loss.
2. **Reviewed the full 9-round history** (the 8th distinct approach) to avoid repeating any prior dead
   end — see `docs/ambient-fix-attempt-history.md`.
3. **Built the v4 hybrid** (backend `media_utils.py` + `ambient_router.py` + `backfill_posters.py`,
   frontend `AmbientViewerPage.jsx`): per-item spine, lossless `build_video_run` + strict gate, cyclic
   `_playback_groups` wrap, `build_mse_loop` for all-video, 3-state `normalize_video`, lossless posters.
4. **Fixed an image→image ~100 ms black flash** introduced by a z-index reset on a composited layer —
   replaced with a monotonic `imageZRef` and removed all z-resets (see the 2026-06-17 changelog entry).
5. **Verified on the Tizen panel** — every transition (i→i, i→v, v→i, v→v) and the loop restart show
   freeze-or-clean (no true black); images/videos sharp; `ERRORS: 0`.
6. **Docs:** wrote `docs/ambient-playback-findings-and-fallback.md` (root cause + sources + AVPlay
   runbook) and `docs/ambient-fix-attempt-history.md` (every attempt, why it failed, what came next);
   consolidated the old `change.md` into `changes.md` (Appendix); refreshed this handoff.

---

## What we did 2026-06-22 → 06-26 (the brightness/flash saga → two-phase plan)
Chased a reported "images look darker than video" on the panel, then a black flash. Net result: **three
experiments tried and all REVERTED**, the real causes pinned, and the path forward decided. The viewer
is back to the **`3.1-loop-hardened`** baseline (byte-identical to the known-good
`AmbientViewerPage_latest_updated.jsx` + the larger announcement bar).
1. **`3.2-img-truecolor`** (removed `willChange` from `<img>` layers) — disproven on-device, reverted.
2. **`3.3-img-plane-release`** (release the HW plane while on an image) — didn't brighten **and**
   reintroduced a video→image flash (the plane composites *above* the poster cover); reverted.
3. **`3.1-img-bright`** (TV-only CSS `brightness` filter on the image layers) — **reverted**: it was
   unnecessary (the real playlist source files look identical in brightness — the on-TV difference is
   the panel's video-plane picture processing, not our content) **and** it CAUSED an image→video flash
   (a CSS `filter` promotes the `<img>` to a GPU layer that collides with the video plane at the
   hand-off). It was the only diff from the known-good baseline, so removing it = byte-identical clean.
4. **Firmware fragility proven:** code that was flash-free on **Chromium 94** flashed on **Chromium 120**
   after the TV auto-updated → the browser path can't be future-proofed.
5. **MagicINFO (the bar) is native AVPlay:** `setVideoStillMode()` holds the last frame with no blank +
   two-player MixedFrame; in a native app HTML composites **above** the video plane. That's the only way
   to truly match it.
6. **Decision — two phases (full record in root `plan.md`, 2026-06-26):** **Phase 1** = browser baseline
   above (+ optional double-`rAF` hardening of `runVideoToImage` if video→image still flashes on Chromium
   120). **Phase 2 (if Phase 1 still flashes)** = native Tizen **`.wgt` + AVPlay**, backend (FastAPI)
   unchanged, staged behind a 2-clip on-device PoC. Awaiting on-panel verification of Phase 1.

---

## Architecture (where each behavior lives)

**Backend**
- `server/media_utils.py`
  - `normalize_video()` → **3-state** `'skip' | 'written' | 'failed'`: an already-H.264/yuv420p/≤1080p/
    ≤30 fps **and** faststart upload is served **byte-for-byte** (helper `_moov_at_front`, no ffmpeg);
    compatible-but-not-faststart → **lossless `-c copy` remux**; only genuinely incompatible sources are
    re-encoded at **CRF 18**, downscaling only above the 1080p ceiling.
  - `extract_last_frame()` → **lossless PNG** at native resolution (no scale jump; no "soft poster").
  - `build_video_run()` → lossless `-f concat -c copy` of a run, behind `_run_concat_compatible` (codec/
    profile/level, w×h, fps, **time_base**, **SAR**, **start_pts==0 / no edit list**) with a lossless
    container-timing **widener** (`_normalize_run_timing`) that recovers runs differing only in timing.
  - `build_mse_loop()` → one fragmented, video-only lossless clip (+ `.codecs` sidecar) for all-video.
- `server/routers/ambient_router.py`
  - `_regenerate_playlist_video()` → retires any legacy whole-playlist concat, builds the run clips +
    (for all-video) the MSE loop clip, prunes stale clips. Runs on publish / reorder / delete.
  - `get_ambient_display()` → **never serves a built whole-playlist concat**; collapses each *built* run
    into one synthetic video item via `_collapse_runs_for_view` → `_playback_groups` (cyclic wrap-run +
    rotation); signals `playback_mode: 'mse-loop'` for all-video.
  - Upload flow → branches on the 3-state `normalize_video` and **keeps the original on `'skip'`**.
- `server/backfill_posters.py` → 3-state aware, PNG posters; `--playlist-videos` builds the joined clips
  for existing displays (reuses `_regenerate_playlist_video`).

**Frontend** — `src/pages/AmbientViewerPage.jsx`
- Per-item engine (image crossfades + poster-cover video transitions) is the spine. A run clip is just a
  normal video item; an `mse-loop` clip is appended on an MSE ring so the element never ends/reloads.
- `runImageToImage` uses a **monotonic `imageZRef`** (top-z written only while the incoming layer is
  still `opacity:0`, never reset) → flash-free image→image in both directions.

---

## Superseded / removed
- **v3.0/v3.1 single whole-playlist concat** + the seamless seek-to-0 loop — retired (quality + seams).
  `playlist_video_path` is no longer served; `_regenerate_playlist_video` clears it and deletes the file.
- The early per-item / pre-buffer / canvas-bridge attempts — see the attempt-history doc.

## Phase 2 (planned, if Phase 1 still flashes on-panel) — native AVPlay `.wgt`
Native **`webapis.avplay`** in a packaged, signed Tizen `.wgt` (free; USB or URL Launcher install). Reuses
the FastAPI back-end / uploads / playlist UI; only the player layer changes. This is **MagicINFO's actual
engine** and the only way to truly beat the browser's plane blanking (HTML composites above the AVPlay
plane; `setVideoStillMode` holds the last frame; two-player MixedFrame hands off seamlessly). Staged
behind a **2-clip on-device PoC** before any full port. Caveats: even AVPlay flashes once on the first
1→2 switch (maskable), and SSSP is deprecated since Tizen 6.5. Full runbook + caveats in
`docs/ambient-playback-findings-and-fallback.md` (Approach 2), `docs/tizen-avplay-seamless.md`, and the
two-phase record in root `plan.md` (2026-06-26).

## Related docs
- **`plan.md`** (repo root) — the durable two-phase plan record (2026-06-26): findings, Phase 1 browser
  fix, Phase 2 native AVPlay, commit strategy. Read this for "where we stopped and why".
- `docs/ambient-architecture.md` — full subsystem map (modes, per-item engine, backend, data flow).
- `docs/ambient-playback-findings-and-fallback.md` — root cause, Tizen constraints, sources, AVPlay runbook.
- `docs/ambient-fix-attempt-history.md` — every attempt (1–10 + Addenda 1–3), what failed, why the next followed.
- `changes.md` — dated changelog (… 2026-06-16 v4 hybrid → 2026-06-26 filter revert / Phase-1) + Appendix.
- `docs/deployment-steps.md` — deploy/backfill commands.

## Verify / deploy
- `python -m py_compile` the 3 backend modules; `npm run lint` + `npm run build` green.
- Deploy: `docker compose up -d --build backend` → `docker compose exec backend python -m
  server.backfill_posters --playlist-videos` (builds joined clips, clears legacy pointers, deletes the
  old `ambient-*-playlist-*.mp4`) → rebuild frontend. New publishes rebuild automatically.
- On the panel with `?debug=true`: `MODE: per-item engine` (or `mse-loop ✓` for all-video), `ERRORS: 0`,
  no stall at the old seam timestamps, every transition + the loop is freeze-or-clean (no true black).
  Read the transcript at the viewer-origin `…/debug-log/latest` URL.

---

## 2026-06-18 — Phase 2: admin panel draft-staging + orientation gate (NOT yet device-verified)

A separate workstream from the viewer engine. **`AmbientViewerPage.jsx` was deliberately NOT touched**
(confirmed by an empty `git diff` on it). All viewer-facing behaviour is driven from the backend
(serving *draft* values to `admin=true`/preview under the same JSON keys the viewer already reads) and a
route-level wrapper in `App.jsx`.

**What changed**
1. **Draft-staging publish workflow** (issues 1,2,3,5). New columns: `ambient_displays.draft_orientation`
   + `draft_announcement_*`; `ambient_media.live_sort_order` + `draft_removed` + `thumb_path`
   (`schema.sql`/`database.py`/`migrate.py`, idempotent, seeded = live so existing displays are
   unchanged). All edits (add/delete/reorder + announcement + orientation) stage as **draft** → visible
   on the **Preview** link only; the **live** link changes solely on **Publish**, which the viewer's 5s
   poll + `applyPendingIfNeeded` blends at the next item. `GET /ambient/{id}` now serves the working
   view to admin and the published snapshot (status='live', `live_sort_order`) to live, and returns
   `is_live` + `has_unpublished_changes`. Publish promotes the working set, commits `live_sort_order`,
   hard-deletes `draft_removed` rows + files, and copies `draft_*` display fields → live. The admin
   Publish button is always available with state (`Publish X Live` / `Publish changes` / `LIVE — up to date`).
2. **Auth fix** (issue 8) — login also sets an **httpOnly `actis_session` cookie**; `get_current_user`
   accepts cookie **or** Bearer; token moved to **localStorage** (shared across tabs) + fetch sends
   `credentials:'include'`. The preview popup is now authenticated in every environment. Added
   `POST /api/auth/logout`. Set `AUTH_COOKIE_SECURE=true` in prod (HTTPS).
3. **Media-list layout** (issue 6) follows `display.orientation` (portrait → 9:16 tiles).
4. **Video first-frame thumbnails** (issue 10) — `media_utils.extract_first_frame` on upload →
   `thumb_path`; `backfill_posters.py --thumbs` for existing videos.
5. **Hover-to-preview** (issue 9) — 2s hover on a media tile opens an enlarged modal; mouse-out closes.
6. **Orientation gate** (new `src/components/AmbientOrientationGate.jsx`, wraps the viewer route in
   `App.jsx`) — overlays "This display is set to {Portrait|Landscape} — please view it on a … screen"
   when the device orientation ≠ the configured orientation (live view only; preview is never gated).
   framer-motion only, no theme/TOD deps. The reference files (`OrientationGate.jsx`,
   `ORIENTATION-GATE-FINAL.md`, `tod*.js`) were deleted.
7. **Megaphone** (issue 7) is just the "announcement enabled" indicator on the admin card (now with a
   tooltip). `API_BASE` `:8000` fallback in the admin page fixed to relative.

**Deploy note:** rebuild backend (`init_db` adds the columns) and run
`python -m server.backfill_posters --thumbs` once for existing videos' thumbnails. Status: builds/lint/
py_compile/migrate/app-import all green; **on-device + end-to-end admin flow not yet verified.**
