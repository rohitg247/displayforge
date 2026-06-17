import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';

const IMAGE_DURATION = 5000;
const CROSSFADE_DURATION = 500;
// Tizen's hardware decoder takes ~1400-1900ms to present a video's first frame after src+load().
// The bridge canvas (video->video) and the held outgoing image (image->video) cover this entire
// window with real pixels, so a generous timeout has zero visual cost — it just lets the decode
// complete naturally before any cover is released.
const SWAP_TIMEOUT_MS = 4000;
const POLL_INTERVAL = 5000;
const DECODE_SLOW_THRESHOLD_MS = 800;
const FRAME_STUCK_WARN_MS = 500;
const LOG_RING_SIZE = 60;
const DEBUG_TICK_MS = 200;
// Seamless-loop mode: seek back to 0 this many seconds BEFORE the true end so the decoder never hits
// end-of-stream (Tizen blanks the plane at `ended`) and never reloads — a gapless, black-free loop
// restart. A backward seek on the still-playing element BEFORE EOF does NOT tear down the HW decoder
// (it just jumps to the IDR at frame 0 and keeps presenting), so the seam stays black-free; the ONLY
// requirement is to land that seek before the stream can end. A 1.5s lead keeps the decoder well away
// from the fragile end-of-stream boundary and gives the ~100ms setInterval watchdog ~15 attempts to
// land the seek. The trimmed 1.5s tail is invisible on an endlessly-looping playlist (just slightly
// shorter each cycle — never black). Polled by setInterval, NOT rAF (Tizen throttles rAF while the
// HW video plane is composited; setInterval keeps firing).
const SINGLE_SEEK_LEAD = 1.5;
const SINGLE_TICK_MS = 100;        // watchdog poll interval (reliable during HW video playback)
const SINGLE_HEARTBEAT_MS = 2000;  // how often the watchdog logs a ct/dur/paused/ended/rs/ns heartbeat
const SINGLE_LOAD_BREAKER_MS = 1500; // ct pinned at EOF this long with retries exhausted → load() breaker
const DEBUG_POST_INTERVAL_MS = 10000;
// While ?debug is open, EVERY event is buffered and streamed to the backend (full detail, not a
// rolling window). The buffer survives transient network failures; cap it so a long backend outage
// can't grow it unbounded, and cap each POST so a catch-up batch stays under the server's body limit.
const DEBUG_PENDING_CAP = 8000;
const DEBUG_BATCH_MAX = 1000;

// D2 contingency knob. Only flip to true after on-device evidence that the
// onended-time frame is consistently unpaintable on a given Tizen firmware.
const EARLY_BRIDGE_CAPTURE = false;
const EARLY_BRIDGE_LEAD_MS = 250;

const STATE_IDLE = 'IDLE';
const STATE_PLAYING = 'PLAYING';
const STATE_SWAPPING = 'SWAPPING';

const COLOR_BY_CLASS = {
  lifecycle: '#9cf',
  success: '#7f7',
  warn: '#ff7',
  error: '#f77',
  state: '#fc7',
  verbose: '#ccc',
};

const basename = (p) => (p ? p.split('/').pop() : '');

/* global __AMBIENT_BUILD__ */
// Bump ENGINE_VERSION whenever the playback/transition logic changes; __AMBIENT_BUILD__ is the
// build timestamp injected by Vite (see vite.config.js `define`). Both are printed in the on-screen
// debugger so the exact build running on a panel can be confirmed at a glance — no guessing whether
// a redeploy landed. Falls back to 'dev' under Vitest, which doesn't apply Vite `define`.
const ENGINE_VERSION = '3.1-loop-hardened';
const BUILD_STAMP = (typeof __AMBIENT_BUILD__ !== 'undefined') ? __AMBIENT_BUILD__ : 'dev';

// Both the Samsung panel and a regular browser (laptop/desktop) can open ?debug=true and stream to the
// SAME day-file, so tag every snapshot/event with its source. Samsung Tizen signage UAs contain
// "Tizen"/"SMART-TV"; LG webOS / other smart-TV UAs are matched too. Anything else is treated as a
// laptop/desktop. Computed once per session (the UA never changes mid-session).
const CLIENT_KIND = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Tizen|SMART-TV|SmartHub|Web0S|webOS|NetCast|HbbTV|SmartTV/i.test(ua) ? 'TV' : 'laptop';
})();
const CLIENT_UA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

