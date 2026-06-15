# Session handoff — Tizen ambient-viewer SEAMLESS-LOOP fix (engine v3.0)

**For:** the next thread / engineer picking this up.
**Date:** 2026-06-14. **Branch:** `main`. **Working tree:** changes implemented, NOT yet committed.

---

## TL;DR — current state
The root cause was re-diagnosed and the architecture **changed from per-item masking to a single
continuous loop file**. Instead of playing each clip separately and masking the black gap between
them (5 failed rounds), the backend now joins the live playlist into **ONE continuous video** and the
viewer plays it on a single `<video>`, looping by **seeking to 0 just before the end** — so the Tizen
decoder is never re-initialised mid-playlist OR at the loop restart. Plus a **TV→URL debug-log
capture** so logs can be read in a browser instead of photographing the panel.

**Code is implemented; `npm run lint` + `npm run build` pass; backend `py_compile` passes.**
**NOT yet verified on a real Samsung panel, NOT yet committed.** The one remaining action is
**deploy + build the loop files + on-panel verify** (below).

---

## The problem (corrected root cause)
The user clarified: **mid-playlist was fine in the base version; the black screen is the playlist
RESTART (last item → first item)** — and the v2.2 poster masking even regressed mid-playlist. Two
Tizen-specific causes (confirmed via signageOS / NowSignage / Samsung video-element docs / aframe
issue #3209):
1. **Decoder re-init at the wrap** — wrapping to index 0 RE-`load()`s the first clip; Tizen's single
   hardware decoder blanks the plane ~1.3–1.6 s while it re-initialises.
2. **End-of-stream blank** — even one `<video loop>` can flash "right before restarting" because the
   decoder hits `ended` (plane blanks) before it seeks back.

The fix removes BOTH: one continuous file (no per-item `load()`) + pre-end seek-to-0 (never reaches
`ended`, never reloads).

## Hard requirements the user set
- **Zero black / zero visible gap anywhere** — mid-playlist AND at the loop restart. Must play like a
  professional signage player.
- **No quality loss / no re-encoding** of their video bitstreams — stream copy where possible.
- **TV→URL logging** to diagnose without watching the screen.

---

## What was done this session (engine bumped to `v3.0-seamless-loop`)

### Part 1 — one continuous LOSSLESS loop file
- **`server/media_utils.py` `build_playlist_video(items, dst, orientation, …)`** — joins the live
  playlist with ffmpeg's **concat demuxer `-c copy`** (zero re-encode of the joined stream). Per
  segment: conforming clips are **stream-copied byte-for-byte** (`_remux_copy_segment`, audio
  stripped, lossless); still images encoded once (`_encode_segment`, CRF 16); only a non-conforming
  video re-encoded once. Conformance via `ffprobe` (`_probe_stream`); target = most common in-ceiling
  geometry/fps (`_pick_target_spec`) so the MOST clips copy. Closed-GOP/IDR output (`_GOP_ARGS`) → a
  keyframe at frame 0 for an instant seek-to-0. Safe-by-construction (writes only `dst`, never raises).
- **`server/routers/ambient_router.py`** — `_regenerate_playlist_video(db, display_id)` rebuilds the
  LIVE playlist's file after `publish_playlist` / `reorder_ambient_media` / `delete_ambient_media`;
  idempotent via stable sha1 `sig`; file `ambient-<id>-playlist-<sig>.mp4`. **Single live video →**
  point `playlist_video_path` straight at that clip (no build). `_is_built_concat` + `_unlink_upload`
  ensure stale cleanup never deletes a real clip. `get_ambient_display` returns `playlist_video` for
  LIVE viewing only.
- **DB:** `ambient_displays.playlist_video_path` + `playlist_video_sig` (`schema.sql`, idempotent
  ALTER in `database.py`, `migrate.py`).
- **`server/backfill_posters.py --playlist-videos`** — builds loop files for existing displays without
  re-publishing (reuses `_regenerate_playlist_video`).
- **`src/pages/AmbientViewerPage.jsx`** — when `display.playlist_video` is set, renders ONE
  `<video muted playsInline autoplay loop>` and loops via the **pre-end seek-to-0 watchdog**
  (`handleSingleTimeUpdate`: at `currentTime >= duration - SINGLE_SEEK_LEAD (0.15s)` → `currentTime=0`,
  no `load()`). `onEnded`→seek + `loop` are backstops. HUD shows **`MODE: seamless-loop ✓`** vs
  **`per-item engine (fallback)`**. The old per-item engine is **kept untouched as the fallback**.

### Part 2 — TV→URL debug-log capture
- `POST /api/ambient/{id}/debug-log` (sent as text/plain → no CORS preflight) → writes
  `<DB dir>/debug-logs/ambient-<id>-<ts>.json` + `…-latest.json` (newest 20 kept).
- `GET /api/ambient/{id}/debug-log/latest` → plain text, no-cache.
- `src/services/api.js` `postAmbientDebugLog`; the viewer streams **every** event while `?debug=true`
  is open (chronological, buffered + retried on network blips — full detail, not a rolling window).
- Backend appends to **one file per display per day** (`ambient-<id>-<YYYY-MM-DD>.log`, wall-clock
  timestamps) and **prunes day-files older than 7 days**. Capture happens only in `?debug=true`.
- **Read logs at:** `http://<tv-host>:8888/api/ambient/<display-id>/debug-log/latest` (open on a
  laptop, select-all, paste). Returns the most recent day's full transcript; add `?date=YYYY-MM-DD` to
  view any of the retained 7 days (the response lists available days).

---

## Key files
| File | Role |
|---|---|
| `server/media_utils.py` | `build_playlist_video` (stream-copy concat) + helpers; `normalize_video`/poster kept. |
| `server/routers/ambient_router.py` | `_regenerate_playlist_video` + triggers; debug-log endpoints; `playlist_video` return. |
| `server/database.py` / `schema.sql` / `migrate.py` | `playlist_video_path` + `playlist_video_sig` columns. |
| `server/backfill_posters.py` | `--playlist-videos` to build loop files for existing displays. |
| `src/pages/AmbientViewerPage.jsx` | Seamless-loop mode (single `<video>` + pre-end seek-to-0 + MODE HUD + log POST); engine = fallback. |
| `src/services/api.js` | `postAmbientDebugLog`. |
| `changes.md` | Full 2026-06-14 entry (newest at bottom). |

---

## What's LEFT (the only open work)
1. **Deploy backend:** `docker compose up -d --build backend` (ffmpeg present; auto-adds the two new
   columns on startup).
2. **Build the loop files for existing displays:**
   `docker compose exec backend python -m server.backfill_posters --playlist-videos`
   Confirm: `sqlite3 /data/signage.db "SELECT id, playlist_video_path FROM ambient_displays;"` is set.
3. **Deploy frontend:** `docker compose up -d --build frontend`.
4. **Verify on the panel** with `?debug=true`, 5+ loops including the restart:
   - HUD top: `v3.0-seamless-loop · <fresh build timestamp>`,
   - `MODE: seamless-loop ✓` (NOT `per-item engine (fallback)` — fallback means the build failed),
   - repeated `pre-end seek → 0`, and **no black** at `=== loop wrap ===`; `ERRORS: 0`.
   - Read the log without watching: `…:8888/api/ambient/<id>/debug-log/latest`.
5. **Confirm no quality loss:** `ffprobe` the built file — conforming clips keep the source codec
   (stream-copied), only images/odd clips are re-encoded.
6. If healthy → commit all files in one commit; update this handoff's status line.

## Things to keep in mind
- **`MODE: per-item engine (fallback)` on the panel = the concat build FAILED** (or no `playlist_video`
  yet). Check backend ffmpeg logs / re-run the `--playlist-videos` backfill. The fallback engine is the
  old black-prone path — it must not be the steady state.
- The build re-encodes **only** non-conforming clips + still images; conforming videos are pure stream
  copy. If too much is being re-encoded, the playlist clips differ in resolution/fps — normalize the
  uploads to one spec.
- Pre-end seek lead is `SINGLE_SEEK_LEAD = 0.15 s`. If the panel still nicks a frame at the wrap, raise
  it slightly (e.g. 0.25 s). The file's first frame is an IDR keyframe so seek-to-0 is instant.
- **Per-image duration** is a real field now: `ambient_media.duration` (seconds, NULL → default 5 =
  `AMBIENT_IMAGE_SECONDS`). The seamless-loop concat bakes each image to `duration or default`. The
  upload endpoint takes an optional `durations` form field (comma-separated, aligned to files) — the
  current UI sends nothing (all NULL); a future upload UI can set it with no endpoint change. The
  per-item FALLBACK engine still uses its fixed constant (only matters if the concat build fails).
- **Audio is a switch, not a permanent strip.** Default OFF (player is muted; segments stay video-only
  for a clean `-c copy`). Set env `AMBIENT_PLAYLIST_AUDIO=true` to keep audio — the builder synthesises
  a silent track for images/silent clips and re-encodes only audio; the **video is still stream-copied
  losslessly**. To actually hear it the viewer `<video>` must also be unmuted (separate future step;
  autoplay requires muted today).

## Deferred (documented, not needed for this fix)
- Native AVPlay `.wgt` (true motion-seamless, but a separate signed app; still flashes loop 1) —
  `docs/tizen-avplay-seamless.md`.
- Replace `vite preview` with nginx for `dist/` + `/uploads` — `changes.md` "Deferred follow-up".
