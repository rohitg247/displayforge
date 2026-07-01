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

import json
import shutil
import subprocess
import tempfile
from collections import Counter
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


def _run_ok(cmd, dst_path: Path, timeout) -> bool:
    """Run `cmd`; True only if it exited 0 AND wrote a non-empty `dst_path`. On any failure, a partial
    output is removed so the caller can safely retry with a different command (or treat it as failed)."""
    proc = _run(cmd, timeout)
    if proc is not None and proc.returncode == 0 and dst_path.exists() and dst_path.stat().st_size > 0:
        return True
    if dst_path.exists():
        try:
            dst_path.unlink()
        except OSError:
            pass
    return False


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
    """Extract ONE still frame at the given seek args (e.g. ['-sseof','-0.6'] or ['-ss','00:00:00']).

    The output format follows the `poster_path` extension: a **.png** is written LOSSLESS (`rgb24`) so
    the freeze-frame cover is pixel-identical to the decoded video frame (kills the 'soft poster'); any
    other extension falls back to a near-lossless JPEG (`-q:v 2`). NO `-vf scale` — the poster keeps the
    video's NATIVE resolution, so there is no scale jump when it hard-cuts to the live video."""
    poster_path = Path(poster_path)
    fmt_args = ["-pix_fmt", "rgb24"] if poster_path.suffix.lower() == ".png" else ["-q:v", "2"]
    cmd = (
        ["ffmpeg", "-y"] + list(seek_args) + ["-i", str(video_path),
         "-frames:v", "1"] + fmt_args + ["-update", "1", str(poster_path)]
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


def extract_first_frame(video_path, thumb_path, timeout: int = 30) -> bool:
    """Write the video's FIRST frame to `thumb_path` (admin media-list thumbnail).

    Unlike the last-frame poster (a black-free freeze-frame cover for the panel), this is just a
    representative still for the admin grid, so we take the literal opening frame. PNG → lossless,
    any other extension → near-lossless JPEG. Never raises; returns True only on a non-empty file."""
    video_path = Path(video_path)
    if not video_path.exists() or not ffmpeg_available():
        return False
    return _extract_frame(video_path, Path(thumb_path), ["-ss", "00:00:00"], timeout)


def _moov_at_front(path: Path) -> bool:
    """True if the MP4 `moov` atom precedes `mdat` (the file is already `+faststart`).

    Best-effort top-level box-header scan: reads only the 8/16-byte box headers, never the payloads
    (seeks past each box), so it's cheap even on large files. Returns False on any parse issue or
    non-MP4 input — the caller then takes the lossless-remux path (which adds faststart)."""
    try:
        with path.open("rb") as f:
            while True:
                header = f.read(8)
                if len(header) < 8:
                    return False
                size = int.from_bytes(header[0:4], "big")
                box_type = header[4:8]
                if size == 1:                       # 64-bit largesize follows the type
                    ext = f.read(8)
                    if len(ext) < 8:
                        return False
                    size = int.from_bytes(ext, "big")
                    header_len = 16
                elif size == 0:                     # box runs to EOF (last box)
                    return box_type == b"moov"
                else:
                    header_len = 8
                if box_type == b"moov":
                    return True
                if box_type == b"mdat":
                    return False
                if size < header_len:
                    return False
                f.seek(size - header_len, 1)        # skip the rest of this box
    except OSError:
        return False


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


def _is_tizen_compatible(meta) -> bool:
    """True if a probed video stream can be served to the Tizen panel WITHOUT re-encoding: H.264,
    4:2:0, within the FullHD ceiling, and <=30 fps. (Container faststart is checked separately.)"""
    return bool(
        meta and meta.get("codec") == "h264"
        and meta.get("pix_fmt") in ("yuv420p", "yuvj420p")
        and _within_ceiling(meta.get("w") or 0, meta.get("h") or 0)
        and (not meta.get("fps") or meta["fps"] <= _MAX_FPS + 0.5)
    )


def normalize_video(src_path, dst_path, timeout: int = 300) -> str:
    """Make an uploaded video Tizen-friendly with the LEAST processing that preserves quality.

    Returns a 3-state status (NOT a bool) so the caller knows whether a new file was produced:
      - ``'skip'``    — source is already H.264/4:2:0/<=1080p/<=30fps **and** already `+faststart`
                        (moov at front). NOTHING is written; the caller serves the ORIGINAL byte-for-byte
                        (zero quality loss, zero work). The raw upload must be kept, not deleted.
      - ``'written'`` — a usable `dst_path` was produced: a **lossless remux** (`-c copy`, only relocating
                        the moov atom) when the stream is compatible but not faststart, or a high-quality
                        re-encode (`-crf 18`, capped to FullHD@30) when the source is genuinely
                        incompatible (HEVC/VP9, >1080p, >30fps, non-4:2:0). The caller serves `dst_path`.
      - ``'failed'``  — no usable output (ffmpeg missing / error). The caller keeps/serves the original.

    Why this design: re-encoding any already-H.264 clip is a needless generational quality loss. Most
    uploads are already H.264/1080p MP4s, so they take the lossless `'skip'`/remux paths; only odd
    formats are re-encoded, and then at near-transparent CRF 18, downscaling only above the documented
    Tizen FullHD@30 decoder ceiling (signageOS). Never mutates the source; never raises.
    """
    src_path = Path(src_path)
    dst_path = Path(dst_path)
    if not src_path.exists() or not ffmpeg_available():
        return "failed"

    meta = _probe_stream(src_path)
    compatible = _is_tizen_compatible(meta)

    # Tier 1 — already compatible AND faststart → serve the original untouched (no ffmpeg at all).
    if compatible and _moov_at_front(src_path):
        return "skip"

    # Tier 2 — compatible stream, moov at the back → LOSSLESS remux (relocate moov; video bytes intact).
    if compatible:
        cmd = ["ffmpeg", "-y", "-i", str(src_path), "-map", "0:v:0", "-map", "0:a:0?",
               "-c", "copy", "-movflags", "+faststart", str(dst_path)]
        if _run_ok(cmd, dst_path, timeout):
            return "written"
        # else fall through to a re-encode (unusual stream the muxer rejected)

    # Tier 3 — incompatible (or the lossless copy failed) → high-quality re-encode to the Tizen ceiling.
    vf = _downscale_filter(meta.get("w"), meta.get("h")) if meta else None
    cmd = ["ffmpeg", "-y", "-i", str(src_path), "-map", "0:v:0", "-map", "0:a:0?"]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-c:v", "libx264", "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18",
        "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    ]
    if meta and meta.get("fps") and meta["fps"] > _MAX_FPS + 0.5:
        cmd += ["-r", str(_MAX_FPS)]
    cmd += ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst_path)]
    if _run_ok(cmd, dst_path, timeout):
        return "written"
    return "failed"


