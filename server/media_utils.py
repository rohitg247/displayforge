"""Media helpers for ambient playback.

Two responsibilities, both best-effort and ffmpeg-only (no extra Python deps):

1. `extract_last_frame` — a JPEG "poster" of a video's last *visible* (non-black) frame. The Tizen
   viewer (`src/pages/AmbientViewerPage.jsx`) shows this poster as a real <img> cover at video-end, so
   the outgoing clip's last frame stays frozen on screen until the next clip decodes — masking the
   decode gap. A real <img> is immune to the Tizen hardware-video-overlay / canvas drawImage-black
   limitations a runtime canvas capture hits.

2. `normalize_video` — re-encode an upload to a Tizen-friendly MP4 (moov-at-front + uniform H.264,
   capped to the documented FullHD@30 decoder ceiling) so the first-frame decode gap is *shorter* and
   more consistent. It shortens, it does not eliminate, the gap; the poster handles the rest.
"""

import shutil
import subprocess
from pathlib import Path

# A frame whose mean luma (0-255) is below this is treated as (near-)black: useless as a freeze-frame.
LUMA_MIN = 18
# Offsets (seconds before EOF) to probe for the last visible frame, ordered closest-to-end first.
_CANDIDATE_OFFSETS = (0.1, 0.3, 0.6, 1.0, 1.5, 2.2)

# Documented Tizen 2.4–SSSP4 decoder ceiling (signageOS): FullHD @ 30 fps. We downscale/cap only when
# a source EXCEEDS this — never upscale, never touch <=30 fps sources (avoids judder).
_MAX_LONG_SIDE = 1920
_MAX_SHORT_SIDE = 1080
_MAX_FPS = 30


def ffmpeg_available() -> bool:
    """True if an `ffmpeg` binary is on PATH (installed in the backend Docker image)."""
    return shutil.which("ffmpeg") is not None


def _ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def _run(cmd, timeout):
    """Run a command, returning the CompletedProcess or None on spawn/timeout failure."""
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def _unlink_empty(path: Path):
    if path.exists() and path.stat().st_size == 0:
        try:
            path.unlink()
        except OSError:
            pass


def _probe_luma_at_eof(video_path: Path, offset: float, timeout: int):
    """Mean luma (0-255) of the frame `offset` seconds before EOF, or None on failure.

    Decodes a single frame, scales it to 1x1 in gray, and emits one raw byte = the average luma.
    Cheap (one-frame decode) and dependency-free."""
    cmd = [
        "ffmpeg", "-v", "error", "-sseof", f"-{offset}", "-i", str(video_path),
        "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
    ]
    proc = _run(cmd, timeout)
    if proc is not None and proc.returncode == 0 and proc.stdout:
        return proc.stdout[0]
    return None


def _extract_frame(video_path: Path, poster_path: Path, seek_args, timeout: int) -> bool:
    """Extract one JPEG using the given seek args (e.g. ['-sseof','-0.6'] or ['-ss','00:00:00'])."""
    cmd = (
        ["ffmpeg", "-y"] + seek_args + ["-i", str(video_path),
         "-frames:v", "1", "-q:v", "3", "-update", "1", str(poster_path)]
    )
    proc = _run(cmd, timeout)
    if proc is not None and proc.returncode == 0 and poster_path.exists() and poster_path.stat().st_size > 0:
        return True
    _unlink_empty(poster_path)
    return False


def extract_last_frame(video_path, poster_path, timeout: int = 30) -> bool:
    """Write a poster JPEG of `video_path`'s last *visible* (non-black) frame to `poster_path`.

    Many clips fade to — or hard-cut to — black at the very end, so a naive "0.2s before EOF" grab
    produces a black poster, which then instant-cuts to black on the panel and defeats the freeze-frame
    cover entirely. Instead:
      1. Probe several near-end offsets with a cheap 1x1 luma read.
      2. Pick the offset CLOSEST to the end whose mean luma >= LUMA_MIN (a real, visible frame).
      3. If none qualify (whole tail is dark), use the brightest candidate seen.
      4. Extract the full-res JPEG at that offset; if even that fails, fall back to the first frame.

    Never raises. A missing ffmpeg, decode failure, or timeout just returns False, and the viewer
    falls back to its canvas bridge. Returns True only when a non-empty file was written.
    """
    video_path = Path(video_path)
    poster_path = Path(poster_path)
    if not video_path.exists() or not ffmpeg_available():
        return False

    probe_timeout = min(timeout, 15)
    best_offset, best_luma = None, -1
    chosen_offset, chosen_luma = None, None
    for off in _CANDIDATE_OFFSETS:
        luma = _probe_luma_at_eof(video_path, off, probe_timeout)
        if luma is None:
            continue
        if luma > best_luma:
            best_luma, best_offset = luma, off
        if luma >= LUMA_MIN:
            chosen_offset, chosen_luma = off, luma  # offsets ordered end->back: first hit is latest
            break

    if chosen_offset is not None:
        target, target_luma = chosen_offset, chosen_luma
    else:
        target, target_luma = best_offset, best_luma

    if target is not None and _extract_frame(video_path, poster_path, ["-sseof", f"-{target}"], timeout):
        print(f"poster: {video_path.name} <- frame @ -{target}s (luma {target_luma})")
        return True

    if _extract_frame(video_path, poster_path, ["-ss", "00:00:00"], timeout):
        print(f"poster: {video_path.name} <- first frame (no bright near-end frame found)")
        return True
    return False


