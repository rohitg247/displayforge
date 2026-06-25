# Plan — Tizen ambient seamless-loop: fix the live link, then (later) per-image duration

Background (already shipped, commit `1fcf23a` on `main`): v3.0 seamless-loop joins each display's live
playlist into ONE concatenated MP4 and plays it on a single `<video>`, looping by seeking to 0 just
before the end. The per-item poster engine remains as the fallback / preview engine.

---

## ✅ PHASE 1 — FIX THE LIVE LINK (DOING NOW)
The live concat video plays to the end and **freezes on the last frame** on the real Samsung panel — it
never loops. Confirmed from the on-panel debug log: events show only `=== loop wrap (native/ended) ===`
and **never** `pre-end seek → 0`, proving the pre-end seek never fires.

Root cause (all three restart mechanisms fail on Tizen):
1. Pre-end seek runs off `onTimeUpdate`, which Tizen fires too coarsely (~250 ms) to catch the final
   `SINGLE_SEEK_LEAD = 0.15 s` window → seek skipped.
2. The `<video loop>` attribute is widely ignored by the Tizen browser.
3. `onEnded`'s `currentTime=0; play()` won't resume after end-of-stream without a `load()` → frozen.

### 1a — Loop-restart robustness — `src/pages/AmbientViewerPage.jsx` (seamless path ONLY)
- **rAF-driven loop watchdog** (frame-accurate; modeled on `startFirstFrameLoop`). While
  `singleVideoMode` is active: each frame, if `ct >= d - SINGLE_SEEK_LEAD` → seek to 0 once (guarded by
  `wrappingRef`), then `play()` if paused. Independent of Tizen's coarse `timeupdate`. Own ref
  (`singleRafRef`), gated by `singleActiveRef`, cancelled on cleanup.
- **Bump `SINGLE_SEEK_LEAD`** 0.15 → 0.25 s.
- **`play()` after every programmatic seek** (Tizen can pause on seek).
- **Stuck-at-end / last resort:** if `v.ended || (ct >= d-0.05 && paused)` → restart (seek+play); if not
  resumed after ~500 ms → `load()+play()` (one brief blip beats a permanent freeze; should never fire
  normally).
- **Strengthen `handleSingleEnded`** to use the same recovery.
- Keep `onTimeUpdate` + `loop` as secondary backstops; add per-path debug logs
  (`rAF pre-end seek → 0`, `stuck-at-end force restart`, `ended fallback load()`).

Safety: confined to the seamless path; per-item engine + fallback untouched. No black at the wrap — the
restart is a `currentTime=0` seek on the already-playing video (no `load()`, no `src` swap), landing on
the concat's frame-0 IDR keyframe; the stream never reaches end-of-stream.

### 1b — Debug log at the viewer's port + URL pattern — `src/`
Serve the log at `http://<host>:3200/:branchId/2/:id/debug-log/latest` (same origin + pattern as the
viewer), instead of only `<VITE_API_URL>/api/ambient/<id>/debug-log/latest`.
- `App.jsx`: add `<Route path="/:branchId/2/:id/debug-log/latest" element={<AmbientDebugLogPage/>} />`.
- New `src/pages/AmbientDebugLogPage.jsx`: fetch via `api.getAmbientDebugLog(id, date)`, render plain
  text in a `<pre>`, auto-refetch ~10 s.
- `api.js`: `getAmbientDebugLog(id, date)` → `fetch(${API_BASE}/api/ambient/${id}/debug-log/latest)` →
  `res.text()` (reuses env-driven `API_BASE`; no hardcoded port).
- `AmbientViewerPage.jsx`: change the snapshot `url` field to the `.../debug-log/latest` form.

### 1c — Docs
- `docs/deployment-steps.md`: update the read-log example to
  `http://<host>:3200/<branchId>/2/<id>/debug-log/latest`.