# Default on-screen seconds for a still image when it is baked into the concatenated loop video.
IMAGE_SEGMENT_SECONDS = 5
# Closed-GOP / IDR-keyframe args shared by every generated segment, so concat join points AND the
# loop point (frame 0) are keyframes — clean cuts and an instant, glitch-free seek-to-0 loop.
_GOP_ARGS = ["-g", "60", "-keyint_min", "60", "-sc_threshold", "0"]
# Uniform audio spec used ONLY when audio is kept (see build_playlist_video include_audio). All
# segments are normalised to this so `-c copy` concat stays valid; video is never re-encoded for it.
_AUDIO_RATE = "44100"
_AUDIO_CH = "2"
_ANULLSRC = f"anullsrc=r={_AUDIO_RATE}:cl=stereo"


def _has_audio(path, timeout: int = 15) -> bool:
    """True if the file has at least one audio stream (used only on the include_audio path)."""
    if not _ffprobe_available():
        return False
    cmd = ["ffprobe", "-v", "error", "-select_streams", "a:0",
           "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)]
    proc = _run(cmd, timeout)
    return bool(proc is not None and proc.returncode == 0 and proc.stdout and proc.stdout.strip())


def _orientation_box(orientation: str):
    """Target (width, height) for a display orientation, at the FullHD decoder ceiling."""
    if orientation == "portrait":
        return (_MAX_SHORT_SIDE, _MAX_LONG_SIDE)   # 1080 x 1920
    return (_MAX_LONG_SIDE, _MAX_SHORT_SIDE)        # 1920 x 1080


def _probe_stream(video_path: Path, timeout: int = 15):
    """Return {codec, w, h, pix_fmt, fps} for the first video stream, or None on failure."""
    if not _ffprobe_available():
        return None
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,pix_fmt,avg_frame_rate",
        "-of", "csv=p=0", str(video_path),
    ]
    proc = _run(cmd, timeout)
    if proc is None or proc.returncode != 0 or not proc.stdout:
        return None
    parts = proc.stdout.decode("utf-8", "ignore").strip().split(",")
    if len(parts) < 5:
        return None
    try:
        codec, pix_fmt = parts[0].strip(), parts[3].strip()
        w, h = int(parts[1]), int(parts[2])
    except ValueError:
        return None
    fps, fr = None, parts[4].strip()
    try:
        if "/" in fr:
            num, den = fr.split("/")
            fps = (float(num) / float(den)) if float(den) else None
        elif fr:
            fps = float(fr)
    except (ValueError, ZeroDivisionError):
        fps = None
    return {"codec": codec, "w": w, "h": h, "pix_fmt": pix_fmt, "fps": fps}


