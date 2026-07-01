"""Idempotent backfill for existing ambient videos.

Run from the project root (or inside the backend container):

    python -m server.backfill_posters              # posters only (safe, additive)
    python -m server.backfill_posters --normalize  # also re-encode clips for faster Tizen decode

Honours server.config.settings, so it uses the same DATABASE_PATH / UPLOAD_DIR as the app
(e.g. the Docker /data volume).

Default pass (posters only) — safe to run repeatedly:
  - skips rows that already have poster_path set,
  - reuses a poster file that already exists on disk (just links it in the DB),
  - only shells out to ffmpeg for videos still missing a poster.

--normalize pass (opt-in) — re-encodes each clip to a Tizen-friendly MP4 (`+faststart`, uniform
H.264 High / yuv420p) to shorten the first-frame decode gap. It is non-destructive in ordering:
the normalized file is written under a NEW name, the DB row is updated to point at it, and only
THEN are the old video + old poster removed. Because the served URL changes, the immutable cache
on the old URL is irrelevant (no stale-bytes risk). Idempotent: clips already named `*-norm.mp4`
are skipped.
"""

import argparse
import sqlite3
from pathlib import Path

from .config import settings
from .media_utils import extract_last_frame, extract_first_frame, normalize_video, ffmpeg_available


def _backfill_posters(conn, upload_dir, force=False) -> None:
    """Ensure every video row has a poster. Safe, additive, idempotent.

    Default: only fill rows MISSING a poster (rows with any poster_path are left alone).
    ``force=True`` (--force-posters): also REGENERATE rows whose poster is a legacy ``.jpg`` "soft
    poster" as a lossless ``.png`` (rows already on ``.png`` are left untouched). Ordering is DB-first —
    the new ``.png`` is written, the row is repointed, and only THEN is the superseded ``.jpg`` deleted —
    so a row is never left without a poster on disk (which would fall back to the Tizen canvas-bridge)."""
    rows = conn.execute(
        "SELECT id, file_path, poster_path FROM ambient_media WHERE media_type = 'video'"
    ).fetchall()

    generated = linked = skipped = failed = 0
    for r in rows:
        existing = r["poster_path"]
        is_png = bool(existing) and existing.lower().endswith(".png")
        # Skip when a poster is already set AND either we're not forcing, or it's already a .png.
        if existing and (not force or is_png):
            skipped += 1
            continue

        video_disk = upload_dir / Path(r["file_path"]).name
        poster_name = f"{video_disk.stem}-poster.png"  # lossless cover (matches upload path)
        poster_disk = upload_dir / poster_name
        poster_url = f"/uploads/{poster_name}"
        old_poster_name = Path(existing).name if existing else None

        def _repoint_and_prune():
            # DB-first: repoint to the new .png (already on disk), then drop the superseded old poster.
            conn.execute("UPDATE ambient_media SET poster_path = ? WHERE id = ?", (poster_url, r["id"]))
            conn.commit()
            if old_poster_name and old_poster_name != poster_name:
                old = upload_dir / old_poster_name
                if old.exists():
                    try:
                        old.unlink()
                    except OSError:
                        pass

        # Reuse an existing .png poster file if present (prior partial run, or already-regenerated).
        if poster_disk.exists() and poster_disk.stat().st_size > 0:
            _repoint_and_prune()
            linked += 1
            print(f"linked existing poster  media {r['id']:>4} -> {poster_url}")
            continue

        if extract_last_frame(video_disk, poster_disk):
            _repoint_and_prune()
            generated += 1
            tag = "regenerated (.jpg->.png)" if existing else "generated"
            print(f"{tag:<24} media {r['id']:>4} -> {poster_url}")
        else:
            failed += 1
            print(f"FAILED (missing file/decode)  media {r['id']:>4} ({r['file_path']})")

    print(
        f"Posters: generated={generated} linked={linked} "
        f"skipped(kept)={skipped} failed={failed}"
    )


def _normalize_existing(conn, upload_dir) -> None:
    """Re-encode each not-yet-normalized clip to a Tizen-friendly MP4 (opt-in). DB-first, then
    remove the old files only after a successful commit, so a failure never loses the original."""
    rows = conn.execute(
        "SELECT id, file_path, poster_path FROM ambient_media WHERE media_type = 'video'"
    ).fetchall()

    normalized = skipped = missing = failed = 0
    for r in rows:
        src_name = Path(r["file_path"]).name
        if src_name.endswith("-norm.mp4"):
            skipped += 1
            continue

        src_disk = upload_dir / src_name
        if not (src_disk.exists() and src_disk.stat().st_size > 0):
            missing += 1
            print(f"SKIP (missing source)   media {r['id']:>4} ({r['file_path']})")
            continue

        new_name = f"{src_disk.stem}-norm.mp4"
        new_disk = upload_dir / new_name
        # 3-state: 'skip' = already Tizen-optimal (leave the original untouched), 'written' = a -norm.mp4
        # was produced (repoint + remove old), 'failed' = keep the original.
        status = normalize_video(src_disk, new_disk)
        if status == "skip":
            skipped += 1
            print(f"skip (already optimal)  media {r['id']:>4} ({r['file_path']})")
            continue
        if status != "written":
            failed += 1
            print(f"FAILED normalize        media {r['id']:>4} ({r['file_path']})")
            continue

        # Regenerate the poster from the normalized file (new stem -> new poster name; lossless PNG).
        new_poster_name = f"{new_disk.stem}-poster.png"
        new_poster_disk = upload_dir / new_poster_name
        new_poster_url = (
            f"/uploads/{new_poster_name}" if extract_last_frame(new_disk, new_poster_disk) else None
        )
        new_url = f"/uploads/{new_name}"
        old_poster = r["poster_path"]

        # Commit the DB pointer first; the new files already exist on disk.
        conn.execute(
            "UPDATE ambient_media SET file_path = ?, poster_path = ? WHERE id = ?",
            (new_url, new_poster_url, r["id"]),
        )
        conn.commit()

        # Only now remove the superseded files (best-effort; URLs changed so no cache staleness).
        stale = [src_disk]
        if old_poster:
            stale.append(upload_dir / Path(old_poster).name)
        for f in stale:
            if f.exists():
                try:
                    f.unlink()
                except OSError:
                    pass

        normalized += 1
        print(f"normalized              media {r['id']:>4} -> {new_url} (poster: {new_poster_url})")

    print(
        f"Normalize: normalized={normalized} skipped(already -norm)={skipped} "
        f"missing={missing} failed={failed}"
    )


