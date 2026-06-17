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