def _within_ceiling(w, h):
    return max(w, h) <= _MAX_LONG_SIDE and min(w, h) <= _MAX_SHORT_SIDE


# ----------------------------------------------------------------------------------------------
# Image-safety contract (uploads). Mirrors the video pipeline's "least processing that preserves
# quality" rule: an image is left byte-for-byte unless it EXCEEDS the FullHD ceiling, in which case it
# is downscaled ONCE (Lanczos, aspect preserved, never upscaled/cropped). Aspect vs the display target
# is only WARNED about (or rejected under AMBIENT_IMAGE_STRICT) — never silently altered.
# ----------------------------------------------------------------------------------------------

def probe_image(path, timeout: int = 15):
    """Return {w, h} for an image file (ffprobe reads it as a single-frame stream), or None on failure."""
    if not _ffprobe_available():
        return None
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)]
    proc = _run(cmd, timeout)
    if proc is None or proc.returncode != 0 or not proc.stdout:
        return None
    parts = proc.stdout.decode("utf-8", "ignore").strip().split(",")
    try:
        return {"w": int(parts[0]), "h": int(parts[1])}
    except (ValueError, IndexError):
        return None


def normalize_image(src_path, dst_path, timeout: int = 60) -> str:
    """Downscale an OVERSIZED upload image to the Tizen FullHD ceiling once (high quality), else skip.

    3-state, mirroring ``normalize_video``:
      - ``'skip'``    — already within 1920x1080 (either orientation): nothing written; serve the ORIGINAL.
      - ``'written'`` — a downscaled ``dst_path`` was produced (aspect preserved, Lanczos, never upscaled).
      - ``'failed'``  — ffmpeg missing / probe or encode error: caller keeps the original.

    Never upscales, never crops, never raises. PNG stays lossless; JPEG/WebP use a near-lossless -q:v 2.
    """
    src_path = Path(src_path)
    dst_path = Path(dst_path)
    if not src_path.exists() or not ffmpeg_available():
        return "failed"
    meta = probe_image(src_path)
    if not meta:
        return "failed"
    vf = _downscale_filter(meta["w"], meta["h"])
    if not vf:
        return "skip"                       # within the ceiling — no resample needed
    vf = vf + ":flags=lanczos"
    fmt_args = [] if dst_path.suffix.lower() == ".png" else ["-q:v", "2"]
    cmd = ["ffmpeg", "-y", "-i", str(src_path), "-vf", vf, "-frames:v", "1"] + fmt_args + [str(dst_path)]
    if _run_ok(cmd, dst_path, timeout):
        return "written"
    return "failed"