### Phase 1 verification
`npm run lint` + `npm run build` green; on panel `?debug=true` ≥3 loops → repeated `rAF pre-end seek → 0`,
`ERRORS: 0`, no freeze, no black at the seam; log readable at the new `:3200/.../debug-log/latest` URL.

---

## ⏸️ PHASE 2 — PER-IMAGE DISPLAY DURATION (ON HOLD — do AFTER Phase 1 is verified live)
Deferred deliberately: the live link works for duration today (images use the default 5 s); this is a new
feature, not a bug fix, and there's no point polishing preview behavior before the live link is stable.

Backend ALREADY supports per-image duration (no new column needed):
- `ambient_media.duration` exists (schema.sql:58; migration database.py:35; models.py:122).
- `build_playlist_video` honors `it.get("duration") or image_seconds` (media_utils.py:413); the regenerate
  signature includes `duration` (ambient_router.py:113) → editing the time rebuilds the live concat.
- Upload already accepts a `durations` form field (ambient_router.py:432/446); the UI just sends empty.

PENDING work when resumed:
1. **Backend edit endpoint (new):** `PATCH /api/ambient/{display_id}/media/{media_id}` to update an
   existing image's `duration` (image-only, bounded ~1–120 s) + call `_regenerate_playlist_video`.
2. **Preview fidelity:** `armImageTimer()` (AmbientViewerPage.jsx:853; called 433/838/882) hardcodes 5 s
   and ignores `item.duration` — pass `item.duration*1000` so custom times show in preview too.
3. **Frontend UI:** per-image "seconds" input in `AmbientDisplaysPage.jsx` (and/or send `durations` at
   upload), matching existing component patterns.

Preview vs live (confirmed): `?preview=true` → `admin=true` returns DRAFTS via the per-item engine
(content/order/add-remove visible pre-publish); **Publish** promotes draft→live + regenerates → live link
updates. Preview is per-item (poster-masked), so the true gapless loop is only on the live link.

---

## ❌ NOT IN SCOPE
Landing-page card-height resize (that earlier message was sent accidentally).





////////////////////////

Ready for review
Select text to add comments on the plan
Ambient Display — full-quality, black-free playback (hybrid per-item + lossless video-run concat)
Plan authored: 2026-06-16. Owner: Rohit. Target: ambient display 2 (and all ambient displays).

Context
Display 2 plays a mixed image+video playlist. The current engine (v3.1 "seamless-loop") bakes the whole live playlist into ONE concatenated MP4 (ambient-2-playlist-ca7e0fd16067.mp4) and loops it by seeking to 0 before EOF. That single file causes every reported symptom: stuck/skips, black at the loop, and degraded image+video quality.

