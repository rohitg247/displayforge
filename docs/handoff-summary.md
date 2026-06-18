# Session handoff — Tizen ambient viewer: full-quality hybrid engine (v4) + flash fix

**For:** the next thread / engineer picking this up.
**Date:** 2026-06-17. **Branch:** `main`.
**Status:** **STABLE — verified working on the Samsung Tizen panel** (full-quality, black-free).

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

This satisfies both hard requirements — **no black anywhere** (incl. the loop) and **no quality loss** —
for every first/last combination. Native **AVPlay `.wgt`** remains the documented escalation if a *true*
black ever appears at a video edge on a given firmware (it hasn't on the tested panel).

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

## Escalation (only if a true black appears on a panel)
Native **`webapis.avplay`** in a packaged, signed Tizen `.wgt` (free; USB or URL Launcher install). Reuses
the FastAPI back-end / uploads / playlist UI; only the player layer changes. Even AVPlay flashes once on
the first loop, and SSSP is deprecated since Tizen 6.5 — full runbook + caveats in
`docs/ambient-playback-findings-and-fallback.md` (Approach 2) and `docs/tizen-avplay-seamless.md`.

## Related docs
- `docs/ambient-playback-findings-and-fallback.md` — root cause, Tizen constraints, sources, AVPlay runbook.
- `docs/ambient-fix-attempt-history.md` — every attempt (1–10), what failed, why the next followed.
- `changes.md` — dated changelog (2026-06-16 v4 hybrid, 2026-06-17 flash fix) + Appendix of early diffs.
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