def image_aspect_warning(w, h, orientation, tolerance):
    """Return a human-readable warning if (w,h) deviates from the display's target aspect
    (16:9 landscape / 9:16 portrait) by more than `tolerance` (fraction of the target), else None."""
    if not w or not h:
        return None
    target_w, target_h = _orientation_box(orientation)   # 1920x1080 or 1080x1920
    target = target_w / target_h
    actual = w / h
    if abs(actual - target) / target > tolerance:
        return (f"image aspect {w}x{h} (~{actual:.2f}:1) differs from the {orientation} target "
                f"{target_w}x{target_h} (~{target:.2f}:1); it will be cropped (object-fit: cover)")
    return None


def _pick_target_spec(video_metas, orientation):
    """Pick the concat target (w, h, fps): the most common geometry among in-spec H.264/yuv420p
    videos (so the MOST clips can be stream-copied losslessly), else the orientation box @30."""
    geos, fpss = Counter(), Counter()
    for m in video_metas:
        if not m or m["codec"] != "h264" or m["pix_fmt"] != "yuv420p" or not _within_ceiling(m["w"], m["h"]):
            continue
        geos[(m["w"], m["h"])] += 1
        if m["fps"]:
            fpss[min(round(m["fps"]), _MAX_FPS)] += 1
    tw, th = geos.most_common(1)[0][0] if geos else _orientation_box(orientation)
    tfps = fpss.most_common(1)[0][0] if fpss else _MAX_FPS
    return tw, th, tfps


def _conforms(meta, tw, th, tfps):
    """True if a video can be stream-copied into the concat as-is (geometry/codec/fps match)."""
    return bool(
        meta and meta["codec"] == "h264" and meta["pix_fmt"] == "yuv420p"
        and meta["w"] == tw and meta["h"] == th
        and meta["fps"] and round(meta["fps"]) == round(tfps)
    )


def _remux_copy_segment(src, dst, timeout, include_audio=False) -> bool:
    """LOSSLESS copy of a conforming video's picture into a concat segment (`-c:v copy`). The video is
    never re-encoded — bytes identical. By default audio is stripped (`-an`) so segments share a
    video-only layout. When include_audio is on, audio is normalised to the uniform AAC spec (a silent
    track is synthesised if the source has none) so the segment still matches its peers — the VIDEO is
    still a pure stream copy."""
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if include_audio and not _has_audio(src):
        cmd += ["-f", "lavfi", "-i", _ANULLSRC]
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                "-c:a", "aac", "-ar", _AUDIO_RATE, "-ac", _AUDIO_CH, "-shortest"]
    elif include_audio:
        cmd += ["-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
                "-c:a", "aac", "-ar", _AUDIO_RATE, "-ac", _AUDIO_CH]
    else:
        cmd += ["-map", "0:v:0", "-c:v", "copy", "-an"]
    cmd += ["-movflags", "+faststart", str(dst)]
    proc = _run(cmd, timeout)
    return proc is not None and proc.returncode == 0 and Path(dst).exists() and Path(dst).stat().st_size > 0


