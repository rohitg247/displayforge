# Ambient playback — findings, the shipped fix, and the fallback runbook

_Authored: 2026-06-16. Scope: Samsung Tizen ambient displays (the `AmbientViewerPage` engine + the
FastAPI media pipeline). This is the durable reference behind the 2026-06-16 changelog entry._

---

## 1. The problem we set out to fix

Display 2 (a mixed image+video playlist) was: getting **stuck on an item / skipping items** on both the
TV and a laptop, showing a **black screen at the loop restart**, and rendering **images and videos at
visibly degraded quality** vs. the originals.

## 2. Root cause (confirmed)

The previous engine (v3.0/v3.1 "seamless-loop") baked the **whole live playlist into one concatenated
MP4** (`ambient-<id>-playlist-<sig>.mp4`) and looped it via seek-to-0. That single file caused all of it:

- **Decode-stall seams** at the boundaries where a *stream-copied* video segment met a *re-encoded*
  segment. `ffmpeg -f concat -c copy` does **not** re-stamp timestamps, so mismatched
  **timebase / GOP / SAR / start-PTS** at those joins froze the decoder (`rs=2 ns=1` in the debug log =
  file fully downloaded, decoder cannot advance). Both clients froze at the *same* timestamps (≈24s,
  ≈35s) → the file was at fault, not the engine.
- **Black at the loop restart**: seek-to-0 was unreliable on the malformed file near EOF → `load()`
  fallback → decoder teardown → black.
- **Quality loss**: the concat **baked every image into 1080p H.264 4:2:0** (scaled, cropped,
  chroma-subsampled — fatal for text/logos) and re-encoded videos on top of the CRF-20 normalize already
  applied at upload.

A uniform re-encode of the concat would fix the seams but re-encodes everything and still bakes images →
it **violates the no-quality-loss requirement**, so it was rejected.

## 3. Everything tried before (so we don't repeat it)

| Era / commit | Approach | Quality | Tizen result |
|---|---|---|---|
| `20c9794` | early dual-layer crossfade (`AmbientViewerPage copy.jsx`) | full, no skip | black-free on laptop; **loop-restart black** on TV |
| `2f35192` | state-machine dual-layer (`_REFERENCE.jsx`) | full | same |
| `46c1da0` | hidden-layer pre-buffer | full | ❌ Tizen won't decode a hidden `<video>` |
| `529a304` | single `<video>` + canvas bridge | full | ⚠️ ~50% black (`drawImage` returns black) |
| `503daa2` | remove in-swap reload, 4s timeout | full | ⚠️ video→video still black |
| `34907a4` / `9681311` | poster-`<img>` cover / v2.2-poster-freeze | full | ⚠️ improved; **regressed mid-playlist; loop still black** |
| `1fcf23a`→`5a7293b` | single concat "seamless-loop" | ❌ baked/re-encoded | ✅ no swap-black, but **seams + load() loop-black** |

## 4. Hard Tizen-browser constraints (the walls)

1. Tizen **never decodes a non-visible `<video>`** → you cannot pre-warm the next clip.
2. Every `<video>.src` swap / `load()` = **~1.3–1.6s blank** on the single hardware decoder.
3. The HW video plane composites **above** HTML, and `canvas.drawImage(video)` returns **black** → the
   only runtime cover that paints is a server-extracted poster `<img>`.
4. Mid-playlist image↔video transitions **can** be black-free; the persistent black is the **loop
   restart when the wrap is video→video**.
5. The single continuous file was the only thing that ever removed the gap — but it costs image quality.
6. Truly gapless video looping needs native AVPlay (separate signed app) — see §8.

## 5. The shipped fix (Approach 1 — hybrid, full quality, no whole-playlist concat)

The viewer runs the **per-item engine** for any playlist that contains an image; images render as
**native full-resolution `<img>`** (pixel-perfect, no re-encode/crop), and videos play from their own
files. The only server-side joining is **lossless** and video-only.