def _backfill_thumbs(conn, upload_dir) -> None:
    """Ensure every video row has a first-frame thumbnail for the admin media list. Additive, idempotent."""
    rows = conn.execute(
        "SELECT id, file_path, thumb_path FROM ambient_media WHERE media_type = 'video'"
    ).fetchall()

    generated = linked = skipped = failed = 0
    for r in rows:
        if r["thumb_path"]:
            skipped += 1
            continue
        video_disk = upload_dir / Path(r["file_path"]).name
        thumb_name = f"{video_disk.stem}-thumb.jpg"
        thumb_disk = upload_dir / thumb_name
        thumb_url = f"/uploads/{thumb_name}"
        if thumb_disk.exists() and thumb_disk.stat().st_size > 0:
            conn.execute("UPDATE ambient_media SET thumb_path = ? WHERE id = ?", (thumb_url, r["id"]))
            conn.commit()
            linked += 1
            print(f"linked existing thumb   media {r['id']:>4} -> {thumb_url}")
            continue
        if extract_first_frame(video_disk, thumb_disk):
            conn.execute("UPDATE ambient_media SET thumb_path = ? WHERE id = ?", (thumb_url, r["id"]))
            conn.commit()
            generated += 1
            print(f"generated thumb         media {r['id']:>4} -> {thumb_url}")
        else:
            failed += 1
            print(f"FAILED thumb (missing file/decode)  media {r['id']:>4} ({r['file_path']})")

    print(f"Thumbs: generated={generated} linked={linked} skipped(already set)={skipped} failed={failed}")


def _backfill_playlist_videos(conn, upload_dir) -> None:
    """Build the LOSSLESS joined clips (per-item video-run clips + the all-video MSE loop clip) for every
    display's live playlist, idempotently — so EXISTING displays get them without re-publishing from the
    UI. Reuses the exact router logic, so behaviour matches a normal publish (it also clears any legacy
    whole-playlist concat and prunes stale clips)."""
    from .routers.ambient_router import _regenerate_playlist_video

    rows = conn.execute("SELECT id, name FROM ambient_displays ORDER BY id").fetchall()
    total = 0
    for r in rows:
        _regenerate_playlist_video(conn, r["id"])
        clips = (
            sorted(p.name for p in upload_dir.glob(f"ambient-{r['id']}-run-*.mp4"))
            + sorted(p.name for p in upload_dir.glob(f"ambient-{r['id']}-mseloop-*.mp4"))
        )
        total += len(clips)
        print(f"joined-clips  display {r['id']:>4} ({r['name']}): {len(clips)} -> {clips or '—'}")
    print(f"Joined clips: total={total} across {len(rows)} displays")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill posters (and optionally normalize) ambient videos.")
    parser.add_argument(
        "--normalize",
        action="store_true",
        help="Also re-encode existing clips to a Tizen-friendly MP4 for faster decode "
             "(writes new files, updates DB, removes originals). Default: off.",
    )
    parser.add_argument(
        "--playlist-videos",
        action="store_true",
        help="Also build the lossless joined clips (adjacent video-run clips + the all-video MSE loop) "
             "for each display's live playlist. Safe/idempotent. Default: off.",
    )
    parser.add_argument(
        "--thumbs",
        action="store_true",
        help="Also generate first-frame thumbnails for existing videos (admin media list). "
             "Safe/idempotent. Default: off.",
    )
    parser.add_argument(
        "--force-posters",
        action="store_true",
        help="Regenerate legacy .jpg 'soft' posters as lossless .png (DB-first; deletes the old .jpg "
             "only after the new .png + DB pointer are in place). Rows already on .png are untouched. "
             "Default: off.",
    )
    args = parser.parse_args()

    if not ffmpeg_available():
        print("ffmpeg not found on PATH — cannot process videos. Aborting.")
        return

    upload_dir = Path(settings.UPLOAD_DIR)
    conn = sqlite3.connect(settings.DATABASE_PATH)
    conn.row_factory = sqlite3.Row

    # Opt-in normalization first: it rewrites file_path + poster_path, so the poster pass afterward
    # is a no-op for those rows (poster_path already set) and only catches anything left over.
    if args.normalize:
        _normalize_existing(conn, upload_dir)
    _backfill_posters(conn, upload_dir, force=args.force_posters)
    if args.thumbs:
        _backfill_thumbs(conn, upload_dir)
    if args.playlist_videos:
        _backfill_playlist_videos(conn, upload_dir)

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