def _encode_segment(src, dst, w, h, fps, timeout, is_image=False,
                    image_seconds=IMAGE_SEGMENT_SECONDS, include_audio=False) -> bool:
    """Encode ONE input to a segment at the exact (w,h,fps) concat spec. Used for every still image
    (no motion to degrade) and only for the occasional video that doesn't already conform. Cover-scale
    + crop matches the viewer's objectFit:cover (no bars); CRF 16 is visually lossless. When
    include_audio is on, every segment gets a uniform AAC track (the source's audio, or synthesised
    silence for images / silent videos) so `-c copy` concat stays valid."""
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,"
          f"crop={w}:{h},setsar=1,fps={fps},format=yuv420p")
    cmd = ["ffmpeg", "-y"]
    if is_image:
        cmd += ["-loop", "1", "-t", str(image_seconds), "-i", str(src)]
    else:
        cmd += ["-i", str(src)]
    # Decide the audio source (input index) before assembling output maps.
    synth_audio = include_audio and (is_image or not _has_audio(src))
    if synth_audio:
        cmd += ["-f", "lavfi", "-i", _ANULLSRC]
    cmd += ["-map", "0:v:0", "-vf", vf,
            "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
            "-preset", "veryfast", "-crf", "16"] + _GOP_ARGS
    if include_audio:
        cmd += (["-map", "1:a:0", "-shortest"] if synth_audio else ["-map", "0:a:0"])
        cmd += ["-c:a", "aac", "-ar", _AUDIO_RATE, "-ac", _AUDIO_CH]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", str(dst)]
    proc = _run(cmd, timeout)
    return proc is not None and proc.returncode == 0 and Path(dst).exists() and Path(dst).stat().st_size > 0


def build_playlist_video(items, dst_path, orientation, image_seconds: int = IMAGE_SEGMENT_SECONDS,
                         timeout: int = 600, include_audio: bool = False) -> bool:
    """Join a playlist's clips/images into ONE continuous loop video with NO re-encode of conforming
    video (stream copy). The Tizen panel then plays the whole playlist from a single <video>: no
    `src` swaps mid-playlist (no per-clip black gap) and — with the viewer's pre-end seek-to-0 loop —
    no black at the loop restart either.

    Quality policy (user-approved): clips already sharing the dominant H.264/yuv420p geometry are
    **stream-copied byte-for-byte** (the video is never re-encoded). Still images are encoded once
    (no motion to degrade). Only a non-conforming video is re-encoded once to the target spec. The
    join itself is `ffmpeg -f concat -c copy` — zero re-encode of the joined stream.

    `items`: ordered dicts with absolute `file_path` + `media_type` ('video'|'image') and an optional
    per-item `duration` (seconds, images only; falls back to `image_seconds`). `include_audio` keeps a
    uniform AAC track in the output (default OFF — the player is muted; the video is still copied
    losslessly either way). Safe by construction: writes only `dst_path`, never raises, returns True
    only on a non-empty output.
    """
    dst_path = Path(dst_path)
    if not ffmpeg_available():
        return False

    present = [it for it in items
               if Path(it["file_path"]).exists() and Path(it["file_path"]).stat().st_size > 0]
    if not present:
        return False

    video_metas = [
        _probe_stream(Path(it["file_path"])) if it.get("media_type") != "image" else None
        for it in present
    ]
    tw, th, tfps = _pick_target_spec(video_metas, orientation)
    seg_timeout = max(60, timeout // max(1, len(present)))
    copied = encoded = 0

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            seg_paths = []
            for i, it in enumerate(present):
                seg = tmp / f"seg{i:03d}.mp4"
                src = Path(it["file_path"])
                if it.get("media_type") == "image":
                    secs = it.get("duration") or image_seconds
                    ok = _encode_segment(src, seg, tw, th, tfps, seg_timeout, is_image=True,
                                         image_seconds=secs, include_audio=include_audio)
                    encoded += 1 if ok else 0
                elif _conforms(video_metas[i], tw, th, tfps):
                    ok = _remux_copy_segment(src, seg, seg_timeout, include_audio=include_audio)
                    if ok:
                        copied += 1
                    else:  # lossless remux failed for some reason — re-encode as a fallback
                        ok = _encode_segment(src, seg, tw, th, tfps, seg_timeout, include_audio=include_audio)
                        encoded += 1 if ok else 0
                else:
                    ok = _encode_segment(src, seg, tw, th, tfps, seg_timeout, include_audio=include_audio)
                    encoded += 1 if ok else 0
                if ok:
                    seg_paths.append(seg)

            if not seg_paths:
                return False

            list_file = tmp / "concat.txt"
            list_file.write_text("".join(f"file '{p.as_posix()}'\n" for p in seg_paths), encoding="utf-8")
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
                   "-c", "copy", "-movflags", "+faststart", str(dst_path)]
            proc = _run(cmd, timeout)
            if proc is not None and proc.returncode == 0 and dst_path.exists() and dst_path.stat().st_size > 0:
                print(f"playlist-video: {dst_path.name} <- {len(seg_paths)} seg "
                      f"(copied={copied} encoded={encoded}) @ {tw}x{th}@{tfps}")
                return True
    except OSError:
        pass

    if dst_path.exists():
        try:
            dst_path.unlink()
        except OSError:
            pass
    return False