FINDINGS (this content is also written to the standalone doc — see Deliverables)
A. Root cause of the current breakage
Decode-stall seams at ct≈24s and ct≈35s (laptop AND TV): the points where a stream-copied video segment meets a re-encoded segment in the concat. ffmpeg -f concat -c copy does not re-stamp timestamps, so mismatched timebase/GOP/SAR freeze the decoder (rs=2 ns=1 = file fully downloaded, decoder cannot advance). Both clients freeze at the same spots → the file is at fault, not the engine.
Black at loop restart: seek-to-0 fails on the malformed file → load() fallback → decoder teardown → black.
Quality loss: the concat bakes every image into 1080p H.264 4:2:0 (scaled, cropped, chroma- subsampled) and re-encodes videos on top of the CRF-20 normalize already done at upload.
B. What was tried before (git + changes.md + change.md + 3 backup viewers)
Commit	Engine	Quality	Tizen result
20c9794 "image skip + loop glitch"	early dual-layer (copy.jsx)	full, no skip	black-free on laptop; loop-restart black on TV
2f35192	state-machine dual-layer (_REFERENCE.jsx, copy 2.jsx)	full	same
46c1da0	hidden-layer pre-buffer	full	❌ Tizen won't decode a hidden <video>
529a304	single <video> + canvas bridge	full	⚠️ ~50% black (drawImage returns black)
503daa2	remove in-swap reload, 4s timeout	full	⚠️ video→video still black
34907a4/9681311	poster-<img> cover / v2.2-poster-freeze	full	⚠️ improved; regressed mid-playlist; loop still black
1fcf23a→5a7293b	single concat seamless-loop (current)	❌ baked/re-encoded	✅ no swap-black, but seams + load() loop-black
C. Hard Tizen-browser constraints (proven across all rounds + Samsung/signageOS docs)
Tizen never decodes a non-visible <video> → cannot pre-warm the next clip.
Every <video>.src swap / load() = ~1.3–1.6s blank on the single HW decoder.
HW video plane composites above HTML; canvas.drawImage(video) returns black → the only cover that paints is a server-extracted poster <img>.
Mid-playlist image↔video transitions can be black-free; the persistent black is specifically the loop restart when item 0 is a video.
The early per-item engine is full quality, no skip, black-free on laptop — its only TV gap was the loop restart.
The single concat is the only thing that removed TV black — but it costs image quality + has seams.
D. Libraries evaluated (no silver bullet on the browser)
MSE players (hls.js / Shaka / dash.js): feed ONE <video> via Media Source Extensions (no src swap → gapless video). Needs uniform fMP4, can't carry images, and Tizen signage MSE is the flaky part (usual reason teams move to AVPlay). High risk, no help for image quality. Not adopted.
signageOS / Xibo / Yodeck players: commercial signage SDKs wrapping the native player — managed device-app model + license; same family as the native route, not a drop-in for a hosted URL.
Python ffmpeg-python / PyAV / MoviePy: ergonomic wrappers over ffmpeg/libav; PyAV could precisely re-stamp a seam-free concat, but only helps the path we're leaving and not the device black.
E. Native AVPlay — verified facts (web-checked June 2026)
FREE — webapis.avplay/avplaystore is part of the Tizen Web Device API; needs only a free Samsung dev account, free Tizen Studio, and a free Samsung signing certificate. Cost is engineering.
Available only inside a packaged, signed .wgt — not a hosted URL in the Tizen browser.
Even AVPlay black-flashes on the first switch (clip 1→2) — documented platform limit; gapless only from cycle 2.
SSSP deprecated since Tizen 6.5 (replaced by Tizen Enterprise Platform) — factor into net-new work.
The only path to a true gapless guarantee → this is Approach 2 (runbook below).
F. Sources (all included in the new doc)
Internal (in-repo evidence):

changes.md — full 9-round Tizen black-screen history (2026-05-11 → 2026-06-15), engines v2.x/v3.x.
change.md — early dual-layer engine (Apr 2026); the image-skip + initial-loop-glitch fix.
Git history of src/pages/AmbientViewerPage.jsx — commits 20c9794, 2f35192, 46c1da0, 529a304, 503daa2, 34907a4, 9681311, 1fcf23a, e33fcb8, 5a7293b.
Backup viewers: src/pages/AmbientViewerPage copy.jsx, …_REFERENCE.jsx, …copy 2.jsx.
Backend: server/media_utils.py (build_playlist_video/normalize_video/extract_last_frame), server/routers/ambient_router.py (_regenerate_playlist_video/get_ambient_display/debug-log endpoints), server/config.py, server/backfill_posters.py.
docs/handoff-summary.md, docs/deployment-steps.md, docs/tizen-avplay-seamless.md.
Live on-device debug-log transcripts (TV + laptop, 2026-06-15/16) showing the ct≈24/35 stalls (rs=2 ns=1) and the loop seek FAILED → load() — captured at the debug-log URL.
External (web, verified June 2026):

