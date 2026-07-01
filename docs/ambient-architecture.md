# Ambient Display — System Architecture

> Developer map of the **ambient signage** subsystem: the looping image/video display shown on
> Samsung Tizen TV panels, plus the admin tooling that configures it. Last updated 2026-06-23
> (engine `3.3-img-plane-release`). Companion to `changes.md` and `docs/ambient-fix-attempt-history.md`.

---

## 1. Tree map

```
Digital Sign/Production
├── src/                                  # React front end (Vite)
│   ├── App.jsx                           # routes (viewer, debug-log, admin)
│   ├── pages/
│   │   ├── AmbientViewerPage.jsx         # ★ the on-panel player (3 playback modes + per-item engine)
│   │   ├── AmbientDisplaysPage.jsx       # admin: media upload, A/B playlists, announcement, publish
│   │   ├── AmbientDebugLogPage.jsx       # renders the streamed on-panel ?debug transcript
│   │   └── AmbientViewerPage*.jsx (copy/REFERENCE/Stable)  # stale snapshots — NOT used, ignore
│   ├── components/AmbientOrientationGate.jsx   # wraps the viewer; portrait/landscape gate + rotation UX
│   └── services/api.js                   # all ambient API calls (getAmbientDisplay, publishPlaylist, …)
│
├── server/                               # FastAPI back end
│   ├── routers/ambient_router.py         # ★ every /api/ambient endpoint + mode-selection logic
│   ├── media_utils.py                    # ★ ffmpeg pipeline (normalize, posters, concat, MSE loop)
│   ├── backfill_posters.py               # batch last-frame poster generation
│   ├── models.py / schema.sql            # ambient_displays + ambient_media tables
│   └── uploads/                          # served at /uploads/<file> — originals + derived clips/posters
│
└── docs/                                 # this file + handoff + fix-attempt history + findings
```

Canonical viewer file: **`src/pages/AmbientViewerPage.jsx`**. The `AmbientViewerPage copy*.jsx` /
`*REFERENCE.jsx` / `*Stable.jsx` files are old snapshots and are not imported anywhere.

---

## 2. Front-end: the viewer (`AmbientViewerPage.jsx`)

### 2.1 URL / params
- Live: `/:branchId/2/:id` (wrapped by `AmbientOrientationGate`).
- Preview: `?preview=true&playlist=A|B` — admin previews a draft playlist before publishing.
- Debug: `?debug=true` (or `?debug=verbose`) — on-screen HUD **and** streams every event to the backend.
- Debug transcript page: `…/:id/debug-log/latest` (`AmbientDebugLogPage`).

### 2.2 Three playback modes (selected from the `getAmbientDisplay` response)
| Mode | Condition | What plays |
|---|---|---|
| **per-item engine** (default) | any playlist containing an image (and all previews) | full-res `<img>` images + individually played `<video>` clips, with JS transitions |
| **seamless-loop** | `display.playlist_video` present (legacy; currently the backend keeps it `None`) | one concatenated `<video>`, looped by a pre-end seek-to-0 watchdog |
| **mse-loop** | `display.playback_mode === 'mse-loop'` **and** `display.loop_video` | ALL-video playlist → one fragmented clip fed via Media Source Extensions (never ends/seeks) |

The backend decides per request (see §4.2). seamless/mse use their own `<video>` elements
(`singleVideoRef` / `mseVideoRef`); the per-item engine uses `videoRef` + two image layers.

### 2.3 Per-item engine (the bulk of the file)
- **State machine:** `IDLE → PLAYING → SWAPPING → PLAYING …` (`stateRef`, `goState`).
- **Layers (z-order):** `<video>` z=1 · `<img>` A/B z=2 · canvas bridge z=3 · poster `<img>` z=3 ·
  announcement + colour band z=10 · debug HUD z=999.
- **Four transitions** (chosen by `advance()` from current→next media type):
  - `runVideoToVideo` — poster `<img>` (or canvas bridge) covers the outgoing last frame during the
    incoming clip's ~1.3–1.6 s decode, then hard-cut to the live video.
  - `runVideoToImage` — freeze to the last-frame poster, decode the next image beneath it, hard-cut.
  - `runImageToImage` — dual cross-dissolve (ease-out in / ease-in out), images at resting z=2.
  - `runImageToVideo` — outgoing image stays as cover until the video presents its first real frame,
    then crossfade.
- **Paintability gate:** `startFirstFrameLoop` watches `currentTime` advance (real frame presented);
  `swapDeadlineRef` (SWAP_TIMEOUT) is the backstop so the engine never hangs.
- **Prefetch** (`startPrefetch`) warms N+1; **poster preload** (`preloadPoster`) decodes the current
  video's last frame for the next cover; **image timer** (`armImageTimer`, 5 s) drives image advance.
- **Tizen video-plane release (engine 3.3):** a mounted `<video>` holds the Samsung hardware video
  plane even at `opacity:0`, which dims the graphics-plane `<img>` above it. `releaseVideoPlane()`
  (`pause` + `removeAttribute('src')` + `load()` + `display:none`) frees the plane whenever we settle
  on an image; `acquireVideoPlane()` restores it before any video plays. Mirrors v1's conditional
  render (which had no dimming). See `changes.md` 2026-06-23.

### 2.4 Live updates & debug streaming
- `fetchData` polls `getAmbientDisplay` every `POLL_INTERVAL` (5 s); `display` stays live, media changes
  go through the engine's pending-swap path (`applyPendingIfNeeded`) so a transition isn't interrupted.