# ----------------------------------------------------------------------------------------------
# Lossless video-run concat (hybrid engine). A "run" is ≥2 ADJACENT playlist videos. When they are
# stream-copy-concat-safe we join them into ONE clip so the run plays as a single never-reloaded
# <video> on Tizen (motion-seamless, no decode gap, zero quality loss). Images are NEVER joined here.
# ----------------------------------------------------------------------------------------------

def _parse_fps(fr):
    """Parse an ffprobe rate string ('30000/1001', '25', '') → float fps, or None."""
    if not fr:
        return None
    try:
        s = str(fr)
        if "/" in s:
            num, den = s.split("/")
            return (float(num) / float(den)) if float(den) else None
        return float(s)
    except (ValueError, ZeroDivisionError):
        return None


def _to_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _fps_key(fps):
    """Round fps so 29.97 vs 30.0 compare equal for the concat gate (real mismatches still differ)."""
    return round(fps) if fps else None


def _probe_run_meta(path: Path, timeout: int = 15):
    """Probe ONLY the fields that decide stream-copy-concat safety (dict, or None on failure).

    'Same codec/res/fps' is necessary but NOT sufficient: two H.264/1080p/30 clips can still differ in
    timebase, SAR, start-PTS, or carry edit lists — the exact mismatches that freeze the decoder at a
    join. So we also read time_base / sample_aspect_ratio / start_pts / format.start_time."""
    if not _ffprobe_available():
        return None
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries",
        "stream=codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,time_base,"
        "sample_aspect_ratio,start_pts:format=start_time",
        "-of", "json", str(path),
    ]
    proc = _run(cmd, timeout)
    if proc is None or proc.returncode != 0 or not proc.stdout:
        return None
    try:
        data = json.loads(proc.stdout.decode("utf-8", "ignore") or "{}")
        st = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
    except (ValueError, IndexError):
        return None
    return {
        "codec": st.get("codec_name"),
        "profile": st.get("profile"),
        "level": st.get("level"),
        "w": st.get("width"),
        "h": st.get("height"),
        "pix_fmt": st.get("pix_fmt"),
        "fps": _parse_fps(st.get("avg_frame_rate")),
        "time_base": st.get("time_base"),
        "sar": st.get("sample_aspect_ratio") or "1:1",
        "start_pts": st.get("start_pts"),
        "start_time": _to_float(fmt.get("start_time")),
    }


