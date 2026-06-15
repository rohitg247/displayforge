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