Samsung Developer — Seamless Playback Using AVPlay: https://developer.samsung.com/smarttv/develop/guides/multimedia/seamless-video-playback.html
Samsung DForum — AVPlaySeamlessMixedFrame sample: https://github.com/SamsungDForum/AVPlaySeamlessMixedFrame-
Samsung DForum — AVPlaySeamlessStillMode sample: https://github.com/SamsungDForum/AVPlaySeamlessStillMode-
Samsung Developer Forum — "Seamless video playback significant pause/freeze" (first-loop black): https://forum.developer.samsung.com/t/seamless-video-playback-significant-pause-freeze/29585/2
Samsung Developer — Creating certificate: https://developer.samsung.com/tizen/certificate-signing/creating-certificate.html
Samsung Developer — Migrating SSSP to Tizen (SSSP deprecation): https://developer.samsung.com/smarttv/develop/migrating-applications/migrating-sssp-to-tizen.html?device=signage
Dolby OptiView — How to Use Samsung Tizen's AVPlay: https://optiview.dolby.com/resources/blog/playback/how-to-use-samsung-tizens-avplay/
signageOS — Tizen gapless/seamless video limitation; NowSignage & Xibo community reports on Tizen HTML5 video not being gapless (referenced in docs/tizen-avplay-seamless.md).
DECISION (confirmed with user)
On the Tizen browser you cannot mathematically guarantee zero-black at every video edge. Ship the hybrid (Approach 1) — full quality, removes every KNOWN black case — then verify on-panel. If a true black (not a freeze-frame) remains at a video edge, escalate to Approach 2 (native AVPlay .wgt).

APPROACH 1 — THE FIX (hybrid: per-item spine + lossless video-run concat)
Per-transition design (full quality, black-free targets)
Transition	Mechanism	Black-free because
image → image	opacity crossfade between two <img> (z=2)	no video plane involved
image → video	hold image; decode video behind (opacity 0); reveal when paintable	image covers the whole decode gap
video → image	hard-cut to outgoing video's lossless poster <img>, decode image beneath, hard-cut poster off	real <img> is immune to the plane
video → video (adjacent)	lossless video-run concat → one continuous decode, never swaps src	no load(), no decode gap
video → video (non-adjacent / spec mismatch)	poster freeze cover	lossless poster cover
loop restart	wrap engineered to land on an image (anchor item 0 = image; else video→image poster freeze)	image-involved wrap is black-free
No skipped images: per-item images advance on a clean armImageTimer (default 5s), not a baked-segment timeline — restores the skip fix from git 20c9794.

Code changes
server/media_utils.py — normalize_video:
Skip ffmpeg entirely when the source is already compatible and already faststart: codec h264, pix_fmt yuv420p/yuvj420p, ≤1920×1080, ≤30 fps and moov already before mdat (cheap MP4 box-order scan, no ffmpeg) → serve the original byte-for-byte (keep it; don't write -norm.mp4, don't delete the raw upload). Strongest no-quality-loss path + zero work. (Requires a small upload-flow tweak so the original is retained when normalize is skipped.)
Lossless remux (-c copy -movflags +faststart) when compatible but moov is at the back — only relocates moov; video bytes untouched.
Re-encode at -crf 18 only when genuinely incompatible (HEVC/VP9, >1080p, >30fps, non-4:2:0), downscaling only above the 1080p decoder ceiling.
Reuse _probe_stream() + _within_ceiling(); add a tiny _moov_at_front(path) MP4 box-order helper.
server/media_utils.py — extract_last_frame: write a lossless PNG (or -q:v 2) at the video's native resolution (no -vf scale → dims match, no scale jump), from the lossless-remuxed file. Kills the "soft poster".
server/routers/ambient_router.py — _regenerate_playlist_video: stop building the mixed concat. Group maximal runs of ≥2 consecutive videos and build ONE lossless -f concat -c copy clip per run (no image segments → none of the stream-copy↔re-encode seams), but only when the run passes the strict concat-safety gate below; otherwise the run stays as separate per-item videos (no re-encode-to-join). Each built run clip is exposed as a single video media item (run clip + last-frame poster). Null + delete the old whole-playlist concat via existing _is_built_concat() + _unlink_upload().
server/routers/ambient_router.py — get_ambient_display: never return a built whole-playlist concat (not _is_built_concat(pv)) → viewer always runs the per-item engine; run clips flow through the normal media list.
src/pages/AmbientViewerPage.jsx: per-item engine drives (no change to play the hybrid — a run clip is a normal video item). Ensure the loop wrap lands on an image. Optional later: delete the dormant single-file seamless-loop branch + singleLoop* handlers.
Upload-flow change — make the "skip-normalize" path explicit (server/routers/ambient_router.py ~L492–508)
normalize_video returns a 3-state status instead of a bool, so the upload endpoint never deletes the original on the skip path (today line ~499 always unlinks the raw upload when normalize "succeeds"):

