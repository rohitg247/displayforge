# Deployment steps — Tizen seamless-loop fix (engine v3.0)

Hand this to whoever runs the Docker deployment. Run everything **on the server** from the project
folder that contains `docker-compose.yml`. Commands assume Docker Compose v2 (`docker compose`); if the
server has the old binary, use `docker-compose` (with a hyphen) instead.

> What this deploys: the **seamless-loop** ambient-viewer fix — the live playlist is joined into ONE
> continuous video (lossless stream copy) and the panel plays it on a single `<video>` looped by a
> pre-end seek-to-0, so there is **no black between items and no black at the loop restart**. Plus a
> TV→URL debug-log endpoint. The two DB columns it needs are added automatically on backend startup —
> no manual migration.

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

## 3. Build the seamless-loop file for EXISTING displays  ← this is the step that fixes the black screens
```bash
docker compose exec backend python -m server.backfill_posters --playlist-videos
```
You should see `playlist-video  display   2 (…): built/updated -> /uploads/ambient-2-playlist-….mp4`
per display, then a `Playlist videos: built/updated=… total displays=…` summary, and (from ffmpeg)
`playlist-video: … <- N seg (copied=… encoded=…)` — `copied` are the lossless stream-copied clips.
Re-running it is safe (idempotent). New publishes rebuild the file automatically.

> Note: a display needs **2+ live items** to build a concat; a single live video is pointed at
> directly (also seamless). An all-image playlist stays on the per-item engine (images don't
> loop-black). `--playlist-videos` also runs the poster backfill (harmless/kept for the fallback).

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

**b. The seamless-loop file is set in the database** (should list `/uploads/ambient-…-playlist-….mp4`
or a single clip URL, not empty for displays with 2+ live items):
```bash
docker compose exec backend sqlite3 /data/signage.db \
  "SELECT id, playlist_video_path FROM ambient_displays;"
```

**c. The built file is a STREAM COPY (no quality loss)** — conforming clips keep the source codec:
```bash
docker compose exec backend ffprobe -v error -show_entries stream=codec_name,width,height \
  -of default=nk=1 /data/uploads/ambient-<id>-playlist-<sig>.mp4
```

**d. On the TV panel** — open the ambient viewer URL with `?debug=true` and check the on-screen panel:
- top line shows **`v3.0-seamless-loop · <build timestamp>`** (a fresh timestamp = this build is live),
- **`MODE: seamless-loop ✓`** (green). If it shows **`per-item engine (fallback)`**, the concat build
  failed — re-run **step 3** and check the backend logs.
- let it run **5+ full loops including the restart**: the log shows repeated **`pre-end seek → 0`** and
  **no black** at the loop wrap; `ERRORS: 0`.

**e. Read the on-panel log without watching the TV** — open in any browser on the same network:
```
http://<tv-host>:8888/api/ambient/<display-id>/debug-log/latest
```
(plain text; select-all → copy). It streams the FULL detailed transcript while the viewer runs with
`?debug=true`, updating every ~10 s. One append-only file per day is kept; logs older than **7 days**
are pruned automatically. Add `?date=YYYY-MM-DD` to view an earlier retained day (the page lists the
available days). Capture only happens while a panel has `?debug=true` open.

---

## Rollback
```bash
git checkout <previous-commit>
docker compose up -d --build backend frontend
```
All changes are additive (new files + a nullable DB column); rolling back the code is sufficient. The
generated poster files under `/data/uploads` are harmless if left in place.
