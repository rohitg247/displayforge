"""Media helpers for ambient playback.

Currently: extract a video's last frame to a JPEG "poster". The Tizen TV viewer
(`src/pages/AmbientViewerPage.jsx`) shows this poster as a real <img> cover during a
video->video swap, so the outgoing clip's last frame stays on screen until the next clip's
first frame is decoded — eliminating the black gap. A real <img> is immune to the Tizen
hardware-video-overlay / canvas drawImage-black limitations that a runtime canvas capture hits.
"""

import shutil
import subprocess
from pathlib import Path


def ffmpeg_available() -> bool:
    """True if an `ffmpeg` binary is on PATH (installed in the backend Docker image)."""
    return shutil.which("ffmpeg") is not None


def extract_last_frame(video_path, poster_path, timeout: int = 30) -> bool:
    """Write a poster JPEG of `video_path`'s final frame to `poster_path`.

    Strategy:
      1. Grab a frame ~0.2s before the end (`-sseof -0.2`) — the natural "last frame" to hold.
      2. If that fails (very short / non-seekable clip), retry the first frame at 00:00:00.

    Never raises. A missing ffmpeg, a decode failure, or a timeout just returns False, and the
    viewer falls back to its canvas bridge. Returns True only when a non-empty file was written.
    """
    video_path = Path(video_path)
    poster_path = Path(poster_path)
    if not video_path.exists():
        return False
    if not ffmpeg_available():
        return False

    attempts = (
        # Last frame: seek 0.2s before EOF, take one frame.
        ["ffmpeg", "-y", "-sseof", "-0.2", "-i", str(video_path),
         "-frames:v", "1", "-q:v", "3", "-update", "1", str(poster_path)],
        # Fallback: first frame at 00:00:00 for clips too short for the seek above.
        ["ffmpeg", "-y", "-ss", "00:00:00", "-i", str(video_path),
         "-frames:v", "1", "-q:v", "3", "-update", "1", str(poster_path)],
    )

    for cmd in attempts:
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return False
        if proc.returncode == 0 and poster_path.exists() and poster_path.stat().st_size > 0:
            return True
        # Clean a possible empty/partial output before the next attempt.
        if poster_path.exists() and poster_path.stat().st_size == 0:
            try:
                poster_path.unlink()
            except OSError:
                pass
    return False