'written' — a new -norm.mp4 was produced (remux or re-encode) → serve it, delete the raw upload.
'skip' — source already H.264/yuv420p/≤1080p/≤30fps and moov-at-front → no file written; keep & serve the ORIGINAL under its original name (e.g. ambient-<id>-<ts>-<i>.mp4); DB stores that path; poster extracted from it. Raw upload is NOT deleted.
'failed' — no usable output → keep & serve the original (best-effort; same handling as skip).
# BEFORE (~L496-507)
if normalize_video(filepath, normalized_path):
    try: filepath.unlink()
    except OSError: pass
    filename = normalized_name
    filepath = normalized_path
poster_filename = f"{Path(filename).stem}-poster.jpg"

# AFTER
status = normalize_video(filepath, normalized_path)   # 'written' | 'skip' | 'failed'
if status == 'written':
    try: filepath.unlink()            # raw superseded by the -norm.mp4
    except OSError: pass
    filename = normalized_name
    filepath = normalized_path
# 'skip'/'failed' → keep the ORIGINAL as the served file: filename/filepath unchanged, NOT deleted
poster_filename = f"{Path(filename).stem}-poster.jpg"
Also update server/backfill_posters.py _normalize_existing to branch on the 3-state ('written' = normalized → repoint + remove old; 'skip' = already optimal → leave the row as-is; 'failed' = report) instead of if not normalize_video(...). Idempotent: a 'skip' file re-probes to 'skip' on re-runs (no-op). Note served filenames are then a mix of -norm.mp4 and original names — fine (names are unique; nothing keys on the -norm suffix except this backfill skip-check, which the 3-state handles).

For display 2 (videos likely non-adjacent) this degenerates to pure per-item — already fixes the seams + quality + skip. The run-concat only activates for back-to-back videos.

Run-concat compatibility gate (tightened — fixes the timebase/SAR/edit-list risk)
exact codec/res/fps is NOT sufficient: two H.264/1080p/30 clips can still differ in timebase, SAR/DAR, start PTS, or carry edit lists — the very mismatches that produce the rs=2 decoder freeze we're fixing. A run is stream-copy-concat-eligible ONLY if all segments match on (via one ffprobe per clip):

codec_name (+ profile/level)
coded width × height
avg_frame_rate / r_frame_rate (fps)
time_base (stream timebase) ← ADD
sample_aspect_ratio (SAR) / display_aspect_ratio ← ADD
start_pts / start_time == 0 on every segment ← ADD
no edit list — proxy: start_time == 0 and first-packet PTS 0; or detect an elst box ← ADD
If ANY criterion fails → the run is not concat'd; those videos play per-item (poster-cover transitions). This is the safe default and prevents reintroducing the seam.

Optional lossless widener (no quality loss, verify on-panel before relying on it): before rejecting a run, normalize each segment's container timing only without re-encoding — ffmpeg -i seg -c copy -avoid_negative_ts make_zero -muxpreload 0 -muxdelay 0 -video_track_timescale 90000 -fflags +genpts -movflags +faststart — which strips edit lists, zeroes start PTS, and unifies timescale (video bytes identical). Re-probe; if now uniform → concat. This recovers seamless runs from clips that only differed in container timing. If still unsafe → per-item fallback stands.

