# Media pipeline map + image/video contract + the "dark frame" truth

_Authored 2026-07-01. Companion to `docs/ambient-architecture.md` (subsystem map) and
`docs/ambient-playback-findings-and-fallback.md` (Tizen constraints). Read this before touching the
poster/brightness code so the disproven experiments are not re-run._

---

## 1. The "darker last frame" — settled

**Symptom:** on the Samsung Tizen panel the frozen last frame of a video (and images generally) looks a
touch **darker** than live video.

**Root cause (confirmed, user-confirmed, do not re-investigate):** the panel applies picture-enhancement
to the **hardware video plane** (the `<video>`), so live video is boosted/brighter. The **graphics
plane** (`<img>` images + the server last-frame **poster**) renders true 8-bit sRGB and therefore looks
dimmer *by comparison*. It is a compositing artifact, invisible to logs (`getImageData` reads the
always-bright source pixels); only a panel photo shows it.

**Proven NOT the cause (each tried + reverted on-device — see `changes.md` 2026-06-22→06-26,
`docs/ambient-fix-attempt-history.md` Addenda 1–3):** `will-change` layer promotion; a mounted `<video>`
holding the HW plane; a CSS `brightness()` filter; and any ffmpeg/content colour change. The poster and
image files are plain 8-bit sRGB with **no ICC profile** and are **not** darker in the pixels (verified
off-panel; re-measured 2026-07-01). **The only structural fix is native AVPlay** (`docs/tizen-avplay-
seamless.md`) — out of scope for the browser app.

**What we DO change (sharpness, not brightness):** old rows carried a legacy `.jpg` "soft" poster.
`extract_last_frame` now writes a lossless `.png`; regenerate stale posters with
`python -m server.backfill_posters --force-posters` (DB-first: writes the `.png`, repoints the row, then
deletes the old `.jpg` — never leaves a row poster-less).

**Loop-restart true-black (distinct, being tracked):** the *playlist loop restart* can show a brief true
black at the image→video wrap. `runImageToVideo` holds the outgoing image until the video paints ≥2
frames, so it is black-free in the DOM — the likely trigger is the Tizen HW video plane blanking *above*
the HTML on `v.src=…;v.load()`, exposed by the TV's Chromium 94→120 auto-update (not the prefetch commit
`9b001c7`, which changes no transition code). Confirm by running the viewer at the pre-`9b001c7` commit
on-panel; the guaranteed fix is AVPlay.

---

## 2. End-to-end media flow (every transform)

```
IMAGE  upload ─► normalize_image (skip if ≤1920x1080 | downscale-if-oversized, Lanczos, aspect kept)
                 + aspect check vs display target ─► warn (or reject under AMBIENT_IMAGE_STRICT)
                 ─► served /uploads/<f> ─► <img object-fit:cover>  (native res, cover-crop, no stretch)
VIDEO  upload ─► normalize_video (skip byte-for-byte | lossless remux | CRF18 re-encode, yuv420p)
                 └─► extract_last_frame ─► poster .png (rgb24, native res) = freeze cover
                 └─► extract_first_frame ─► thumb .jpg (admin grid only)
publish ─► _regenerate_playlist_video:
             all-video playlist ─► build_mse_loop  (fragmented, video-only, lossless) ─► MSE ring loop
             mixed / has image  ─► build_video_run (adjacent videos, stream-copy) + cyclic wrap-run
view  GET /{id} ─► mode: mse-loop | per-item (built runs collapsed to one item)
```

- **Colour spaces / pixel formats:** videos normalize to `yuv420p` (no explicit range signalling — see
  §1, not worth changing). Posters/images are 8-bit sRGB, no ICC. All server *joins* are stream-copy
  (`-c copy`) → **no re-encode, no colour change**.
- **Resolution ceiling:** 1920×1080 (`_MAX_LONG_SIDE`/`_MAX_SHORT_SIDE`), mirrored to 1080×1920 for
  portrait. Videos and now images are only ever **downscaled to fit**, never upscaled, never cropped by
  the pipeline. On-screen cropping (if any) is the viewer's `object-fit: cover`.
- **"Clubbing into one angle video"** = the lossless `build_video_run` / `build_mse_loop` concat of
  *videos only*; images are never baked into a video.

---

## 3. Image contract (enforced at upload)

> **Input images should be the panel's native resolution and aspect: 1920×1080 (landscape) or
> 1080×1920 (portrait).**

- **Oversized** (long/short side above the ceiling) → **auto-downscaled once** at upload
  (`media_utils.normalize_image`, Lanczos, aspect preserved). A one-time high-quality resample beats the
  panel re-downsampling every render and removes the oversized-decode memory risk.
- **Wrong aspect** (deviates from the display's target by more than `AMBIENT_IMAGE_ASPECT_TOLERANCE`,
  default 5%) → a non-blocking **warning** surfaced in the admin upload toast; set
  `AMBIENT_IMAGE_STRICT=true` to **reject** (HTTP 400) instead.
- Everything else is stored byte-for-byte.

Config knobs (`server/config.py`): `AMBIENT_IMAGE_ASPECT_TOLERANCE`, `AMBIENT_IMAGE_STRICT`.

---

## 4. Display-URL device auth (one-time login) — see also §D of the plan

The public display URLs (`/:branch/1/:id` interactive, `/:branch/2/:id` ambient + the debug-log) can be
gated behind a **revocable, kiosk-lived device session**, designed to scale to many displays/branches/
clients (multi-tenant, any browser — not Samsung-only).

- **Off by default:** `DISPLAY_AUTH_ENABLED=false` → the URLs stay public (current behaviour). Flip it
  on per-deployment; existing displays keep rendering until you pair them.
- **One-time pairing:** the display shows a QR (`…/pair/<code>`); an admin already signed in on a phone
  opens it and approves. Fallback: email+password on the display. On success the display gets a long-lived
  httpOnly `actis_device` cookie.
- **Revocation is server-side:** every viewer request re-checks the token's `jti` against the
  `display_devices` table (`auth.get_display_viewer`); a revoked device stops rendering immediately. Admin
  → **Devices** page lists + revokes.
- **LAN note:** keep `AUTH_COOKIE_SECURE=false` on a plain-http origin or the TV browser won't send the
  cookie back.
