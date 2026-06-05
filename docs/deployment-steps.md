# Deployment steps — Tizen poster-freeze fix

Hand this to whoever runs the Docker deployment. Run everything **on the server** from the project
folder that contains `docker-compose.yml`. Commands assume Docker Compose v2 (`docker compose`); if the
server has the old binary, use `docker-compose` (with a hyphen) instead.

> What this deploys: the ambient-viewer black-screen fix (last-frame poster cover), faster/normalized
> video decode, `/uploads` cache headers, and on-screen version/poster diagnostics. The DB column it
> needs is added automatically on backend startup — no manual migration.

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

## 3. Generate posters for the EXISTING videos  ← this is the step that fixes the current black screens
```bash
docker compose exec backend python -m server.backfill_posters
```
You should see lines like `generated poster  media   4 -> /uploads/...-poster.jpg` and a final
`Posters: generated=… linked=… skipped=… failed=…`. Re-running it is safe (idempotent).

Optional (also re-encodes existing clips for faster decode — takes longer, safe to skip):
```bash
docker compose exec backend python -m server.backfill_posters --normalize
```

## 4. Rebuild + restart the FRONTEND (new playback engine v2.2-poster-freeze)
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

**b. Posters are set in the database** (should list `/uploads/...-poster.jpg`, not empty):
```bash
docker compose exec backend sqlite3 /data/signage.db \
  "SELECT id, poster_path FROM ambient_media WHERE media_type='video';"
```

**c. `/uploads` returns cache + range headers** (replace `<FILE>` with a real uploaded filename):
```bash
curl -I http://localhost:8888/uploads/<FILE>
# expect:  Cache-Control: public, max-age=31536000, immutable
#          Accept-Ranges: bytes
```

**d. On the TV panel** — open the ambient viewer URL with `?debug=true` and check the on-screen panel:
- top line shows **`v2.2-poster-freeze · <build timestamp>`** (a fresh timestamp = this build is live),
- a line shows **`posters: N/N videos`** (both numbers equal),
- when a video ends, the log shows **`cover: poster (last frame)`** and the last frame holds (no black,
  no fade). You should **not** see `cover: bridge BLACK — poster missing`.

If (d) still shows `posters: 0/N` or `cover: bridge`, re-run **step 3** and confirm step 4 redeployed
(timestamp changed).

---

## Rollback
```bash
git checkout <previous-commit>
docker compose up -d --build backend frontend
```
All changes are additive (new files + a nullable DB column); rolling back the code is sufficient. The
generated poster files under `/data/uploads` are harmless if left in place.