Debug logging (must keep working at the debug-log URL)
The per-item engine already streams every event to the backend while ?debug=true (the debug-POST effect is engine-agnostic; HUD header reports mode per-item-engine, state, item, rs/ns/ct, errors).
Verify the transcript is readable (latest, no-cache) at both: http://10.1.1.236:3200/api/ambient/2/debug-log/latest and the viewer-origin page http://10.1.1.236:3200/<branchId>/2/2/debug-log/latest (?date=YYYY-MM-DD for prior days; 7-day retention). Confirm per-item events (cover: poster, image fade, === LOOP RESTART …, first-frame ct=…, swap-timeout) appear and the --- STATUS --- snapshot updates.
One-time cleanup (the "delete old MP4 + regenerate" tasks)
Delete uploads/ambient-2-playlist-ca7e0fd16067.mp4 (and any ambient-*-playlist-*.mp4).
UPDATE ambient_displays SET playlist_video_path=NULL, playlist_video_sig=NULL WHERE playlist_video_path LIKE '%-playlist-%'; (run via backend / /data volume, or trigger _regenerate_playlist_video for display 2 after change #3 — it now clears + cleans).
server/backfill_posters.py: point --playlist-videos at the updated _regenerate_playlist_video.
Verification (end-to-end)
Apply; restart backend; run cleanup. SELECT id, playlist_video_path FROM ambient_displays; → display 2 NULL; concat file gone.
?debug=true on laptop and TV: HUD MODE: per-item engine, ERRORS: 0; no stall at ct≈24/35; images sharp; ≥2 full loops incl. last→first show no black at the wrap.
Quality: on-screen image (text/logo) pixel-matches source; ffprobe a re-uploaded video → stream- copied (same codec/bitrate, moov front).
Adjacent videos: built run clip is one continuous stream (ffprobe -show_packets → monotonic PTS, no gap/reset at the internal joins), and plays past each internal join with no rs=2 stall on both laptop and TV (the run-concat gate working). If a join stalls, the gate was too loose — tighten it.
Pass/fail gate: every transition (i→i, i→v, v→i, v→v, loop) shows freeze-or-clean, no true black. Any true black at a video edge → open Approach 2.
APPROACH 2 — FALLBACK RUNBOOK (native AVPlay .wgt) — only if Approach 1 still blacks on-panel
Free (no license). Reuses the FastAPI back-end, uploads, and playlist UI — only the player changes. Both USB install and URL Launcher are supported (user is fine with either).

Repackage the existing React app as a Tizen .wgt: add config.xml; embed <script src="$WEBAPIS/webapis/webapis.js"></script> in index.html. Wrap the current built dist/ so the CMS/UI is reused as-is.
Sign it with a free Samsung certificate via Tizen Studio → Certificate Manager (author + distributor profile). Note: documented cert/install snags on Tizen 7.0 — match the profile to the target firmware.
Install on the TV — either path works:
URL Launcher: Home → Source = URL Launcher (not MagicInfo) → point at the .wgt/host.
USB boot: copy the signed .wgt to USB → on the panel, Install From USB Device.
Rewrite only the player layer to drive avplay instead of <video>: open(url) → setListener → setDisplayRect(0,0,1920,1080) → prepareAsync → play → seekTo/pause/stop → close. Use two players (webapis.avplaystore, MixedFrame) so the next clip is prepared on the second instance and handed off with no reload. Keep images as full-res <img> overlays (unchanged).
Caveats to expect: still a black flash on the first clip 1→2 switch (platform limit; minimize with setVideoStillMode); SSSP deprecated since Tizen 6.5 (Tizen Enterprise Platform is the successor).
Same debug logging: keep the ?debug=true → debug-log POST/GET so logs stay visible at the debug-log URL inside the packaged app too.
DELIVERABLES / DOCUMENTATION (executed on approval; plan-mode can't write them yet)
New doc docs/ambient-playback-findings-and-fallback.md — contains the FINDINGS section above (history table, root cause, Tizen constraints, libraries evaluated, AVPlay facts) plus the full Sources list (section F — internal repo evidence + external web URLs) plus the Approach 2 runbook, with a timestamp header (authored 2026-06-16).
Append this plan + timestamp to the scratch plan.md at the project root.
After applying the fix, add a new dated entry to changes.md (newest at bottom) documenting: the move off the single concat, the lossless normalize_video/poster, the lossless video-run concat, the loop-wrap-on-image, the cleanup, and the verification results.
Debug-log guarantee (above): confirm the per-item engine's logs land at the debug-log URL and the latest day is shown (no-cache, 7-day retention).
What we guarantee vs. not
Guaranteed: full image+video quality, no decode-stall seams, no skipped images, removal of the loop-restart black and the current concat-seam black.
Not platform-guaranteed on the browser: a video edge may briefly show a frozen last-frame (real poster, never black). If a true black remains on-panel → Approach 2.

---

## IMPLEMENTATION LOG — 2026-06-16 (executed on `main`, not yet committed)

Approach 1 implemented end-to-end. Static verification green: backend `py_compile` OK (media_utils,
ambient_router, backfill_posters); frontend `npm run lint` clean; `npm run build` succeeds (only the
pre-existing chunk-size warning). Canonical plan + full findings: `docs/ambient-playback-findings-and-fallback.md`.

Beyond the plan body above, two cases raised during execution were also covered:
- **Loop wrap when first AND last items are videos** (with ≥1 image): `_playback_groups` does a CYCLIC
  wrap-run — merges the trailing+leading video runs into one lossless clip and ROTATES the playback list
  so `Vlast→V0` happens INSIDE that clip; the loop's file boundary becomes a safe video→image edge. No
  poster-timing, no seek, no reload.
- **All-video playlists (no image at all)**: served as `playback_mode: 'mse-loop'` — one fragmented,
  video-only lossless clip (`build_mse_loop` + `.codecs` sidecar) looped via Media Source Extensions on
  the viewer (Tizen 7.0 / Chromium 94), appended on a ring so it never ends/reloads/seeks. Falls back to
  native `loop`, then AVPlay (Approach 2), if MSE misbehaves on-panel.

Changed files: `server/media_utils.py`, `server/routers/ambient_router.py`, `server/backfill_posters.py`,
`src/pages/AmbientViewerPage.jsx`; docs added/updated: `docs/ambient-playback-findings-and-fallback.md`,
`docs/deployment-steps.md`, `changes.md`.

Remaining before commit: run the deploy + one-time cleanup (delete the broken
`ambient-2-playlist-*.mp4` + null the legacy pointers — handled by `backfill_posters --playlist-videos`),
then verify on the panel with `?debug=true` (every transition + loop: freeze-or-clean, no TRUE black;
images/videos sharp; debug-log readable at the viewer URL).
Add Comment
---
---

# 2026-06-26 — Tizen Signage Playback Plan: Phase 1 (browser fix) → Phase 2 (native AVPlay `.wgt`)

_(Appended; the plan above is left as-is for history.)_

## 0. What this app is
Actis ambient **digital signage** on Samsung Tizen TVs. A React viewer (`AmbientViewerPage.jsx`) in the
**Tizen web browser** plays a looping playlist of **images + videos** (portrait Actis brand slides +
clips) with an announcement bar + scrolling colour band. CMS is a FastAPI backend (uploads, FFmpeg
normalize, posters, A/B playlists, publish).

**Requirement (the real bar):** works for **any** playlist — any count, only images, only videos, any
mix; **no black screen**; smooth transitions; **seamless loop**. Correct by design, not patched per-case.

## 1. What we found (so we never repeat it)
1. **"Images darker than video" — closed.** Disproven on-device: `will-change` promotion (3.2); mounted
   `<video>` holding the HW plane (3.3 — also reintroduced a flash). Source files look identical in
   brightness (user-confirmed) → any on-TV difference is the panel's video-plane picture processing, not
   our content. The brightness filter was unnecessary.
2. **image→video flash — CONFIRMED cause:** the CSS `filter: brightness(1.15)` on the image layers (the
   only diff from the known-good `AmbientViewerPage_latest_updated.jsx`). A filter promotes the `<img>`
   to a separate GPU layer; at image→video the re-composite collides with the video plane → flash.
   Removing it = byte-identical clean baseline.
3. **video→image flash "came back":** same code clean on Chromium 94, flashes on Chromium 120 (TV
   auto-updated). → browser path is **firmware-fragile, not future-proof**.
4. **Root wall:** in the browser the HW `<video>` plane composites **above** HTML and **blanks on every
   `src` swap**; the poster-`<img>` cover is a mitigation, not a guarantee.
5. **MagicINFO (gold standard):** native Tizen app using **AVPlay** — `setVideoStillMode()` holds the
   last frame with no blank; two-player MixedFrame = seamless. In native apps **HTML composites ABOVE the
   video plane** (the inversion that makes it seamless). One brief maskable gap on the first 1→2 switch;
   seamless forever after incl. loop.
6. **Backend is not the problem.** Keep FastAPI/Python; a rewrite is pure cost.

## 2. PHASE 1 — Browser fix (DONE in commit of 2026-06-26)
- Removed the brightness filter → `AmbientViewerPage.jsx` byte-identical to known-good no-flash baseline
  (engine `3.1-loop-hardened`). Fixes the confirmed image→video flash.
- Optional (only if video→image still flashes on Chromium 120): defer `video.opacity=0`+`pause()` by a
  double-`requestAnimationFrame` after raising the poster in `runVideoToImage` (quality-preserving).
- Verify on panel (`?debug`): all-image, all-video, mixed playlists — every transition + loop. Clean →
  stop. Still flashes/edge-cases → Phase 2.
- **Confidence:** high for the confirmed filter flash; best-effort (not future-proof) for the
  firmware-timing one. That ceiling is what justifies Phase 2.

## 3. PHASE 2 — Native AVPlay `.wgt` (MagicINFO-grade), if Phase 1 fails
**Architecture:** backend UNCHANGED (FastAPI + uniform AVPlay-compatible encodes + CMS); signed Tizen
`.wgt` wrapping the React UI; swap only the player to AVPlay (`webapis.avplay`/`avplaystore` two-player)
+ `config.xml` + `$WEBAPIS` wiring. Planes: AVPlay video (2 instances) behind; HTML (images/announcement/
colour band) above.

**Every case:** all-images → graphics crossfades (no plane); all-videos → two-player ring + StillMode,
loop wrap = warm hand-off; mixed → video↔video AVPlay hand-off, image↔image crossfade, video→image
(image overlay over held frame, then hide plane), image→video (prepare on idle player, fade overlay out
on first frame); single item handled; overlays always on top.

**Staged:** 2a PoC `.wgt` = [video→image→video] loop + StillMode → validate on panel; 2b full port only
if PoC passes. **Division:** I write player + config.xml + index.html wiring + build/sign/install runbook;
you run Tizen Studio build/sign/install + on-device check.

**Confidence:** correct architecture (MagicINFO's engine), de-risked by the PoC, **no blind guarantee**
of flawless-first-try (native on-device iteration expected).

## 4. Commit & docs strategy
Commit each step with `changes.md` entries; if switching to Phase 2, commit a note recording the exact
residual on-device symptom that forced it. Durable references: `docs/ambient-architecture.md`,
`docs/ambient-playback-findings-and-fallback.md`, `docs/tizen-avplay-seamless.md`, this `plan.md`.
