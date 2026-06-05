# Scoping: true seamless playback on Tizen via native AVPlay (deferred / not built)

**Status:** scoping only. No code in this track yet. This documents the *one* path to genuinely
gapless, motion-continuous video on Samsung Tizen signage — and why it is a separate architecture
from the current React web app. Read this before anyone is asked to "just make it fully seamless."

## Why the current browser app cannot be truly gapless

The Ambient viewer is a React page loaded in the **Tizen web browser**. On that platform:

- There is effectively **one hardware video decoder**. Two simultaneously-decoding `<video>`
  elements are not supported — starting the second pauses the first. So the classic
  "double-buffer / crossfade two videos" trick does not work in the browser.
  (signageOS, Tizen developer forum.)
- Swapping `src` on a single `<video>` forces `load()`, which tears down the decoder and re-inits
  it for the new stream. On this hardware that first-frame decode takes **~1.3–1.6 s**, during
  which the video plane is black.
- `canvas.drawImage(video)` returns **black** (confirmed on-device: `bridge px luma=0`), because the
  hardware video plane composites *above* the HTML/canvas layer. So a runtime canvas "freeze frame"
  cannot capture the last frame either.

**What we ship instead (current rollout):** a server-extracted **last-frame poster** (`<img>`) is
held over the decode gap. A real `<img>` is immune to both failure modes above, so the outgoing
clip's final frame stays on screen (frozen) instead of going black. Plus server-side
`normalize_video()` (faststart + uniform H.264) to *shorten* — not remove — the gap. This is the
correct browser-grade fix and is what the community recommends for HTML5 Tizen players.

## The native path: `webapis.avplay` inside a packaged Tizen SSSP app

This is how MagicInfo and seamless signage players actually do it. AVPlay is Samsung's native media
player exposed to a **packaged Tizen application** (a `.wgt`), not to arbitrary web pages.

Requirements / building blocks:

1. **Package as a Tizen Smart Signage (SSSP) app**, not a hosted URL:
   - Embed the WebAPIs script in `index.html`: `<script src="$WEBAPIS/webapis/webapis.js"></script>`.
   - `config.xml`: the `http://developer.samsung.com/privilege/avplay` privilege is **not required on
     2015+ models** (per Samsung's using-avplay guide) — declare it only if targeting older firmware.
   - Build/sign with Tizen Studio; install via MagicInfo or USB/Device Manager.
2. **Drive playback through AVPlay**, not `<video>`:
   - Lifecycle: `open(url)` → `setListener(...)` → `setDisplayRect(x,y,w,h)` → `prepareAsync(onReady)`
     → `play()` → `seekTo`/`pause`/`stop` → `close()`. Note `setDisplayRect` uses a **1920×1080 base**
     coordinate space regardless of app resolution. `open()` needs absolute paths / remote URIs
     (relative paths unsupported).
   - For true seamless: `webapis.avplaystore` enables **two players** (MixedFrame mode) so the next
     clip is prepared on a second instance and handed off without a reload; **StillMode** is the
     single-player variant. See Samsung `AVPlaySeamlessMixedFrame-` / `AVPlaySeamlessStillMode-`.
   - `suspend`/`restore` transition without closing the instance (cheaper than open/close).
3. **Encode constraints still apply:** all clips in a playlist should share resolution / frame rate /
   codec / bitrate, within the FullHD@30 ceiling. `normalize_video()` (already implemented, now capped
   to FullHD@30) produces compatible encodes, so the backend is already aligned with this requirement.

### Honest limitations of the native path

- **Even AVPlay shows a black flash on the first playlist loop** (first → second clip). It is only
  gapless from the second cycle onward. This is a documented platform limitation, not a bug.
- It is a **different deliverable**: a signed Tizen app with its own build/sign/deploy pipeline and
  on-device debugging — weeks of effort, separate from the React/Vite app and its Docker deploy.
- The admin/CMS side (FastAPI + uploads + playlists) is reusable; only the *player* changes.

## Recommendation / sequencing

1. **Now:** ship the poster cover + `normalize_video` + version/poster diagnostics (this rollout).
   Validate on the panel that swaps show `cover: poster (last frame)` and the freeze (not black).
2. **If the residual ~1 s freeze is unacceptable** for the brand experience, open the native AVPlay
   track as a scoped project: prototype the StillMode sample with two of our normalized clips on the
   target firmware, confirm the loop-2 seamlessness, then port the playlist/announcement UI.
3. Keep `/uploads` served with range + cache headers either way (already done) — AVPlay benefits
   from the same fast, cacheable delivery.

## References

- signageOS — Tizen Gapless/Seamless video playback limitation
- Samsung Developer — Seamless Playback Using AVPlay
- Samsung DForum — `AVPlaySeamlessStillMode-`, `AVPlaySeamlessMixedFrame-` samples
- NowSignage — Enabling Seamless Video Playback on Samsung Tizen Displays
- Dolby OptiView — Samsung Tizen / AVPlay considerations
