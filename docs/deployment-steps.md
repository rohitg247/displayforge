# Deployment steps — Tizen seamless-loop fix (engine v3.0)

Hand this to whoever runs the Docker deployment. Run everything **on the server** from the project
folder that contains `docker-compose.yml`. Commands assume Docker Compose v2 (`docker compose`); if the
server has the old binary, use `docker-compose` (with a hyphen) instead.

> What this deploys: the **full-quality hybrid** ambient-viewer fix (2026-06-16). The whole-playlist
> concat is retired (it baked images → quality loss, and produced decode-stall seams). Images render as
> native full-res `<img>`; videos play individually at full quality; **adjacent** videos are joined by a
> **lossless** stream copy; a video→video **loop wrap** is handled by a cyclic wrap-run + rotation; and
> an **all-video** playlist loops gaplessly via **MSE**. Plus the TV→URL debug-log endpoint. No manual DB
> migration. Full detail: `docs/ambient-playback-findings-and-fallback.md`.

---

## 1. Get the latest code
```bash
cd /path/to/Production          # the folder with docker-compose.yml
git pull
```

## 2. Rebuild + restart the BACKEND (ffmpeg + auto DB migration + cache headers)
```bash
docker compose up -d --build backend
```
This rebuilds the image (installs `ffmpeg`/`ffprobe`), auto-adds the `poster_path` column on startup,
and serves `/uploads` with cache headers. Wait ~10s for it to come up.

## 3. Build the lossless joined clips + clean up the old concat for EXISTING displays  ← one-time
```bash
docker compose exec backend python -m server.backfill_posters --playlist-videos
```
This calls the same router logic a publish does, for every display: it **clears the legacy
whole-playlist concat** (`ambient-<id>-playlist-*.mp4`) and its DB pointer, then builds the lossless
joined clips the live set needs — per-item **video-run** clips for adjacent videos, and an **MSE loop**
clip for an all-video playlist. Expect lines like `joined-clips  display   2 (…): N -> [..]` and a
`Joined clips: total=… across … displays` summary (plus ffmpeg `video-run:` / `mse-loop:` lines).
Idempotent; new publishes rebuild automatically.

> Note: a playlist with any image uses the **per-item engine** (no joined whole-playlist file needed);
> only **adjacent videos** and **all-video** playlists produce joined clips. Re-running is safe.

## 4. Rebuild + restart the FRONTEND (new playback engine v3.0-seamless-loop)
```bash
docker compose up -d --build frontend
```

---

## 5. Verify (2 minutes)

**a. ffmpeg + ffprobe are present in the backend:**
```bash
docker compose exec backend ffmpeg -version
docker compose exec backend ffprobe -version
```

**b. The legacy concat pointer is cleared** (should be empty/NULL for all displays now — the viewer runs
the per-item / MSE engine, not a whole-playlist concat):
```bash
docker compose exec backend sqlite3 /data/signage.db \
  "SELECT id, playlist_video_path FROM ambient_displays;"
```
And the broken file is gone: `docker compose exec backend ls /data/uploads | grep -- -playlist-` should
return nothing. Joined clips (if any) look like `ambient-<id>-run-<sig>.mp4` / `ambient-<id>-mseloop-<sig>.mp4`.

**c. A joined clip is a STREAM COPY (no quality loss)** — it keeps the source codec; `nb_read_packets`
shows monotonic PTS across the internal joins:
```bash
docker compose exec backend ffprobe -v error -show_entries stream=codec_name,width,height \
  -of default=nk=1 /data/uploads/ambient-<id>-run-<sig>.mp4
```

**d. On the TV panel** — open the ambient viewer URL with `?debug=true` and check the on-screen panel:
- top line shows the engine version + a **fresh build timestamp** (stale = the redeploy didn't land),
- **`MODE: per-item engine`** for a playlist with images, or **`MODE: mse-loop ✓ (all-video)`** for an
  all-video playlist; `ERRORS: 0`.
- let it run **5+ full loops including the restart**: **no black** at any transition or at the loop wrap
  (a brief frozen last-frame is OK; a TRUE black at a video edge → escalate to Approach 2 in
  `docs/ambient-playback-findings-and-fallback.md`); no stall at the old seam timestamps.

**e. Read the on-panel log without watching the TV** — open in any browser on the same network, at the
SAME origin + URL pattern as the viewer (just swap `?debug=true` for `/debug-log/latest`):
```
http://<host>:3200/<branchId>/2/<displayId>/debug-log/latest
```
e.g. for viewer `http://10.1.1.236:3200/2/2/4?debug=true` → `http://10.1.1.236:3200/2/2/4/debug-log/latest`.
It renders the FULL transcript (auto-refreshing ~10 s) while the viewer runs with `?debug=true`. One
append-only file per day is kept; logs older than **7 days** are pruned automatically. Add
`?date=YYYY-MM-DD` to view an earlier retained day. Capture only happens while a panel has `?debug=true`
open. (The page fetches from the backend via `VITE_API_URL` under the hood — no hardcoded port.)

---

## Rollback
```bash
git checkout <previous-commit>
docker compose up -d --build backend frontend
```
All changes are additive (new files + a nullable DB column); rolling back the code is sufficient. The
generated poster files under `/data/uploads` are harmless if left in place.