def _probe_video_meta(video_path: Path, timeout: int = 15):
    """Return (width, height, fps) for the first video stream, or (None, None, None) on failure."""
    if not _ffprobe_available():
        return (None, None, None)
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate",
        "-of", "csv=p=0", str(video_path),
    ]
    proc = _run(cmd, timeout)
    if proc is None or proc.returncode != 0 or not proc.stdout:
        return (None, None, None)
    parts = proc.stdout.decode("utf-8", "ignore").strip().split(",")
    if len(parts) < 3:
        return (None, None, None)
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError:
        return (None, None, None)
    fps = None
    fr = parts[2].strip()
    try:
        if "/" in fr:
            num, den = fr.split("/")
            fps = (float(num) / float(den)) if float(den) else None
        elif fr:
            fps = float(fr)
    except (ValueError, ZeroDivisionError):
        fps = None
    return (w, h, fps)


def _downscale_filter(w, h):
    """Return a scale filter string if (w,h) exceeds the FullHD ceiling, else None (never upscales)."""
    if not w or not h:
        return None
    long_side, short_side = max(w, h), min(w, h)
    if long_side <= _MAX_LONG_SIDE and short_side <= _MAX_SHORT_SIDE:
        return None
    # Fit inside an orientation-matched box, preserving aspect ratio, only shrinking.
    box_long, box_short = _MAX_LONG_SIDE, _MAX_SHORT_SIDE
    box_w, box_h = (box_long, box_short) if w >= h else (box_short, box_long)
    return f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease:force_divisible_by=2"


def normalize_video(src_path, dst_path, timeout: int = 300) -> bool:
    """Re-encode `src_path` to a Tizen-friendly MP4 at `dst_path` for faster, more consistent decode.

    Why this helps the decode-gap problem:
      - `-movflags +faststart` moves the MP4 moov atom to the front, so the Tizen demuxer can start
        decoding immediately instead of reading to EOF first (the biggest first-frame win).
      - H.264 High / yuv420p with the first frame as an IDR keyframe is the fastest path through the
        hardware decoder; a uniform profile across clips keeps swap timing consistent (matching
        encodes are the community/MagicInfo recommendation for smoother Tizen transitions).
      - A bounded GOP (`-g`) keeps seeks/keyframes cheap without hurting first-frame latency.
      - Output is capped to the documented FullHD@30 decoder ceiling (signageOS): a 4K/60 source would
        otherwise decode SLOWER and worsen the gap. We DOWNSCALE/CAP ONLY when a source exceeds the
        ceiling and NEVER upscale; <=30 fps sources are left untouched to avoid judder. Native
        resolution/aspect/frame rate are otherwise preserved (no distortion).

    Safe by construction: writes only to `dst_path` (never mutates the source), never raises, and
    returns True only when a non-empty output was produced. On any failure it removes a partial output
    and returns False so the caller can keep the original file untouched.
    """
    src_path = Path(src_path)
    dst_path = Path(dst_path)
    if not src_path.exists() or not ffmpeg_available():
        return False

    w, h, fps = _probe_video_meta(src_path)
    vf = _downscale_filter(w, h)

    cmd = ["ffmpeg", "-y", "-i", str(src_path), "-map", "0:v:0", "-map", "0:a:0?"]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-c:v", "libx264", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
        "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    ]
    if fps and fps > _MAX_FPS + 0.5:
        cmd += ["-r", str(_MAX_FPS)]
    cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst_path)]

    proc = _run(cmd, timeout)
    if proc is not None and proc.returncode == 0 and dst_path.exists() and dst_path.stat().st_size > 0:
        return True
    if dst_path.exists():
        try:
            dst_path.unlink()
        except OSError:
            pass
    return False