export function AmbientViewerPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const previewPlaylist = searchParams.get('playlist') || 'A';
  const debugMode = searchParams.get('debug');
  const isDebug = debugMode === 'true' || debugMode === 'verbose';
  const isVerbose = debugMode === 'verbose';

  const [display, setDisplay] = useState(null);
  const [media, setMedia] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [, setDebugTick] = useState(0);

  // Seamless-loop mode: the backend pre-built ONE continuous file for the live playlist (or pointed
  // at a single clip). The viewer plays it on a single <video> and loops via pre-end seek-to-0 — no
  // src swaps, so no Tizen black gap mid-playlist OR at the loop restart. Live viewing only (preview/
  // admin keeps the per-item engine for draft content). Falls back to the engine when absent.
  const playlistVideoUrl = (!isPreview && display && display.playlist_video) ? display.playlist_video : null;
  const singleVideoMode = !!playlistVideoUrl;

  // MSE gapless-loop mode: an ALL-VIDEO live playlist (no image to absorb the loop restart). The backend
  // built ONE fragmented, video-only clip; the viewer loops it via Media Source Extensions on a single
  // <video> — segments appended on a ring so it NEVER ends/reloads/seeks (the only black-free way to
  // loop pure video in the Tizen 7.0 / Chromium browser). Live viewing only; falls back to native loop
  // if MSE is unavailable, and the per-item engine handles every playlist that contains an image.
  const mseMode = !!(!isPreview && display && display.playback_mode === 'mse-loop' && display.loop_video);
  const mseLoopUrl = mseMode ? display.loop_video : null;
  const mseCodec = mseMode ? (display.loop_codec || '') : '';

  // KEEP refs (from previous implementation, semantics unchanged)
  const mediaRef = useRef([]);
  const currentIdxRef = useRef(0);
  const pendingDataRef = useRef(null);
  const initializedRef = useRef(false);
  const imageTimerRef = useRef(null);

  // DOM refs
  const videoRef = useRef(null);
  const imageARef = useRef(null);
  const imageBRef = useRef(null);
  const posterRef = useRef(null);        // server-generated last-frame cover for video->video swaps
  const bridgeCanvasRef = useRef(null);
  const bridgeCtxRef = useRef(null);
  const lastBridgeLumaRef = useRef(-1);  // mean luma of the last canvas capture; <=2 means drawImage is black on this panel
  const singleVideoRef = useRef(null);   // seamless-loop mode: the single <video> playing the concatenated playlist
  const mseVideoRef = useRef(null);      // mse-loop mode: the single <video> fed by Media Source Extensions
  const lastSingleCtRef = useRef(0);     // tracks currentTime to detect/log the loop wrap
  const singleTickRef = useRef(null);    // setInterval handle for the seamless-loop restart watchdog
  const wrappingRef = useRef(false);     // true from the pre-end seek until the wrap is confirmed (ct dropped)
  const wrapStartedAtRef = useRef(0);    // performance.now() when the current wrap attempt began (load()-breaker timer)
  const lastHeartbeatAtRef = useRef(0);  // performance.now() of the last watchdog heartbeat log
  const endRecoverRef = useRef(null);    // timer handle for the load()+play() last-resort freeze breaker

  // Engine state
  const stateRef = useRef(STATE_IDLE);
  const currentItemTypeRef = useRef(null);
  const activeImageRef = useRef('A');
  const imageZRef = useRef(2); // monotonic top z for the incoming image layer (see image→image flash fix)
  const swapTokenRef = useRef(0);
  const prefetchRef = useRef(new Map());
  const swapDeadlineRef = useRef(null);
  const rafRef = useRef(null);
  const earlyBridgeArmedRef = useRef(false);

  // Watchdog / timing
  const lastCtRef = useRef(0);
  const lastCtAtRef = useRef(0);
  const swapStartAtRef = useRef(0);
  const lastSwapMsRef = useRef(0);
  const playStartAtRef = useRef(0);
  const mountStartRef = useRef(performance.now());

  // Diagnostics
  const eventLogRef = useRef([]);
  const logSeqRef = useRef(0);           // monotonic id per event (ordering/de-dup when streamed)
  const pendingLogRef = useRef([]);      // every not-yet-confirmed-sent event (debug capture only)
  const debugSendingRef = useRef(false); // guards overlapping POSTs
  const fpsFramesRef = useRef([]);
  const fpsRateRef = useRef(0);
  const prevRsRef = useRef(-1);
  const prevNsRef = useRef(-1);
  const errorCountRef = useRef(0);
  const prefetchNameRef = useRef('—');
  const prefetchStatusRef = useRef('idle');

  /* ----------------------- LOGGING & TIMESTAMP HELPERS ---------------------- */

  const fmtTimestamp = useCallback((now) => {
    const elapsed = Math.max(0, now - mountStartRef.current);
    const total = Math.floor(elapsed);
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const ms = total % 1000;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }, []);

  const logEvent = useCallback((klass, msg) => {
    const seq = (logSeqRef.current += 1);
    const entry = { seq, ts: fmtTimestamp(performance.now()), at: new Date().toISOString(), klass, msg };
    eventLogRef.current = [entry, ...eventLogRef.current].slice(0, LOG_RING_SIZE);  // newest-first, for the HUD
    if (isDebug) {
      // Buffer EVERY event (chronological) for the backend; capped so a long outage can't grow it forever.
      const pend = pendingLogRef.current;
      pend.push(entry);
      if (pend.length > DEBUG_PENDING_CAP) pend.splice(0, pend.length - DEBUG_PENDING_CAP);
    }
  }, [fmtTimestamp, isDebug]);

  const goState = useCallback((next) => {
    const prev = stateRef.current;
    if (prev === next) return;
    stateRef.current = next;
    logEvent('state', `state: ${prev} → ${next}`);
  }, [logEvent]);

  const bumpToken = useCallback(() => {
    swapTokenRef.current += 1;
    return swapTokenRef.current;
  }, []);

  const tokenValid = useCallback((t) => swapTokenRef.current === t, []);

  const checkRsNsDelta = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.readyState !== prevRsRef.current) {
      if (prevRsRef.current >= 0) logEvent('verbose', `rs: ${prevRsRef.current}→${v.readyState}`);
      prevRsRef.current = v.readyState;
    }
    if (v.networkState !== prevNsRef.current) {
      if (prevNsRef.current >= 0) logEvent('verbose', `ns: ${prevNsRef.current}→${v.networkState}`);
      prevNsRef.current = v.networkState;
    }
  }, [logEvent]);

  /* ----------------------------- BRIDGE HELPERS ----------------------------- */

  const captureBridge = useCallback(() => {
    const canvas = bridgeCanvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v) {
      logEvent('warn', 'bridge-capture-failed: missing refs');
      return false;
    }
    if (!bridgeCtxRef.current) bridgeCtxRef.current = canvas.getContext('2d');
    const ctx = bridgeCtxRef.current;
    if (!ctx) {
      logEvent('warn', 'bridge-capture-failed: no 2d context');
      return false;
    }
    const w = v.videoWidth || v.clientWidth || 0;
    const h = v.videoHeight || v.clientHeight || 0;
    if (w <= 0 || h <= 0) {
      logEvent('warn', 'bridge-capture-failed: zero dims');
      return false;
    }
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    try {
      ctx.drawImage(v, 0, 0, w, h);
      // ALWAYS probe mean luma (3 single-pixel reads — negligible). It tells us, on-panel, whether
      // drawImage of a hardware-decoded video actually returns pixels (luma > 2) or black (luma ~0) on
      // this firmware. The result drives the cover decision in runVideoToVideo: a black bridge is not a
      // real cover, so we must not raise it. Video is same-origin (/uploads/...), so getImageData does
      // not taint/throw; guarded regardless.
      let luma = -1;
      try {
        const samples = [[w >> 1, h >> 1], [w >> 2, h >> 2], [(w * 3) >> 2, (h * 3) >> 2]];
        let lumaSum = 0, alphaSum = 0;
        for (const [sx, sy] of samples) {
          const d = ctx.getImageData(sx, sy, 1, 1).data;
          lumaSum += 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
          alphaSum += d[3];
        }
        luma = Math.round(lumaSum / samples.length);
        const alpha = Math.round(alphaSum / samples.length);
        logEvent(luma <= 2 ? 'warn' : 'success', `bridge px luma=${luma} a=${alpha}`);
      } catch (probeErr) {
        logEvent('warn', `bridge px probe-failed: ${probeErr?.name ?? 'Error'}`);
      }
      lastBridgeLumaRef.current = luma;
      logEvent('state', `bridge on (${w}x${h})`);
      return true;
    } catch (err) {
      lastBridgeLumaRef.current = -1;
      logEvent('warn', `bridge-capture-failed: ${err?.name ?? 'Error'}`);
      return false;
    }
  }, [logEvent]);

  const setBridgeOpacity = useCallback((value, transitionMs) => {
    const el = bridgeCanvasRef.current;
    if (!el) return;
    if (transitionMs > 0) {
      el.style.transition = `opacity ${transitionMs}ms linear`;
    } else {
      el.style.transition = 'none';
    }
    el.style.opacity = String(value);
  }, []);

  /* -------------------------------- PREFETCH -------------------------------- */

  const startPrefetch = useCallback((item) => {
    if (!item) return;
    const url = item.file_path;
    if (prefetchRef.current.has(url)) return;
    prefetchNameRef.current = basename(url);
    prefetchStatusRef.current = 'loading';
    logEvent('lifecycle', `prefetch start ${basename(url)}`);
    const t0 = performance.now();
    const promise = fetch(url, { cache: 'force-cache' })
      .then((r) => r.blob())
      .then((blob) => {
        const elapsed = Math.round(performance.now() - t0);
        const kb = Math.round(blob.size / 1024);
        prefetchStatusRef.current = 'cached';
        logEvent('success', `prefetch ok (${elapsed}ms, ${kb}kB)`);
        return blob;
      })
      .catch((err) => {
        prefetchStatusRef.current = 'fail';
        logEvent('warn', `prefetch fail ${err?.message ?? err}`);
      });
    prefetchRef.current.set(url, promise);
  }, [logEvent]);

  /* ----------------------------- POSTER PRELOAD ----------------------------- */

  // Decode the *currently playing* video's last-frame poster into the hidden poster <img> well
  // before it ends, so a video->video swap can raise it as an instant, real-pixel cover. No-op for
  // images or videos without a server-generated poster (those fall back to the canvas bridge).
  const preloadPoster = useCallback((item) => {
    const img = posterRef.current;
    if (!img) return;
    const url = (item && item.media_type === 'video' && item.poster_path) ? item.poster_path : null;
    if (!url) { img.dataset.url = ''; return; }
    if (img.dataset.url === url) return; // already (pre)loaded this poster
    img.style.transition = 'none';
    img.style.opacity = '0';
    img.dataset.url = url;
    img.src = url;
    if (isDebug) logEvent('lifecycle', `poster preload ${basename(url)}`);
  }, [logEvent, isDebug]);

  /* ----------------------------- FETCH (POLLING) ---------------------------- */

  const fetchData = useCallback(async () => {
    try {
      const data = await api.getAmbientDisplay(Number(id), null, isPreview);
      const playlistToUse = isPreview ? previewPlaylist : (data.active_playlist || 'A');
      const filteredMedia = (data.media || []).filter((m) => m.playlist === playlistToUse);
      if (!initializedRef.current) {
        setDisplay(data);
        setMedia(filteredMedia);
        mediaRef.current = filteredMedia;
        currentIdxRef.current = 0;
        initializedRef.current = true;
        // Poster coverage: video->video swaps only show the last frame (instead of black) when the
        // outgoing clip has a server-generated poster. Surface the ratio so a missing backfill is
        // obvious on the panel: "posters: 0/6" means every swap will fall back to the canvas bridge.
        const vids = filteredMedia.filter((m) => m.media_type === 'video');
        const withPoster = vids.filter((m) => m.poster_path).length;
        logEvent(
          vids.length === 0 || withPoster === vids.length ? 'success' : 'warn',
          `posters: ${withPoster}/${vids.length} videos` +
            (withPoster < vids.length ? ' — run server.backfill_posters' : ''),
        );
      } else {
        // Keep `display` live (orientation/announcement/playlist_video) so seamless-loop mode picks
        // up a newly-built concat immediately; MEDIA changes still go through the engine's pending
        // swap path so a transition isn't interrupted by a remount.
        setDisplay(data);
        pendingDataRef.current = { display: data, media: filteredMedia };
      }
    } catch (err) {
      console.error(err);
    }
  }, [id, isPreview, previewPlaylist, logEvent]);

  useEffect(() => {
    fetchData();
    const handle = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(handle);
  }, [fetchData]);

  useEffect(() => {
    if (!isDebug) return;
    const handle = setInterval(() => setDebugTick((t) => t + 1), DEBUG_TICK_MS);
    return () => clearInterval(handle);
  }, [isDebug]);

  const applyPendingIfNeeded = useCallback(() => {
    const pending = pendingDataRef.current;
    if (!pending) return false;
    const currentPaths = mediaRef.current.map((m) => m.file_path).join(',');
    const newPaths = pending.media.map((m) => m.file_path).join(',');
    setDisplay(pending.display);
    pendingDataRef.current = null;
    if (currentPaths === newPaths) return false;
    logEvent('lifecycle', 'render: media-changed');
    const oldPath = mediaRef.current[currentIdxRef.current]?.file_path;
    setMedia(pending.media);
    mediaRef.current = pending.media;
    const stillIdx = pending.media.findIndex((m) => m.file_path === oldPath);
    currentIdxRef.current = stillIdx >= 0 ? stillIdx : 0;
    prefetchRef.current.clear();
    return true;
  }, [logEvent]);

  /* ----------------------------- FRAME-FRAME LOOP --------------------------- */

  const startFirstFrameLoop = useCallback((token, onSuccess) => {
    const v = videoRef.current;
    if (!v) return;
    lastCtRef.current = v.currentTime;
    lastCtAtRef.current = performance.now();
    let increments = 0;
    let warnedSlow = false;
    let warnedStuck = false;

    const tick = () => {
      if (!tokenValid(token)) return;
      if (stateRef.current !== STATE_SWAPPING) return;
      const vid = videoRef.current;
      if (!vid) return;
      const now = performance.now();
      const ct = vid.currentTime;

      // FPS rolling 2s window
      fpsFramesRef.current.push(now);
      fpsFramesRef.current = fpsFramesRef.current.filter((t) => now - t < 2000);
      fpsRateRef.current = Math.round(fpsFramesRef.current.length / 2);

      // Frame progression
      if (ct !== lastCtRef.current) {
        lastCtRef.current = ct;
        lastCtAtRef.current = now;
        if (isVerbose) logEvent('verbose', `verbose: ct=${ct.toFixed(3)}`);
        if (ct > 0 && !vid.paused) {
          increments += 1;
          if (increments >= 2) {
            const elapsed = Math.round(now - playStartAtRef.current);
            logEvent('success', `first-frame ct=${ct.toFixed(2)} (${elapsed}ms after play)`);
            onSuccess();
            return;
          }
        }
      }

      // Decode-slow advisory
      if (!warnedSlow && now - playStartAtRef.current > DECODE_SLOW_THRESHOLD_MS) {
        logEvent('warn', `decode slow (${Math.round(now - playStartAtRef.current)}ms)`);
        warnedSlow = true;
      }

      // Stuck-frame watchdog — DIAGNOSTIC ONLY. We never reload mid-swap: calling load() here would
      // reset readyState to HAVE_NOTHING and abort the in-flight play() (HTML spec / MDN), throwing
      // away decode progress and guaranteeing a black reveal when the swap-timeout then fires. The
      // bridge (or held outgoing image) keeps real pixels on screen while a slow Tizen decode
      // finishes; the swap-timeout is the only backstop, and genuine media faults are handled by
      // onError (handleVideoError).
      if (!vid.paused && now - lastCtAtRef.current > FRAME_STUCK_WARN_MS) {
        if (!warnedStuck) {
          logEvent('warn', `frame-stuck rs=${vid.readyState} ns=${vid.networkState} ct=${ct.toFixed(2)}`);
          warnedStuck = true;
        }
      }

      checkRsNsDelta();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [tokenValid, logEvent, checkRsNsDelta, isVerbose]);

  /* --------------------------- SWAP COMPLETE / FAIL ------------------------- */

  const finalizeSwap = useCallback((token, nextItem, nextIdx) => {
    if (!tokenValid(token)) return;
    currentIdxRef.current = nextIdx;
    currentItemTypeRef.current = nextItem.media_type;
    if (swapDeadlineRef.current) { clearTimeout(swapDeadlineRef.current); swapDeadlineRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    lastSwapMsRef.current = Math.round(performance.now() - swapStartAtRef.current);
    earlyBridgeArmedRef.current = false;
    goState(STATE_PLAYING);

    if (applyPendingIfNeeded()) {
      // Playlist changed under us — re-derive next behavior.
    }

    if (currentItemTypeRef.current === 'image' && mediaRef.current.length > 1) {
      armImageTimer();
    }

    const nextNextIdx = mediaRef.current.length > 0
      ? (currentIdxRef.current + 1) % mediaRef.current.length
      : 0;
    if (mediaRef.current.length > 1) {
      startPrefetch(mediaRef.current[nextNextIdx]);
    }

    // Decode the now-current video's last-frame poster so the next video->video swap can use it.
    preloadPoster(mediaRef.current[currentIdxRef.current]);
  }, [tokenValid, goState, applyPendingIfNeeded, startPrefetch, preloadPoster]);

  /* ---------------------------- TRANSITION CASES ---------------------------- */

  const runVideoToVideo = useCallback((nextItem, nextIdx) => {
    const v = videoRef.current;
    if (!v) return;
    const token = bumpToken();
    swapStartAtRef.current = performance.now();
    goState(STATE_SWAPPING);

    // ---- Choose the cover that holds the outgoing last frame during the incoming clip's decode ----
    //   poster <img>   : server-generated last frame. A real <img> always paints on Tizen and is
    //                    immune to both the hardware-overlay z-index issue and drawImage-black.
    //   canvas bridge  : runtime drawImage capture (fallback for media without a poster). May be
    //                    black on some Tizen firmware — that's exactly what the luma probe detects.
    //   cut            : no cover available — one black gap, no worse than a raw swap.
    const outgoingItem = mediaRef.current[currentIdxRef.current];
    const posterUrl = outgoingItem?.poster_path || null;
    const posterImg = posterRef.current;
    const posterReady = !!posterImg && posterImg.dataset.url === posterUrl
      && posterImg.complete && posterImg.naturalWidth > 0;

    let coverMode;
    if (posterReady) {
      posterImg.style.transition = 'none';
      posterImg.style.opacity = '1';
      coverMode = 'poster';
      logEvent('state', 'cover: poster (last frame)');
    } else {
      const captured = captureBridge();
      // On this Tizen hardware drawImage of the video plane returns black (luma~0). A black bridge is
      // NOT a real cover — raising it just shows black during decode, no better than a cut — so only
      // use the bridge when it actually captured pixels. This keeps the poster as the sole true cover
      // and makes a missing poster LOUD instead of silently black.
      if (captured && lastBridgeLumaRef.current > 2) {
        setBridgeOpacity(1, 0);
        coverMode = 'bridge';
        logEvent('state', posterUrl ? 'cover: bridge (poster not ready)' : 'cover: bridge');
      } else if (captured) {
        coverMode = 'cut';
        logEvent('warn', `cover: bridge BLACK (luma=${lastBridgeLumaRef.current}) — poster missing!`);
      } else {
        coverMode = 'cut';
        logEvent('warn', 'cover: none — cut');
      }
    }

    // Hide the about-to-blank <video> plane behind the cover. On Tizen the hardware video plane can
    // composite above HTML layers (ignoring z-index), so a blanked-but-visible <video> shows black
    // over the cover; opacity:0 reliably hides it (proven by the image->video path). Only hide when
    // we actually have a cover — a cut leaves the video visible (no worse than today).
    if (coverMode !== 'cut') {
      v.style.transition = 'none';
      v.style.opacity = '0';
      logEvent('lifecycle', 'video hidden (cover up)');
    }

    const revealVideo = (label) => {
      v.style.transition = 'none';
      v.style.opacity = '1';
      logEvent('lifecycle', label);
    };

    // Drop the cover as a HARD CUT — never a fade. The only black-flash risk during a swap is the
    // window where the poster is semi-transparent over the glitch-prone Tizen video plane; a fade
    // reopens exactly that risk. So the incoming video is revealed only once it is paintable, then the
    // cover (poster or bridge) is removed instantly over the now-live video.
    const dropCover = () => {
      const elapsed = Math.round(performance.now() - swapStartAtRef.current);
      if (coverMode === 'poster' && posterImg) {
        posterImg.style.transition = 'none';
        posterImg.style.opacity = '0';
      } else if (coverMode === 'bridge') {
        setBridgeOpacity(0, 0);
      }
      logEvent('state', `cover off (hard cut, ${elapsed}ms after swap)`);
    };

    const url = nextItem.file_path;
    logEvent('lifecycle', `src-set ${basename(url)}`);
    v.src = url;
    v.load();
    logEvent('lifecycle', 'load() called');

    swapDeadlineRef.current = setTimeout(() => {
      if (!tokenValid(token)) return;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      // Tizen-trusted paintability gate (consistent with the D1 first-frame signal): readyState>=2
      // says a current-position frame exists per spec; currentTime>0 proves the decoder actually
      // presented a real frame. `paintable` is logged for diagnostics; either way we reveal + hard-cut
      // the cover so the engine never hangs (a black reveal is possible only if the decoder genuinely
      // never produced a frame within SWAP_TIMEOUT_MS — far longer than the ~1.3-1.6s normal decode).
      const paintable = v.readyState >= 2 && v.currentTime > 0;
      logEvent('error', `swap-timeout (${SWAP_TIMEOUT_MS}ms) — forcing reveal (rs=${v.readyState} ct=${v.currentTime.toFixed(2)})`);
      revealVideo(paintable ? 'video shown' : 'video shown (forced)');
      dropCover();
      finalizeSwap(token, nextItem, nextIdx);
    }, SWAP_TIMEOUT_MS);

    logEvent('lifecycle', 'play() requested');
    playStartAtRef.current = performance.now();
    const p = v.play();
    if (p && typeof p.then === 'function') {
      p.then(() => logEvent('success', 'play() resolved'))
       .catch((e) => { errorCountRef.current += 1; logEvent('error', `play() rejected: ${e?.name ?? 'Error'}`); });
    }

    startFirstFrameLoop(token, () => {
      if (swapDeadlineRef.current) { clearTimeout(swapDeadlineRef.current); swapDeadlineRef.current = null; }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      // Reveal the now-paintable live video underneath, then hard-cut the cover off over it. No fade:
      // a hard cut from the frozen last frame straight to the next clip's first frame, with zero
      // semi-transparent window over the video plane (the only place a black flash could leak).
      revealVideo('video shown');
      dropCover();
      finalizeSwap(token, nextItem, nextIdx);
    });
  }, [bumpToken, goState, captureBridge, setBridgeOpacity, logEvent, tokenValid, finalizeSwap, startFirstFrameLoop]);

  const runImageToImage = useCallback((nextItem, nextIdx) => {
    const fromKey = activeImageRef.current;
    const toKey = fromKey === 'A' ? 'B' : 'A';
    const prevImg = fromKey === 'A' ? imageARef.current : imageBRef.current;
    const nextImg = toKey === 'A' ? imageARef.current : imageBRef.current;
    if (!prevImg || !nextImg) return;

    const token = bumpToken();
    swapStartAtRef.current = performance.now();
    goState(STATE_SWAPPING);

    logEvent('lifecycle', `image src-set ${basename(nextItem.file_path)} [next=${toKey}]`);
    nextImg.style.transition = 'none';
    nextImg.style.opacity = '0';
    nextImg.src = nextItem.file_path;

    const decodeStart = performance.now();
    let armedSwap = false;

    const beginCrossfade = () => {
      if (!tokenValid(token)) return;
      if (armedSwap) return;
      armedSwap = true;
      const elapsed = Math.round(performance.now() - decodeStart);
      logEvent('success', `image decoded (${elapsed}ms)`);
      requestAnimationFrame(() => {
        if (!tokenValid(token)) return;
        logEvent('state', `image fade start [${fromKey}→${toKey}]`);
        // nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-out`;
        // // nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        // nextImg.style.opacity = '1';
        // // prevImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        // prevImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in`;
        // prevImg.style.opacity = '0';
        // setTimeout(() => {
        //   if (!tokenValid(token)) return;
        //   logEvent('state', `image fade end [${fromKey}→${toKey}]`);
        //   activeImageRef.current = toKey;
        //   finalizeSwap(token, nextItem, nextIdx);
        // }, CROSSFADE_DURATION);
        // Lift ONLY the incoming image (still opacity:0 → invisible → restacking it is flash-free) to an
        // ever-increasing z so it's always above the outgoing. Equal-z ties break by DOM order (B over A),
        // which is why alternate swaps cut instantly without this. We must NEVER change z on a VISIBLE
        // layer: on Tizen that rebuilds the composited layer (willChange:opacity) and flashes black for
        // ~1 frame — exactly the regression a fixed start-3/end-2 reset introduced.
        imageZRef.current += 1;
        nextImg.style.zIndex = String(imageZRef.current);
        nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        nextImg.style.opacity = '1';
        // old image stays solid underneath while the new one fades in on top
        setTimeout(() => {
          if (!tokenValid(token)) return;
          // Hide the outgoing via a TRANSITION (compositor path) — NOT an instant `transition:'none'`
          // write. The instant write is what flashed black on Tizen (main-thread layer rebuild); the
          // animated opacity change rides the compositor exactly like the smooth incoming fade, so it
          // doesn't flash. It fades 1→0 invisibly behind the now-opaque incoming, and crucially still
          // ENDS at opacity 0 — so only the active image stays opaque, which runImageToVideo relies on
          // (it only fades the active image out to reveal the video; a second opaque image would occlude it).
          prevImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease`;
          prevImg.style.opacity = '0';
          logEvent('state', `image fade end [${fromKey}→${toKey}]`);
          activeImageRef.current = toKey;
          finalizeSwap(token, nextItem, nextIdx);
        }, CROSSFADE_DURATION);
      });
    };

    const forceFinal = (reason) => {
      if (!tokenValid(token)) return;
      logEvent('error', reason);
      errorCountRef.current += 1;
      if (armedSwap) return;
      armedSwap = true;
      nextImg.style.transition = 'none';
      nextImg.style.opacity = '1';
      prevImg.style.transition = 'none';
      prevImg.style.opacity = '0';
      activeImageRef.current = toKey;
      finalizeSwap(token, nextItem, nextIdx);
    };

    swapDeadlineRef.current = setTimeout(() => forceFinal('image-decode-timeout'), SWAP_TIMEOUT_MS);

    const onErr = () => forceFinal(`image-onerror ${basename(nextItem.file_path)}`);

    if (typeof nextImg.decode === 'function') {
      nextImg.decode().then(beginCrossfade).catch(onErr);
    } else if (nextImg.complete && nextImg.naturalWidth > 0) {
      beginCrossfade();
    } else {
      const handleLoad = () => { nextImg.removeEventListener('load', handleLoad); beginCrossfade(); };
      const handleErr = () => { nextImg.removeEventListener('error', handleErr); onErr(); };
      nextImg.addEventListener('load', handleLoad, { once: true });
      nextImg.addEventListener('error', handleErr, { once: true });
    }
  }, [bumpToken, goState, logEvent, tokenValid, finalizeSwap]);

  const runVideoToImage = useCallback((nextItem, nextIdx) => {
    const v = videoRef.current;
    if (!v) return;
    const fromKey = activeImageRef.current; // last visible image layer (likely hidden)
    const toKey = fromKey === 'A' ? 'B' : 'A';
    const nextImg = toKey === 'A' ? imageARef.current : imageBRef.current;
    if (!nextImg) return;

    const token = bumpToken();
    swapStartAtRef.current = performance.now();
    goState(STATE_SWAPPING);

    // Freeze to the OUTGOING video's last-frame poster the instant it ends — same model as
    // video->video — so nothing depends on the Tizen video plane holding its frame while the next
    // image decodes (vendor docs: the video box can blank while content is cued up). The poster is a
    // real <img>, immune to the plane. When it isn't available, fall back to the legacy direct
    // video->image crossfade (which relies on the plane holding its frame).
    const outgoingItem = mediaRef.current[currentIdxRef.current];
    const posterUrl = outgoingItem?.poster_path || null;
    const posterImg = posterRef.current;
    const posterFreeze = !!posterImg && posterImg.dataset.url === posterUrl
      && posterImg.complete && posterImg.naturalWidth > 0;

    if (posterFreeze) {
      posterImg.style.transition = 'none';   // hard cut UP to the frozen last frame
      posterImg.style.opacity = '1';
      logEvent('state', 'cover: poster (last frame) [video→image]');
      v.style.transition = 'none';
      v.style.opacity = '0';
      try { v.pause(); logEvent('lifecycle', 'video frozen to poster + paused'); } catch (_) {}
    }

    logEvent('lifecycle', `image src-set ${basename(nextItem.file_path)} [next=${toKey}]`);
    nextImg.style.transition = 'none';
    nextImg.style.opacity = '0';
    nextImg.src = nextItem.file_path;

    const decodeStart = performance.now();
    let armedSwap = false;

    const settle = () => {
      activeImageRef.current = toKey;
      try { v.pause(); } catch (_) {}
      finalizeSwap(token, nextItem, nextIdx);
    };

    const beginReveal = () => {
      if (!tokenValid(token)) return;
      if (armedSwap) return;
      armedSwap = true;
      const elapsed = Math.round(performance.now() - decodeStart);
      logEvent('success', `image decoded (${elapsed}ms)`);
      requestAnimationFrame(() => {
        if (!tokenValid(token)) return;
        if (posterFreeze) {
          // Image opaque at z=2 BENEATH the poster (z=3), then HARD-CUT the poster off — flash-free:
          // no semi-transparent window and the cut never exposes the video plane.
          nextImg.style.transition = 'none';
          nextImg.style.opacity = '1';
          posterImg.style.transition = 'none';
          posterImg.style.opacity = '0';
          logEvent('state', `cover off (hard cut) → image [${toKey}]`);
          settle();
        } else {
          // Legacy fallback (no poster): crossfade the next image in over the still-displayed video.
          logEvent('state', `image fade start [video→${toKey}]`);
          nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-out`;
          // nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
          nextImg.style.opacity = '1';
          // v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
          v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in`;
          v.style.opacity = '0';
          logEvent('lifecycle', 'video opacity 1→0');
          setTimeout(() => {
            if (!tokenValid(token)) return;
            logEvent('state', `image fade end [video→${toKey}]`);
            settle();
          }, CROSSFADE_DURATION);
        }
      });
    };

    const forceFinal = (reason) => {
      if (!tokenValid(token)) return;
      logEvent('error', reason);
      errorCountRef.current += 1;
      if (armedSwap) return;
      armedSwap = true;
      nextImg.style.transition = 'none';
      nextImg.style.opacity = '1';
      if (posterImg) { posterImg.style.transition = 'none'; posterImg.style.opacity = '0'; }
      v.style.transition = 'none';
      v.style.opacity = '0';
      settle();
    };

    swapDeadlineRef.current = setTimeout(() => forceFinal('image-decode-timeout'), SWAP_TIMEOUT_MS);

    const onErr = () => forceFinal(`image-onerror ${basename(nextItem.file_path)}`);

    if (typeof nextImg.decode === 'function') {
      nextImg.decode().then(beginReveal).catch(onErr);
    } else if (nextImg.complete && nextImg.naturalWidth > 0) {
      beginReveal();
    } else {
      const handleLoad = () => { nextImg.removeEventListener('load', handleLoad); beginReveal(); };
      const handleErr = () => { nextImg.removeEventListener('error', handleErr); onErr(); };
      nextImg.addEventListener('load', handleLoad, { once: true });
      nextImg.addEventListener('error', handleErr, { once: true });
    }
  }, [bumpToken, goState, logEvent, tokenValid, finalizeSwap]);

  const runImageToVideo = useCallback((nextItem, nextIdx) => {
    const v = videoRef.current;
    if (!v) return;
    const activeKey = activeImageRef.current;
    const activeImg = activeKey === 'A' ? imageARef.current : imageBRef.current;
    if (!activeImg) return;

    const token = bumpToken();
    swapStartAtRef.current = performance.now();
    goState(STATE_SWAPPING);

    const url = nextItem.file_path;
    logEvent('lifecycle', `src-set ${basename(url)}`);
    v.style.transition = 'none';
    v.style.opacity = '0';
    v.src = url;
    v.load();
    logEvent('lifecycle', 'load() called');

    swapDeadlineRef.current = setTimeout(() => {
      if (!tokenValid(token)) return;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      // Same Tizen-trusted paintability gate as runVideoToVideo. The outgoing image is still on
      // screen as the cover, so we only crossfade to the video once it has actually presented a frame.
      const paintable = v.readyState >= 2 && v.currentTime > 0;
      logEvent('error', `swap-timeout (${SWAP_TIMEOUT_MS}ms) — forcing fade (rs=${v.readyState} ct=${v.currentTime.toFixed(2)})`);
      if (paintable) {
        logEvent('state', `image fade out [${activeKey}]`);
        logEvent('state', 'video fade in');
        v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-out`;
        v.style.opacity = '1';
        activeImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in`;
        activeImg.style.opacity = '0';
        setTimeout(() => {
          if (!tokenValid(token)) return;
          finalizeSwap(token, nextItem, nextIdx);
        }, CROSSFADE_DURATION);
      } else {
        // Decoder never produced a frame — instant reveal + advance so the engine never hangs.
        v.style.transition = 'none';
        v.style.opacity = '1';
        activeImg.style.transition = 'none';
        activeImg.style.opacity = '0';
        finalizeSwap(token, nextItem, nextIdx);
      }
    }, SWAP_TIMEOUT_MS);

    logEvent('lifecycle', 'play() requested');
    playStartAtRef.current = performance.now();
    const p = v.play();
    if (p && typeof p.then === 'function') {
      p.then(() => logEvent('success', 'play() resolved'))
       .catch((e) => { errorCountRef.current += 1; logEvent('error', `play() rejected: ${e?.name ?? 'Error'}`); });
    }

    startFirstFrameLoop(token, () => {
      if (swapDeadlineRef.current) { clearTimeout(swapDeadlineRef.current); swapDeadlineRef.current = null; }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      requestAnimationFrame(() => {
        if (!tokenValid(token)) return;
        logEvent('state', `image fade out [${activeKey}]`);
        logEvent('state', 'video fade in');
        v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-out`;
        v.style.opacity = '1';
        activeImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in`;
        activeImg.style.opacity = '0';
        setTimeout(() => {
          if (!tokenValid(token)) return;
          finalizeSwap(token, nextItem, nextIdx);
        }, CROSSFADE_DURATION);
      });
    });
  }, [bumpToken, goState, logEvent, tokenValid, finalizeSwap, startFirstFrameLoop]);

  /* --------------------------------- ADVANCE -------------------------------- */

  const advance = useCallback(() => {
    if (stateRef.current !== STATE_PLAYING) return;
    if (mediaRef.current.length === 0) return;
    const currentIdx = currentIdxRef.current;
    const nextIdx = (currentIdx + 1) % mediaRef.current.length;
    const currentItem = mediaRef.current[currentIdx];
    const nextItem = mediaRef.current[nextIdx];
    if (!nextItem) return;

    if (nextIdx === 0 && currentIdx !== 0) {
      logEvent('lifecycle', `=== LOOP RESTART (item ${currentIdx} → item 0) ===`);
    }

    // Single-item playlist
    if (mediaRef.current.length === 1) {
      if (currentItem?.media_type === 'image') {
        armImageTimer();
        return;
      }
      // Single video — replay via video→video swap so the loop frame is bridged
    }

    const fromType = currentItemTypeRef.current;
    const toType = nextItem.media_type;
    if (fromType === 'video' && toType === 'video') runVideoToVideo(nextItem, nextIdx);
    else if (fromType === 'video' && toType === 'image') runVideoToImage(nextItem, nextIdx);
    else if (fromType === 'image' && toType === 'image') runImageToImage(nextItem, nextIdx);
    else if (fromType === 'image' && toType === 'video') runImageToVideo(nextItem, nextIdx);
    else logEvent('error', `unknown transition kind: ${fromType}→${toType}`);
  }, [logEvent, runVideoToVideo, runVideoToImage, runImageToImage, runImageToVideo]);

  function armImageTimer(durationMs = IMAGE_DURATION) {
    if (imageTimerRef.current) clearTimeout(imageTimerRef.current);
    imageTimerRef.current = setTimeout(() => { advanceRef.current?.(); }, durationMs);
  }

  // advanceRef indirection so armImageTimer (declared outside useCallback) sees latest advance
  const advanceRef = useRef(null);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  /* ----------------------------------- START -------------------------------- */

  const start = useCallback((item) => {
    if (!item) return;
    if (!bridgeCtxRef.current && bridgeCanvasRef.current) {
      bridgeCtxRef.current = bridgeCanvasRef.current.getContext('2d');
    }
    bumpToken();
    currentIdxRef.current = 0;
    currentItemTypeRef.current = item.media_type;
    goState(STATE_PLAYING);
    logEvent('lifecycle', `render: init (${basename(item.file_path)})`);

    if (item.media_type === 'image') {
      const img = activeImageRef.current === 'A' ? imageARef.current : imageBRef.current;
      if (img) {
        img.style.transition = 'none';
        img.style.opacity = '1';
        img.src = item.file_path;
      }
      if (mediaRef.current.length > 1) armImageTimer();
    } else {
      const v = videoRef.current;
      if (v) {
        v.style.transition = 'none';
        v.style.opacity = '1';
        v.src = item.file_path;
        logEvent('lifecycle', `src-set ${basename(item.file_path)}`);
        v.load();
        logEvent('lifecycle', 'load() called');
        logEvent('lifecycle', 'play() requested');
        const p = v.play();
        if (p && typeof p.then === 'function') {
          p.then(() => logEvent('success', 'play() resolved'))
           .catch((e) => { errorCountRef.current += 1; logEvent('error', `play() rejected: ${e?.name ?? 'Error'}`); });
        }
      }
    }

    if (mediaRef.current.length > 1) {
      const nextIdx = (currentIdxRef.current + 1) % mediaRef.current.length;
      startPrefetch(mediaRef.current[nextIdx]);
    }

    // Decode this item's last-frame poster (if a video) so its first swap can use it as a cover.
    preloadPoster(item);
  }, [bumpToken, goState, logEvent, startPrefetch, preloadPoster]);

  /* ----------------------------- AUTOSTART EFFECT --------------------------- */

  useEffect(() => {
    if (singleVideoMode || mseMode) return;  // a single-<video> engine handles playback; per-item stays idle
    if (stateRef.current !== STATE_IDLE) return;
    if (!display || media.length === 0) return;
    if (!videoRef.current || !imageARef.current || !imageBRef.current || !bridgeCanvasRef.current) return;
    logEvent('state', `engine ${ENGINE_VERSION} · build ${BUILD_STAMP}`);
    logEvent('lifecycle', 'mount [video]');
    logEvent('lifecycle', 'mount [img-A]');
    logEvent('lifecycle', 'mount [img-B]');
    logEvent('lifecycle', 'mount [bridge]');
    start(media[0]);
  }, [display, media, start, logEvent, singleVideoMode, mseMode]);

  /* --------------------- SEAMLESS-LOOP MODE (single file) ------------------- */

  // Black-free endless loop, hardened for Tizen. The whole live playlist plays as ONE concatenated file
  // on a single <video>; we loop by seeking back to 0 on the STILL-PLAYING element ~1.5s before EOF.
  // A backward seek before end-of-stream never tears down the HW decoder (it jumps to the IDR at frame
  // 0 and keeps presenting), so the seam stays black-free. The ONLY requirement is to land that seek
  // before the stream can end — so a ~100ms setInterval watchdog (NOT rAF, which Tizen throttles while
  // the HW video plane is composited) retries the seek every tick until the wrap is confirmed.

  // ABSOLUTE last resort: only reached when the video has ALREADY frozen at EOF and every in-stream
  // seek retry failed. load()+play() forces a fresh decode — this is the ONLY path that can briefly
  // flash black, and it exists purely to break a permanent freeze (strictly better than a dead screen).
  // Once the pre-end seek retry loop works this never runs (no `loop: seek FAILED → load()` in the log).
  const singleLoadBreaker = useCallback(() => {
    const v = singleVideoRef.current;
    if (!v) return;
    if (endRecoverRef.current) return; // a load() is already re-initializing the decoder
    if (isDebug) logEvent('error', `loop: seek FAILED → load() (ct=${(v.currentTime || 0).toFixed(2)})`);
    try { v.load(); const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
    wrappingRef.current = false;
    wrapStartedAtRef.current = 0;
    // Guard so the watchdog doesn't hammer load() every tick while the decoder re-initializes.
    endRecoverRef.current = setTimeout(() => { endRecoverRef.current = null; }, 1200);
  }, [isDebug, logEvent]);

  // The ~100ms watchdog. Drives the pre-end seek, retries it every tick until the wrap is confirmed,
  // emits a periodic heartbeat, and breaks a true freeze as a last resort.
  const singleLoopTick = useCallback(() => {
    const v = singleVideoRef.current;
    if (!v) return;
    const d = v.duration;
    const ct = v.currentTime;
    const now = performance.now();

    // Heartbeat: periodic snapshot so the approach-to-EOF and any freeze are visible in the transcript.
    if (isDebug && now - lastHeartbeatAtRef.current >= SINGLE_HEARTBEAT_MS) {
      lastHeartbeatAtRef.current = now;
      logEvent('verbose',
        `hb ct=${isFinite(ct) ? ct.toFixed(2) : '?'} dur=${isFinite(d) ? d.toFixed(2) : '?'} ` +
        `paused=${v.paused} ended=${v.ended} rs=${v.readyState} ns=${v.networkState}`);
    }

    if (isFinite(d) && d > 0) {
      if (wrappingRef.current) {
        // A wrap is in progress: confirm it (ct dropped) or keep nudging the seek until it lands.
        if (ct < 1 && !v.ended) {
          if (isDebug) logEvent('success', `loop: wrap CONFIRMED (ct=${ct.toFixed(2)})`);
          wrappingRef.current = false;
          wrapStartedAtRef.current = 0;
        } else if (now - wrapStartedAtRef.current >= SINGLE_LOAD_BREAKER_MS) {
          // Stream reached/passed EOF and never honored the seek — break the freeze (may flash once).
          singleLoadBreaker();
        } else {
          // Still before EOF but the seek hasn't taken yet — retry every tick (the no-black guarantee).
          try { v.currentTime = 0; } catch (_) { /* ignore */ }
          const p = v.play(); if (p && p.catch) p.catch(() => {});
          if (isDebug) logEvent('warn', `loop: seek retry (ct=${ct.toFixed(2)})`);
        }
      } else if (v.ended) {
        // Reached EOF without catching the pre-end window (shouldn't happen with a 1.5s lead). Recover.
        wrappingRef.current = true;
        wrapStartedAtRef.current = now;
        try { v.currentTime = 0; } catch (_) { /* ignore */ }
        const p = v.play(); if (p && p.catch) p.catch(() => {});
        if (isDebug) logEvent('warn', `loop: ended caught in tick → seek→0 (ct=${ct.toFixed(2)})`);
      } else if (ct >= d - SINGLE_SEEK_LEAD) {
        // Pre-end window: seek to 0 on the still-playing element BEFORE EOF → black-free wrap.
        wrappingRef.current = true;
        wrapStartedAtRef.current = now;
        try { v.currentTime = 0; } catch (_) { /* ignore */ }
        const p = v.play(); if (p && p.catch) p.catch(() => {});
        if (isDebug) logEvent('success', `loop: seek→0 requested (ct=${ct.toFixed(2)}/${d.toFixed(2)})`);
      }
    }
    lastSingleCtRef.current = ct;
  }, [isDebug, logEvent, singleLoadBreaker]);

  // `timeupdate` is a secondary trigger only (the setInterval watchdog is primary). Shares wrappingRef
  // so it can't double-seek; also logs a native wrap we didn't drive (shouldn't occur without `loop`).
  const handleSingleTimeUpdate = useCallback(() => {
    const v = singleVideoRef.current;
    if (!v) return;
    const d = v.duration;
    const ct = v.currentTime;
    if (!wrappingRef.current && isFinite(d) && d > 0 && ct >= d - SINGLE_SEEK_LEAD) {
      wrappingRef.current = true;
      wrapStartedAtRef.current = performance.now();
      try { v.currentTime = 0; } catch (_) { /* ignore */ }
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      if (isDebug) logEvent('success', `loop: seek→0 requested (timeupdate) (ct=${ct.toFixed(2)}/${d.toFixed(2)})`);
    } else if (!wrappingRef.current && ct + 0.5 < lastSingleCtRef.current && isDebug) {
      logEvent('lifecycle', `=== native wrap (ct ${lastSingleCtRef.current.toFixed(1)}→${ct.toFixed(2)}) ===`);
    }
    lastSingleCtRef.current = ct;
  }, [isDebug, logEvent]);

  const handleSingleEnded = useCallback(() => {
    // With `loop` removed this fires reliably at EOF. The 1.5s pre-end seek should mean we almost never
    // get here; if we do, route recovery through the watchdog (it confirms the wrap or breaks the freeze).
    const v = singleVideoRef.current;
    if (isDebug) logEvent('warn', `single ended → recover (ct=${v ? (v.currentTime || 0).toFixed(2) : '?'})`);
    if (!v) return;
    wrappingRef.current = true;
    wrapStartedAtRef.current = performance.now();
    try { v.currentTime = 0; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
  }, [isDebug, logEvent]);

  // Tizen frequently auto-pauses on a backward seek or buffer underrun — immediately resume so the loop
  // never stalls (the "didn't auto-play after the first cycle" symptom). Don't fight a genuine EOF pause
  // (the ended handler + watchdog cover that).
  const handleSinglePause = useCallback(() => {
    const v = singleVideoRef.current;
    if (!v) return;
    if (isDebug) logEvent('warn', `pause ct=${(v.currentTime || 0).toFixed(2)} → play()`);
    if (!v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  }, [isDebug, logEvent]);

  const handleSingleSeeked = useCallback(() => {
    const v = singleVideoRef.current;
    if (!v) return;
    if (isDebug) logEvent('lifecycle', `seeked ct=${(v.currentTime || 0).toFixed(2)}`);
    if (v.paused && !v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } // resume after seek
  }, [isDebug, logEvent]);

  const handleSingleSeeking = useCallback(() => {
    if (!isDebug) return;
    const v = singleVideoRef.current;
    logEvent('lifecycle', `seeking ct=${v ? (v.currentTime || 0).toFixed(2) : '?'}`);
  }, [isDebug, logEvent]);

  const handleSinglePlaying = useCallback(() => {
    if (!isDebug) return;
    const v = singleVideoRef.current;
    logEvent('success', `playing ct=${v ? (v.currentTime || 0).toFixed(2) : '?'}`);
  }, [isDebug, logEvent]);

  const handleSingleWaiting = useCallback(() => {
    if (!isDebug) return;
    const v = singleVideoRef.current;
    logEvent('warn', `waiting (buffering) ct=${v ? (v.currentTime || 0).toFixed(2) : '?'}`);
  }, [isDebug, logEvent]);

  const handleSingleStalled = useCallback(() => {
    if (!isDebug) return;
    logEvent('warn', 'stalled');
  }, [isDebug, logEvent]);

  const handleSingleLoadedMetadata = useCallback(() => {
    if (!isDebug) return;
    const v = singleVideoRef.current;
    logEvent('lifecycle', `loadedmetadata dur=${v && isFinite(v.duration) ? v.duration.toFixed(2) : '?'}`);
  }, [isDebug, logEvent]);

  const handleSingleLoadedData = useCallback(() => {
    if (!isDebug) return;
    logEvent('lifecycle', 'loadeddata (first frame ready)');
  }, [isDebug, logEvent]);

  const handleSingleError = useCallback(() => {
    const v = singleVideoRef.current;
    errorCountRef.current += 1;
    logEvent('error', `single-video error code=${v?.error?.code ?? '?'}`);
  }, [logEvent]);

  useEffect(() => {
    if (!singleVideoMode) return;
    const v = singleVideoRef.current;
    if (!v) return;
    if (v.dataset.url !== playlistVideoUrl) {
      v.dataset.url = playlistVideoUrl;
      lastSingleCtRef.current = 0;
      v.src = playlistVideoUrl;
      v.load();
      if (isDebug) logEvent('state', `MODE seamless-loop · src ${basename(playlistVideoUrl)}`);
    }
    const p = v.play();
    if (p && typeof p.then === 'function') {
      p.catch((e) => logEvent('error', `single play() rejected: ${e?.name ?? 'Error'}`));
    }
  }, [singleVideoMode, playlistVideoUrl, isDebug, logEvent]);

  // Run the loop-restart watchdog only while in seamless mode; tear it down on exit. A setInterval
  // (not rAF) is used because Tizen throttles requestAnimationFrame while the HW video plane is
  // composited, which is exactly when we need to poll.
  useEffect(() => {
    if (!singleVideoMode) return;
    lastHeartbeatAtRef.current = 0;
    wrappingRef.current = false;
    wrapStartedAtRef.current = 0;
    singleTickRef.current = setInterval(singleLoopTick, SINGLE_TICK_MS);
    return () => {
      if (singleTickRef.current) { clearInterval(singleTickRef.current); singleTickRef.current = null; }
      if (endRecoverRef.current) { clearTimeout(endRecoverRef.current); endRecoverRef.current = null; }
      wrappingRef.current = false;
      wrapStartedAtRef.current = 0;
    };
  }, [singleVideoMode, singleLoopTick]);

  /* ----------------------- MSE GAPLESS-LOOP MODE (all-video) ---------------------- */
  // Feed ONE <video> the fragmented loop clip via Media Source Extensions in `sequence` mode, appending
  // it again whenever the buffer runs low — so the element never reaches `ended`, never reloads, never
  // seeks (a backward seek/reload is the ONLY thing that blanks the Tizen plane). That makes the
  // video→video loop wrap of an all-video playlist black-free. If MSE is unavailable or errors, fall
  // back to the native `loop` attribute (best-effort) so playback never dies. Verify on-panel; if the
  // native fallback flashes, the AVPlay .wgt (Approach 2) is the guaranteed escalation.
  useEffect(() => {
    if (!mseMode) return;
    const v = mseVideoRef.current;
    if (!v) return;

    let cancelled = false;
    let mediaSource = null;
    let objectUrl = null;
    let sb = null;
    let segment = null;          // the whole fragmented clip (re-appended each loop)
    let appendedOnce = false;
    lastHeartbeatAtRef.current = 0;

    const QUEUE_AHEAD = 20;      // keep ~20s buffered ahead of playback
    const KEEP_BEHIND = 10;      // evict buffered data older than ~10s behind currentTime

    const nativeFallback = (why) => {
      if (cancelled) return;
      if (isDebug) logEvent('warn', `mse: native-loop fallback (${why})`);
      try {
        v.loop = true;
        v.src = mseLoopUrl;
        const p = v.play(); if (p && p.catch) p.catch(() => {});
      } catch (_) { /* ignore */ }
    };

    const supported = typeof window !== 'undefined' && 'MediaSource' in window
      && !!mseCodec && window.MediaSource.isTypeSupported(mseCodec);
    if (!supported) { nativeFallback(mseCodec ? `codec unsupported (${mseCodec})` : 'no MSE'); return; }

    const tryAppendMore = () => {
      if (cancelled || !sb || sb.updating || !segment) return;
      try {
        const b = sb.buffered;
        const ahead = b.length ? b.end(b.length - 1) - v.currentTime : 0;
        if (!appendedOnce || ahead < QUEUE_AHEAD) {
          appendedOnce = true;
          sb.appendBuffer(segment);  // sequence mode → continues the timeline (gapless repeat)
        }
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          try {
            const cur = v.currentTime;
            if (sb.buffered.length && sb.buffered.start(0) < cur - KEEP_BEHIND) {
              sb.remove(sb.buffered.start(0), cur - KEEP_BEHIND);
            }
          } catch (_) { /* retry next tick */ }
        } else {
          nativeFallback(`append ${e?.name ?? 'Error'}`);
        }
      }
    };

    const onSourceOpen = () => {
      if (cancelled) return;
      try {
        sb = mediaSource.addSourceBuffer(mseCodec);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', tryAppendMore);
        tryAppendMore();
      } catch (e) {
        nativeFallback(`addSourceBuffer ${e?.name ?? 'Error'}`);
      }
    };

    fetch(mseLoopUrl, { cache: 'force-cache' })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        segment = new Uint8Array(buf);
        mediaSource = new window.MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        mediaSource.addEventListener('sourceopen', onSourceOpen);
        v.src = objectUrl;
        const p = v.play(); if (p && p.catch) p.catch(() => {});
        if (isDebug) logEvent('state', `MODE mse-loop · ${basename(mseLoopUrl)} [${mseCodec}]`);
      })
      .catch((e) => nativeFallback(`fetch ${e?.message ?? e}`));

    // Top up the buffer + keep playing + heartbeat (the panel can't be watched live).
    const tick = setInterval(() => {
      if (cancelled) return;
      tryAppendMore();
      if (v.paused && !v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      const now = performance.now();
      if (isDebug && now - lastHeartbeatAtRef.current >= SINGLE_HEARTBEAT_MS) {
        lastHeartbeatAtRef.current = now;
        let ahead = 0;
        try { const b = sb && sb.buffered; if (b && b.length) ahead = b.end(b.length - 1) - v.currentTime; } catch (_) { /* ignore */ }
        logEvent('verbose',
          `hb(mse) ct=${isFinite(v.currentTime) ? v.currentTime.toFixed(2) : '?'} ahead=${ahead.toFixed(1)} ` +
          `paused=${v.paused} ended=${v.ended} rs=${v.readyState} mss=${mediaSource ? mediaSource.readyState : '?'}`);
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(tick);
      try { if (sb) sb.removeEventListener('updateend', tryAppendMore); } catch (_) { /* ignore */ }
      try { if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (_) { /* ignore */ }
      try { if (objectUrl) URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
      try { v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ }
    };
  }, [mseMode, mseLoopUrl, mseCodec, isDebug, logEvent]);

  // Stream the on-panel ?debug log to the backend (readable at /api/ambient/<id>/debug-log/latest —
  // no need to photograph the TV). Sends EVERY buffered event in chronological batches; on a confirmed
  // POST the sent events are dropped, otherwise they're kept and retried next tick (survives blips).
  // Never throws into playback.
  useEffect(() => {
    if (!isDebug) return;
    const send = async () => {
      if (debugSendingRef.current) return;
      const batch = pendingLogRef.current.slice(0, DEBUG_BATCH_MAX);  // chronological (pushed in order)
      const lastSeq = batch.length ? batch[batch.length - 1].seq : 0;
      const vv = mseMode ? mseVideoRef.current : singleVideoMode ? singleVideoRef.current : videoRef.current;
      const header = {
        mode: mseMode ? 'mse-loop' : singleVideoMode ? 'seamless-loop' : 'per-item-engine',
        state: stateRef.current,
        item: mseMode ? basename(mseLoopUrl)
          : singleVideoMode ? basename(playlistVideoUrl)
          : basename(mediaRef.current[currentIdxRef.current]?.file_path),
        rs: vv?.readyState, ns: vv?.networkState,
        ct: vv && isFinite(vv.currentTime) ? +vv.currentTime.toFixed(2) : null,
        dur: vv && isFinite(vv.duration) ? +vv.duration.toFixed(2) : null,
        paused: vv ? vv.paused : null,
        errors: errorCountRef.current,
        fps: fpsRateRef.current,
        lastSwapMs: lastSwapMsRef.current,
        pending: pendingLogRef.current.length,
      };
      debugSendingRef.current = true;
      try {
        const res = await api.postAmbientDebugLog(id, {
          engine: ENGINE_VERSION, build: BUILD_STAMP,
          // Tag the source so a TV transcript and a laptop transcript (which share the day-file) are
          // distinguishable both in the status snapshot and per-event line.
          client: CLIENT_KIND, ua: CLIENT_UA,
          // Point at the same-origin debug-log page (viewer URL + /debug-log/latest), not the raw href.
          url: `${window.location.origin}${window.location.pathname.replace(/\/+$/, '')}/debug-log/latest`,
          header, events: batch,
        });
        if (res && res.ok && lastSeq) {
          pendingLogRef.current = pendingLogRef.current.filter((e) => e.seq > lastSeq);
        }
      } catch {
        /* keep the batch buffered; retried next tick */
      } finally {
        debugSendingRef.current = false;
      }
    };
    send();
    const handle = setInterval(send, DEBUG_POST_INTERVAL_MS);
    return () => { clearInterval(handle); send(); };  // best-effort final flush
  }, [isDebug, id, singleVideoMode, playlistVideoUrl, mseMode, mseLoopUrl]);

  /* -------------------------------- CLEANUP --------------------------------- */

  useEffect(() => {
    return () => {
      if (imageTimerRef.current) clearTimeout(imageTimerRef.current);
      if (swapDeadlineRef.current) clearTimeout(swapDeadlineRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      bumpToken();
    };
  }, [bumpToken]);

  /* --------------------------- EARLY-BRIDGE WATCHER ------------------------- */

  const handleVideoTimeUpdate = useCallback(() => {
    if (!EARLY_BRIDGE_CAPTURE) return;
    if (stateRef.current !== STATE_PLAYING) return;
    if (currentItemTypeRef.current !== 'video') return;
    if (earlyBridgeArmedRef.current) return;
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    if (v.currentTime < v.duration - (EARLY_BRIDGE_LEAD_MS / 1000)) return;
    // Peek next item type
    const nextIdx = (currentIdxRef.current + 1) % mediaRef.current.length;
    if (mediaRef.current[nextIdx]?.media_type !== 'video') return;
    earlyBridgeArmedRef.current = true;
    captureBridge();
    setBridgeOpacity(1, 0);
    logEvent('state', 'early-bridge-capture armed');
  }, [captureBridge, setBridgeOpacity, logEvent]);

  /* ------------------------------ VIDEO HANDLERS ---------------------------- */

  const handleVideoEnded = useCallback(() => {
    logEvent('lifecycle', 'ended');
    if (stateRef.current !== STATE_PLAYING) return;
    advance();
  }, [logEvent, advance]);

  const handleVideoError = useCallback(() => {
    const v = videoRef.current;
    const code = v?.error?.code ?? '?';
    const msg = v?.error?.message ?? '';
    errorCountRef.current += 1;
    logEvent('error', `onError name=${code} msg=${msg}`);
    // Do NOT touch swapDeadlineRef here. The previous code cleared the real swap-timeout and replaced
    // it with an empty setTimeout(() => {}, 0) — destroying the only backstop, so a corrupt/missing
    // video mid-swap hung the engine forever. Leaving the swap-timeout armed lets it fire and advance
    // (its not-paintable branch reveals the video + finalizes), so the engine always recovers.
  }, [logEvent]);

  const handleVideoPlaying = useCallback(() => { logEvent('lifecycle', 'playing event'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoPause = useCallback(() => { logEvent('lifecycle', 'paused'); }, [logEvent]);
  const handleVideoLoadStart = useCallback(() => { logEvent('lifecycle', 'loadstart'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoLoadedData = useCallback(() => { logEvent('lifecycle', 'loadeddata'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoLoadedMetadata = useCallback(() => { logEvent('lifecycle', 'loadedmetadata'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoCanPlay = useCallback(() => { logEvent('lifecycle', 'canplay (observational)'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoCanPlayThrough = useCallback(() => { logEvent('lifecycle', 'canplaythrough (observational)'); checkRsNsDelta(); }, [logEvent, checkRsNsDelta]);
  const handleVideoSeeked = useCallback(() => { logEvent('lifecycle', 'seeked'); }, [logEvent]);

  /* --------------------------------- PUBLISH -------------------------------- */

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try {
      await api.publishPlaylist(Number(id), previewPlaylist);
      toast.success(`Playlist ${previewPlaylist} is now live!`);
      window.close();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPublishing(false);
    }
  }, [id, previewPlaylist]);

  /* ----------------------------------- UI ----------------------------------- */

  const orientation = display?.orientation || 'landscape';
  const colorBarHeight = orientation === 'portrait'
  ? 'clamp(12px, 2vh, 25px)'
  : 'clamp(16px, 2.5vh, 35px)';
  // const colorBarHeight = orientation === 'portrait'
  //   ? 'clamp(8px, 1.35vh, 15px)'
  //   : 'clamp(10px, 1.8vh, 20px)';

  const containerStyle = useMemo(() => {
    if (orientation === 'portrait') {
      return {
        position: 'relative',
        height: '100vh',
        width: 'calc(100vh * 9 / 16)',
        maxWidth: '100vw',
        margin: 'auto',
        overflow: 'hidden',
      };
    }
    return {
      position: 'relative',
      width: '100%',
      aspectRatio: '16/9',
      maxHeight: '100vh',
      margin: 'auto',
      overflow: 'hidden',
    };
  }, [orientation]);

  if (!display || !media.length) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#666', fontSize: 14 }}>
          {display && media.length === 0 ? 'No media configured' : 'Loading...'}
        </p>
      </div>
    );
  }

  const announcementLabel = display.announcement_label || 'Actis welcomes';
  const announcementName = display.announcement_name || '';
  const announcementTitle = display.announcement_title || '';
  const showAnnouncement = !!display.announcement_enabled && (announcementName || announcementTitle);

  const layerStyle = (z) => ({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    opacity: 0,
    transition: 'none',
    zIndex: z,
    willChange: 'opacity',
    pointerEvents: 'none',
  });

  const stateColor = stateRef.current === STATE_SWAPPING ? '#fc7'
    : stateRef.current === STATE_PLAYING ? '#7f7'
    : '#888';
  const currentItem = mediaRef.current[currentIdxRef.current];
  const currentName = mseMode
    ? basename(mseLoopUrl)
    : singleVideoMode
      ? basename(playlistVideoUrl)
      : (currentItem ? basename(currentItem.file_path) : '—');
  const v = mseMode ? mseVideoRef.current : singleVideoMode ? singleVideoRef.current : videoRef.current;
  const rs = v?.readyState ?? '?';
  const ns = v?.networkState ?? '?';
  const ct = v ? v.currentTime.toFixed(2) : '0.00';
  const dur = v && v.duration && isFinite(v.duration) ? v.duration.toFixed(1) : '?';
  const paused = v ? (v.paused ? 'T' : 'F') : '?';
  const muted = v ? (v.muted ? 'T' : 'F') : '?';
  const bridgeOn = (bridgeCanvasRef.current && bridgeCanvasRef.current.style.opacity === '1');

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <div style={containerStyle}>
        {mseMode ? (
          /* MSE gapless-loop mode (all-video playlist): ONE <video> fed by Media Source Extensions on a
             ring (see the mse-loop effect). No src swap, no seek, no `ended` → black-free video→video
             loop. `loop` is left OFF here; the effect re-appends the buffer (or sets native loop on
             fallback). */
          <video
            ref={mseVideoRef}
            muted
            playsInline
            autoPlay
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 1,
              background: '#000',
            }}
          />
        ) : singleVideoMode ? (
          /* Seamless-loop mode: ONE <video> plays the whole concatenated playlist. No src swaps →
             no Tizen black gap between items; a ~100ms setInterval watchdog seeks to 0 ~1.5s before
             EOF (on the still-playing element, so no decoder teardown) for a black-free loop restart.
             NO `loop` attribute: it races with our seek AND suppresses `ended` (disabling recovery). */
          <video
            ref={singleVideoRef}
            muted
            playsInline
            autoPlay
            preload="auto"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 1,
              background: '#000',
            }}
            onTimeUpdate={handleSingleTimeUpdate}
            onEnded={handleSingleEnded}
            onError={handleSingleError}
            onPause={handleSinglePause}
            onPlaying={handleSinglePlaying}
            onSeeking={handleSingleSeeking}
            onSeeked={handleSingleSeeked}
            onWaiting={handleSingleWaiting}
            onStalled={handleSingleStalled}
            onLoadedMetadata={handleSingleLoadedMetadata}
            onLoadedData={handleSingleLoadedData}
          />
        ) : (
          <>
            <video
              ref={videoRef}
              muted
              playsInline
              preload="auto"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: 0,
                transition: 'none',
                zIndex: 1,
                willChange: 'opacity',
                background: '#000',
              }}
              onEnded={handleVideoEnded}
              onError={handleVideoError}
              onPlaying={handleVideoPlaying}
              onPause={handleVideoPause}
              onLoadStart={handleVideoLoadStart}
              onLoadedData={handleVideoLoadedData}
              onLoadedMetadata={handleVideoLoadedMetadata}
              onCanPlay={handleVideoCanPlay}
              onCanPlayThrough={handleVideoCanPlayThrough}
              onTimeUpdate={handleVideoTimeUpdate}
              onSeeked={handleVideoSeeked}
            />
            <img ref={imageARef} alt="" style={layerStyle(2)} />
            <img ref={imageBRef} alt="" style={layerStyle(2)} />
            <canvas
              ref={bridgeCanvasRef}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                zIndex: 3,
                pointerEvents: 'none',
                willChange: 'opacity',
              }}
            />
            {/* Last-frame poster cover for video->video swaps (z=3, above the canvas at equal z). */}
            <img ref={posterRef} alt="" style={layerStyle(3)} />
          </>
        )}

        {isDebug && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              zIndex: 999,
              pointerEvents: 'none',
              padding: '6px 8px',
              maxWidth: 'min(46vw, 520px)',
              maxHeight: '96vh',
              overflow: 'hidden',
              background: 'rgba(0,0,0,0.85)',
              color: '#0f0',
              fontFamily: 'monospace',
              fontSize: 12,
              lineHeight: 1.25,
              border: '1px solid rgba(0,255,128,0.35)',
            }}
          >
            <div style={{ color: '#0ff', fontWeight: 700 }}>v{ENGINE_VERSION} · {BUILD_STAMP}</div>
            <div style={{ color: (mseMode || singleVideoMode) ? '#7f7' : '#ff7', fontWeight: 700 }}>
              MODE: {mseMode ? 'mse-loop ✓ (all-video)' : singleVideoMode ? 'seamless-loop ✓' : 'per-item engine'}
            </div>
            <div style={{ color: stateColor, fontWeight: 700 }}>STATE: {stateRef.current}</div>
            <div>ITEM:  {currentName} ({ct}s / {dur}s)</div>
            <div>rs={rs} ns={ns} ct={ct} paused={paused} muted={muted}</div>
            {!singleVideoMode && !mseMode && (
              <div>BRIDGE: {bridgeOn ? 'on' : 'off'}    PREFETCH: {prefetchNameRef.current} ({prefetchStatusRef.current})</div>
            )}
            <div>
              ERRORS: <span style={{ color: errorCountRef.current > 0 ? '#f77' : '#7f7' }}>{errorCountRef.current}</span>
              {'   '}LAST-SWAP: {lastSwapMsRef.current}ms
            </div>
            <div>FPS: {fpsRateRef.current} (last 2s)</div>
            <hr style={{ borderColor: 'rgba(0,255,128,0.25)', margin: '4px 0' }} />
            {eventLogRef.current.map((e, i) => (
              <div
                key={i}
                style={{
                  color: COLOR_BY_CLASS[e.klass] || '#ddd',
                  opacity: Math.max(0.3, 1 - i * 0.012),
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {e.ts}  {e.msg}
              </div>
            ))}
          </div>
        )}

        {isPreview && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 20,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <div
              style={{
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: 6,
                letterSpacing: '0.05em',
                backdropFilter: 'blur(4px)',
              }}
            >
              PREVIEW — Playlist {previewPlaylist}
            </div>
            <button
              onClick={handlePublish}
              disabled={publishing}
              style={{
                background: publishing ? 'rgba(100,100,100,0.8)' : 'rgba(34,197,94,0.9)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                padding: '4px 12px',
                borderRadius: 6,
                border: 'none',
                cursor: publishing ? 'not-allowed' : 'pointer',
                backdropFilter: 'blur(4px)',
                letterSpacing: '0.05em',
              }}
            >
              {publishing ? 'Publishing...' : `Publish ${previewPlaylist} Live`}
            </button>
          </div>
        )}

        {showAnnouncement && (
          <div
            style={{
              position: 'absolute',
              bottom: colorBarHeight,
              left: '50%',
              transform: 'translateX(-50%)',
              width: '85%',
              zIndex: 10,
            }}
          >
            <div
              style={{
                background: 'rgba(5, 30, 50, 0.9)',
                borderRadius: '15px 15px 0 0',
                // padding: 'clamp(4px, 0.6vh, 8px) 0',
                // padding: 'clamp(6px, 1vh, 14px) 0',
                padding: 'clamp(3px, 0.5vh, 8px) 0',
                textAlign: 'center',
                color: '#ffffff',
              }}
            >
              {/* <div style={{ fontSize: 'clamp(9px, 1.1vw, 14px)', fontWeight: 400, opacity: 0.9, marginBottom: 4 }}> */}
              <div style={{ fontSize: 'clamp(7px, 0.8vw, 10px)', fontWeight: 400, opacity: 0.9, marginBottom: 2 }}>
                {announcementLabel}
              </div>
              {/* backup: <div style={{ fontSize: 'clamp(13px, 1.8vw, 24px)', fontWeight: 700, marginBottom: 2 }}> */}
              {announcementName && (
                <div style={{ fontSize: 'clamp(9px, 1.2vw, 16px)', fontWeight: 700, marginBottom: 1 }}>
                  {announcementName}
                </div>
              )}
              {/* backup: <div style={{ fontSize: 'clamp(11px, 1.3vw, 18px)', fontWeight: 700 }}> */}
              {announcementTitle && (
                <div style={{ fontSize: 'clamp(8px, 0.9vw, 13px)', fontWeight: 700 }}>
                  {announcementTitle}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: colorBarHeight,
            overflow: 'hidden',
            zIndex: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              width: '200%',
              height: '100%',
              animation: 'colorband-scroll 10s linear infinite',
            }}
          >
            {[0, 1].map((set) => (
              <div key={set} style={{ display: 'flex', width: '50%', height: '100%' }}>
                <div style={{ flex: 1, background: '#F39200' }} />
                <div style={{ flex: 1, background: '#78A22F' }} />
                <div style={{ flex: 1, background: '#E30613' }} />
                <div style={{ flex: 1, background: '#009EE3' }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes colorband-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
