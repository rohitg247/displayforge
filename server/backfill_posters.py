"""Idempotent backfill: generate last-frame poster JPEGs for existing ambient videos.

Run from the project root (or inside the backend container):

    python -m server.backfill_posters

Honours server.config.settings, so it uses the same DATABASE_PATH / UPLOAD_DIR as the app
(e.g. the Docker /data volume). Safe to run repeatedly:
  - skips rows that already have poster_path set,
  - reuses a poster file that already exists on disk (just links it in the DB),
  - only shells out to ffmpeg for videos still missing a poster.
"""

import sqlite3
from pathlib import Path

from .config import settings
from .media_utils import extract_last_frame, ffmpeg_available


def main() -> None:
    if not ffmpeg_available():
        print("ffmpeg not found on PATH — cannot generate posters. Aborting.")
        return

    upload_dir = Path(settings.UPLOAD_DIR)
    conn = sqlite3.connect(settings.DATABASE_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, file_path, poster_path FROM ambient_media WHERE media_type = 'video'"
    ).fetchall()

    generated = linked = skipped = failed = 0
    for r in rows:
        if r["poster_path"]:
            skipped += 1
            continue

        video_disk = upload_dir / Path(r["file_path"]).name
        poster_name = f"{video_disk.stem}-poster.jpg"
        poster_disk = upload_dir / poster_name
        poster_url = f"/uploads/{poster_name}"

        # Reuse an existing poster file if present (e.g. a prior partial run).
        if poster_disk.exists() and poster_disk.stat().st_size > 0:
            conn.execute("UPDATE ambient_media SET poster_path = ? WHERE id = ?", (poster_url, r["id"]))
            conn.commit()
            linked += 1
            print(f"linked existing poster  media {r['id']:>4} -> {poster_url}")
            continue

        if extract_last_frame(video_disk, poster_disk):
            conn.execute("UPDATE ambient_media SET poster_path = ? WHERE id = ?", (poster_url, r["id"]))
            conn.commit()
            generated += 1
            print(f"generated poster        media {r['id']:>4} -> {poster_url}")
        else:
            failed += 1
            print(f"FAILED (missing file/decode)  media {r['id']:>4} ({r['file_path']})")

    conn.close()
    print(
        f"Done. generated={generated} linked={linked} "
        f"skipped(already set)={skipped} failed={failed}"
    )


if __name__ == "__main__":
    main()