### 5a. No quality loss
- **`normalize_video` (3-state)** — `'skip'` (already H.264/yuv420p/≤1080p/≤30fps **and** moov-at-front →
  serve the **original byte-for-byte**, nothing written), `'written'` (lossless `-c copy` remux for
  faststart, or a high-quality **CRF 18** re-encode only when truly incompatible, downscaling only above
  the 1080p decoder ceiling), `'failed'` (keep original). The upload endpoint deletes the raw upload
  **only** on `'written'`.
- **`extract_last_frame`** writes a **lossless PNG at the video's native resolution** (no scale jump,
  no "soft poster").

### 5b. Lossless video-run concat (adjacent videos)
A run of ≥2 **adjacent** videos is joined into one stream-copy clip (`build_video_run`) so it plays as a
single never-reloaded `<video>` (motion-seamless). It is built **only** when the clips pass a strict
gate — identical `codec/profile/level`, `width×height`, fps, **`time_base`**, **SAR**, and each starts at
**PTS 0 with no edit list**. If they differ only in container timing, a **lossless timing widener**
(`-c copy -avoid_negative_ts make_zero -muxpreload 0 -muxdelay 0 -video_track_timescale 90000`) makes
them eligible without re-encoding; otherwise the run stays per-item.

### 5c. The video→video loop wrap (first AND last item are videos)
"Land the wrap on an image" does **not** hold when both ends are videos. Fix = **cyclic wrap-run +
rotation** (`_playback_groups`): the trailing + leading video runs are adjacent *across the wrap*, so
they're merged into one lossless clip and the playback list is **rotated** to end with it. Result for
`[V0, I1, I2, Vlast]`: play `[I1, I2, W(=Vlast+V0)]` →

| Boundary | Type | Black-free because |
|---|---|---|
| `I2 → W` | image→video | the image covers the decode gap |
| **`Vlast → V0`** | **inside W** | **one continuous decode — no src swap / seek / poster** |
| `W → I1` (loop) | video→image | the **incoming** image (already decoded) hard-cuts up over the plane |

This triggers **only** when the first and last items are both videos and there is ≥1 image to absorb the
file restart. Every other combination (last=image, all-image, etc.) is already black-free on the normal
path.

### 5d. All-video playlists (no image at all) — MSE gapless loop
With no image to absorb the restart, the per-item loop would black. So an all-video playlist is served as
**`playback_mode: 'mse-loop'`** with one **fragmented, video-only** clip (`build_mse_loop`, lossless) +
a `.codecs` sidecar. The viewer loops it via **Media Source Extensions** (Tizen 7.0 / Chromium 94): the
clip is appended on a ring in `sequence` mode so the `<video>` never reaches `ended`, never reloads,
never seeks → the video→video wrap is gapless. If MSE is unavailable it falls back to the native `loop`
attribute (best-effort); the guaranteed escalation is AVPlay (§8).

### 5e. Files / functions
- `server/media_utils.py` — `_moov_at_front`, `normalize_video` (3-state), `extract_last_frame` (PNG),
  `build_video_run` + gate (`_probe_run_meta`, `_run_concat_compatible`, `_normalize_run_timing`),
  `build_mse_loop` + `_mse_mime`.
- `server/routers/ambient_router.py` — `_group_runs` / `_playback_groups` (cyclic wrap),
  `_collapse_runs_for_view`, `_regenerate_playlist_video` (builds run + MSE clips, clears legacy concat,
  prunes), `get_ambient_display` (`playback_mode` / `loop_video` / `loop_codec`), upload-flow 3-state.
- `src/pages/AmbientViewerPage.jsx` — `mseMode` + the MSE loop effect; per-item engine otherwise.
- `server/backfill_posters.py` — 3-state + `--playlist-videos` builds the joined clips for existing displays.

## 6. What is guaranteed vs. not

- **Guaranteed**: full image+video quality, no decode-stall seams, no skipped images, and the loop
  restart is black-free for **every** first/last combination (mixed via wrap-run rotation; all-video via
  MSE).
- **Needs on-panel confirmation**: the MSE all-video path (Tizen MSE behaviour) and the freeze-frame
  cover timing at video↔image edges. Verify with `?debug=true`; any **true black** (not a still frame)
  at a video edge → escalate to Approach 2.

## 7. Sources