def _run_concat_compatible(metas) -> bool:
    """True iff EVERY segment shares the bitstream/geometry params that make a `-c copy` concat safe
    AND each starts clean (PTS 0, no container start offset → proxy for 'no edit list'). Any mismatch
    here is what reintroduces the `rs=2` decoder freeze, so the gate is deliberately strict."""
    if not metas or len(metas) < 2 or any(m is None for m in metas):
        return False
    first = metas[0]
    if first.get("codec") != "h264":
        return False
    eps = 0.001
    for m in metas:
        if (m.get("codec") != first.get("codec")
                or m.get("profile") != first.get("profile")
                or m.get("level") != first.get("level")
                or m.get("w") != first.get("w")
                or m.get("h") != first.get("h")
                or m.get("pix_fmt") != first.get("pix_fmt")
                or m.get("sar") != first.get("sar")
                or m.get("time_base") != first.get("time_base")
                or _fps_key(m.get("fps")) != _fps_key(first.get("fps"))):
            return False
        if m.get("start_pts") not in (0, None) or abs(_to_float(m.get("start_time"))) > eps:
            return False
    return True


def _normalize_run_timing(src: Path, dst: Path, timeout: int = 120) -> bool:
    """LOSSLESS container remux that makes a clip concat-safe WITHOUT re-encoding: unify the timescale,
    zero the start PTS, strip edit lists, faststart. Video/audio bitstreams are copied byte-for-byte."""
    cmd = ["ffmpeg", "-y", "-fflags", "+genpts", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
           "-c", "copy", "-avoid_negative_ts", "make_zero", "-muxpreload", "0", "-muxdelay", "0",
           "-video_track_timescale", "90000", "-movflags", "+faststart", str(dst)]
    return _run_ok(cmd, dst, timeout)


def build_video_run(src_paths, dst_path, timeout: int = 600) -> bool:
    """Join an ordered list of ADJACENT playlist videos into ONE lossless clip (`-f concat -c copy`).

    The video bitstream is NEVER re-encoded — bytes identical. Re-validates compatibility here (so the
    caller can call it optimistically) and returns False — caller falls back to per-item playback — when
    the clips cannot be safely stream-copied together. Strategy:
      1. If all segments already pass the strict concat gate → concat-copy directly.
      2. Else apply the lossless timing widener to each (normalizes timebase/start/edit-lists without
         re-encoding) and re-probe; if NOW compatible → concat-copy.
      3. Else → return False (per-item fallback).
    Safe-by-construction: writes only `dst_path`, never raises, returns True only on a non-empty output.
    """
    dst_path = Path(dst_path)
    paths = [Path(p) for p in src_paths]
    if len(paths) < 2 or not ffmpeg_available():
        return False
    if not all(p.exists() and p.stat().st_size > 0 for p in paths):
        return False

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            metas = [_probe_run_meta(p) for p in paths]
            if not _run_concat_compatible(metas):
                widened = []
                for i, p in enumerate(paths):
                    w = tmp / f"w{i:03d}.mp4"
                    if not _normalize_run_timing(p, w, timeout):
                        return False
                    widened.append(w)
                paths = widened
                if not _run_concat_compatible([_probe_run_meta(p) for p in paths]):
                    return False

            list_file = tmp / "run.txt"
            list_file.write_text("".join(f"file '{p.as_posix()}'\n" for p in paths), encoding="utf-8")
            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
                   "-c", "copy", "-movflags", "+faststart", str(dst_path)]
            if _run_ok(cmd, dst_path, timeout):
                print(f"video-run: {dst_path.name} <- {len(paths)} clips (lossless stream copy)")
                return True
    except OSError:
        pass
    if dst_path.exists():
        try:
            dst_path.unlink()
        except OSError:
            pass
    return False


# ----------------------------------------------------------------------------------------------
# MSE gapless loop (ALL-VIDEO playlists, no image to absorb the loop restart). We build ONE fragmented,
# video-only MP4 (lossless stream copy of all the playlist's videos) that the viewer loops via Media
# Source Extensions — one <video>, segments appended on a ring, so it NEVER ends / reloads / seeks
# (the only black-free way to loop pure video in the Tizen 7.0 / Chromium browser).
# ----------------------------------------------------------------------------------------------