- When `?debug`, every event is buffered and POSTed (`postAmbientDebugLog`) in chronological batches to
  `/api/ambient/<id>/debug-log`, readable at `…/debug-log/latest` (no need to photograph the TV).

---

## 3. Front-end: admin (`AmbientDisplaysPage.jsx`)
- CRUD displays; per-display: upload media into playlist **A** or **B**, drag-reorder, delete, set
  per-image seconds, edit announcement (label/name/title/enabled) and orientation.
- **Draft-staging:** edits write *draft*/working columns; the live panel keeps showing the published
  state until **Publish**. "Preview" opens the viewer with `?preview=true&playlist=…`; the preview's
  Publish button calls `publishPlaylist`.

---

## 4. Back end (`server/routers/ambient_router.py` + `media_utils.py`)

### 4.1 Endpoints (prefix `/api/ambient`)
| Method & path | Purpose |
|---|---|
| `GET ""` | list displays |
| `POST ""` | create display |
| `GET "/{id}"` | **viewer payload** — resolves active playlist, media, mode (see §4.2); `?admin=true` returns the draft view |
| `PUT "/{id}"` | update display config (draft) |
| `PUT "/{id}/active-playlist"` | set which playlist is live |
| `POST "/{id}/publish-playlist"` | publish draft A/B → live (copies draft→live, rebuilds derived clips) |
| `DELETE "/{id}"` | delete display |
| `POST "/{id}/media"` | upload media (saves to `uploads/`, makes poster+thumb, inserts row) |
| `PUT "/{id}/media/reorder"` | reorder (draft) |
| `DELETE "/media/{media_id}"` | delete a media item |
| `POST "/{id}/debug-log"` | receive a batch of on-panel debug events |
| `GET "/{id}/debug-log/latest"` | render the day's transcript (plain text) |

### 4.2 Mode selection (in `GET /{id}`, live only)
- Resolve to the single published `active_playlist`; load `status='live'` media in `live_sort_order`.
- `_is_video_group(rows)` → **all video** ⇒ look for the prebuilt `ambient-{id}-mseloop-{sig}.mp4`
  (+`.codecs`); if on disk ⇒ `playback_mode='mse-loop'`, `loop_video=…`. Else fall back to per-item.
- Otherwise (mixed / has image) ⇒ `_collapse_runs_for_view` folds any prebuilt adjacent-video *runs*
  (incl. the cyclic wrap-run) into single items; `playback_mode='per-item'`. `playlist_video` stays
  `None` (whole-playlist concat retired — it baked images and produced decode-stall seams).

### 4.3 Media pipeline (`media_utils.py`)
- `normalize_video` — 3-state: skip (already conforming H.264/yuv420p) · lossless remux · CRF re-encode
  only when forced. Keeps quality; output `-pix_fmt yuv420p` (no explicit colour-range signalling).
- `extract_last_frame` → lossless PNG (`rgb24`) poster = black-free freeze-frame cover for the panel.
- `extract_first_frame` → admin-grid thumbnail.
- `normalize_image` / `probe_image` / `image_aspect_warning` (2026-07-01) — image-safety contract at
  upload: auto-downscale an image only if it exceeds the 1920×1080 ceiling (Lanczos, aspect kept, never
  upscaled/cropped) + warn (or `AMBIENT_IMAGE_STRICT`-reject) on off-aspect. Conforming images stored
  byte-for-byte. See `docs/media-pipeline-map.md`. Regenerate legacy `.jpg` posters as `.png` with
  `backfill_posters.py --force-posters` (DB-first).
- `build_video_run` — stream-copy adjacent in-spec videos into one motion-seamless clip (strict gate:
  codec/profile/level, w×h, fps, time_base, SAR, start_pts).
- `build_mse_loop` — one fragmented video-only clip for the MSE gapless loop.
- `build_playlist_video` — legacy whole-playlist concat (retired in the live path).

### 4.4 Data model
- **`ambient_displays`**: `orientation`, `active_playlist` (A/B), `announcement_{label,name,title,enabled}`,
  matching `draft_*` working columns, `playlist_video_{path,sig}`, `created_at`.
- **`ambient_media`**: `file_path`, `media_type` (image/video), `playlist` (A/B), `sort_order` (draft) +
  `live_sort_order` (published), `draft_removed`, `status` (draft/live), `poster_path`, `thumb_path`,
  `duration` (per-image seconds).

---

## 5. End-to-end flow

```
ADMIN                              BACKEND                                   PANEL (viewer)
─────                              ───────                                   ─────────────
upload to playlist B ───────────▶ save uploads/ambient-{id}-…  (POST /media)
                                  └ extract_last_frame → poster
                                  └ extract_first_frame → thumb
reorder / set seconds / announce ▶ write DRAFT columns (PUT …)
open Preview (?preview&playlist=B)──────────────────────────────────────────▶ per-item engine renders draft B
click "Publish B Live" ─────────▶ POST /publish-playlist
                                  └ draft_* → live, status→'live', live_sort_order set
                                  └ rebuild derived clips (video runs / mse loop)
                                                                            poll GET /{id} every 5s ◀────
                                  resolve active playlist + mode ──────────▶ pick mode:
                                                                              · all-video  → mse-loop
                                                                              · has image  → per-item engine
                                                                            render, loop, stream ?debug log
```

Files on disk (all served at `/uploads/<name>`): originals `ambient-{id}-{ts}-{i}.{png|jpg|mp4}`,
normalized `…-norm.mp4`, posters `…-norm-poster.jpg/png`, thumbs `…-thumb.jpg`, video-run/wrap clips,
and the MSE loop `ambient-{id}-mseloop-{sig}.mp4` (+`.codecs`).