**Internal (in-repo evidence):**
- `changes.md` — full 9-round Tizen black-screen history (2026-05-11 → 2026-06-15).
- `change.md` — early dual-layer engine (Apr 2026); the image-skip + initial-loop-glitch fix.
- Git history of `src/pages/AmbientViewerPage.jsx`: `20c9794`, `2f35192`, `46c1da0`, `529a304`,
  `503daa2`, `34907a4`, `9681311`, `1fcf23a`, `e33fcb8`, `5a7293b`.
- Backup viewers: `src/pages/AmbientViewerPage copy.jsx`, `…_REFERENCE.jsx`, `…copy 2.jsx`.
- `server/media_utils.py`, `server/routers/ambient_router.py`, `server/config.py`,
  `server/backfill_posters.py`.
- `docs/handoff-summary.md`, `docs/deployment-steps.md`, `docs/tizen-avplay-seamless.md`.
- Live on-device debug-log transcripts (TV + laptop, 2026-06-15/16) showing the ct≈24/35 stalls
  (`rs=2 ns=1`) and the loop `seek FAILED → load()`.

**External (web, verified June 2026):**
- Samsung Developer — Seamless Playback Using AVPlay:
  https://developer.samsung.com/smarttv/develop/guides/multimedia/seamless-video-playback.html
- Samsung DForum — AVPlaySeamlessMixedFrame: https://github.com/SamsungDForum/AVPlaySeamlessMixedFrame-
- Samsung DForum — AVPlaySeamlessStillMode: https://github.com/SamsungDForum/AVPlaySeamlessStillMode-
- Samsung Developer Forum — "Seamless video playback significant pause/freeze" (first-loop black):
  https://forum.developer.samsung.com/t/seamless-video-playback-significant-pause-freeze/29585/2
- Samsung Developer — Creating certificate: https://developer.samsung.com/tizen/certificate-signing/creating-certificate.html
- Samsung Developer — Migrating SSSP to Tizen (SSSP deprecated at 6.5):
  https://developer.samsung.com/smarttv/develop/migrating-applications/migrating-sssp-to-tizen.html?device=signage
- Dolby OptiView — How to Use Samsung Tizen's AVPlay:
  https://optiview.dolby.com/resources/blog/playback/how-to-use-samsung-tizens-avplay/
- signageOS / NowSignage / Xibo — Tizen HTML5 video is not gapless (also in `docs/tizen-avplay-seamless.md`).

---

## 8. Approach 2 — fallback runbook (native AVPlay `.wgt`), if Approach 1 still blacks on-panel

Free (no license — only a free Samsung dev account + Tizen Studio + a free signing certificate). Reuses
the FastAPI back-end, uploads, and playlist UI — **only the player changes**. Both **USB** and **URL
Launcher** install paths work.

1. **Repackage the React app as a Tizen `.wgt`**: add `config.xml`; embed
   `<script src="$WEBAPIS/webapis/webapis.js"></script>` in `index.html`. Wrap the built `dist/` so the
   CMS/UI is reused as-is.
2. **Sign** with a free Samsung certificate via Tizen Studio → Certificate Manager (author + distributor
   profile). Note: documented cert/install snags on **Tizen 7.0** — match the profile to the firmware.
3. **Install on the TV** — either path:
   - **URL Launcher**: Home → Source = URL Launcher (not MagicInfo) → point at the `.wgt`/host.
   - **USB**: copy the signed `.wgt` to USB → "Install From USB Device".
4. **Rewrite only the player layer** to drive AVPlay instead of `<video>`:
   `open(url) → setListener → setDisplayRect(0,0,1920,1080) → prepareAsync → play → seekTo/pause/stop →
   close`. Use **two players** (`webapis.avplaystore`, MixedFrame) so the next clip is prepared on the
   second instance and handed off with no reload. Keep images as full-res `<img>` overlays.
5. **Caveats**: even AVPlay **black-flashes on the very first clip 1→2 switch** (platform limit; minimize
   with `setVideoStillMode`); SSSP is deprecated since Tizen 6.5 (Tizen Enterprise Platform succeeds it).
6. **Keep `?debug=true` → debug-log POST/GET** so logs stay visible at the debug-log URL inside the app.