# H.264 profile name (ffprobe) → profile_idc, for the MSE 'avc1.PPCCLL' codec string.
_AVC_PROFILE_IDC = {
    "Constrained Baseline": 0x42, "Baseline": 0x42, "Main": 0x4D, "Extended": 0x58,
    "High": 0x64, "High 10": 0x6E, "High 4:2:2": 0x7A, "High 4:4:4 Predictive": 0xF4,
}


def _mse_mime(meta) -> str:
    """Best-effort MSE mime for a video-only H.264 fMP4: `video/mp4; codecs="avc1.PPCCLL"` (profile_idc,
    constraint flags 00, level_idc). Falls back to a bare `video/mp4` if the profile/level is unknown."""
    if meta and meta.get("codec") == "h264":
        prof = _AVC_PROFILE_IDC.get((meta.get("profile") or "").strip())
        lvl = meta.get("level")
        if prof is not None and isinstance(lvl, int) and lvl > 0:
            return f'video/mp4; codecs="avc1.{prof:02X}00{lvl:02X}"'
    return "video/mp4"


def _remux_video_only_uniform(src: Path, dst: Path, timeout: int = 120) -> bool:
    """LOSSLESS: copy ONLY the video stream into `dst`, zeroing start PTS, unifying timescale, and
    stripping edit lists — so every segment of an MSE loop has an identical, clean, video-only layout
    (audio is irrelevant — the panel plays muted). Video bytes are copied untouched."""
    cmd = ["ffmpeg", "-y", "-fflags", "+genpts", "-i", str(src), "-map", "0:v:0", "-an",
           "-c", "copy", "-avoid_negative_ts", "make_zero", "-muxpreload", "0", "-muxdelay", "0",
           "-video_track_timescale", "90000", "-movflags", "+faststart", str(dst)]
    return _run_ok(cmd, dst, timeout)


def build_mse_loop(src_paths, dst_path, timeout: int = 600) -> bool:
    """Build a FRAGMENTED, video-only MP4 = lossless concat of an ALL-VIDEO playlist, for MSE looping.

    Also writes a `<dst>.codecs` sidecar with the MSE mime string the viewer needs to create its
    SourceBuffer. Lossless (stream copy). Returns False — caller falls back to the per-item engine — if
    the clips can't be safely joined (different codec/res/fps/SAR). Safe-by-construction: writes only
    `dst_path` (+ sidecar), never raises, returns True only on a non-empty output.
    """
    dst_path = Path(dst_path)
    paths = [Path(p) for p in src_paths]
    if not paths or not ffmpeg_available():
        return False
    if not all(p.exists() and p.stat().st_size > 0 for p in paths):
        return False
    frag = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof"]
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            segs = []
            for i, p in enumerate(paths):
                seg = tmp / f"v{i:03d}.mp4"
                if not _remux_video_only_uniform(p, seg, timeout):
                    return False
                segs.append(seg)
            # ≥2 segments must share codec/res/fps/SAR to stream-copy-concat safely.
            if len(segs) >= 2 and not _run_concat_compatible([_probe_run_meta(s) for s in segs]):
                return False

            if len(segs) == 1:
                ok = _run_ok(["ffmpeg", "-y", "-i", str(segs[0]), "-c", "copy"] + frag + [str(dst_path)],
                             dst_path, timeout)
            else:
                list_file = tmp / "loop.txt"
                list_file.write_text("".join(f"file '{s.as_posix()}'\n" for s in segs), encoding="utf-8")
                ok = _run_ok(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
                              "-c", "copy"] + frag + [str(dst_path)], dst_path, timeout)
            if ok:
                mime = _mse_mime(_probe_run_meta(dst_path) or _probe_run_meta(segs[0]))
                try:
                    Path(str(dst_path) + ".codecs").write_text(mime, encoding="utf-8")
                except OSError:
                    pass
                print(f"mse-loop: {dst_path.name} <- {len(paths)} clip(s) [{mime}]")
                return True
    except OSError:
        pass
    if dst_path.exists():
        try:
            dst_path.unlink()
        except OSError:
            pass
    return False
