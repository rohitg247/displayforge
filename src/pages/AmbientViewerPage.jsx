import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';

const IMAGE_DURATION = 5000;
const CROSSFADE_DURATION = 500;
const BRIDGE_FADE_DURATION = 150;
const SWAP_TIMEOUT_MS = 2000;
const POLL_INTERVAL = 5000;
const DECODE_SLOW_THRESHOLD_MS = 800;
const FRAME_STUCK_WARN_MS = 500;
const FRAME_STUCK_FATAL_MS = 1500;
const LOG_RING_SIZE = 30;
const DEBUG_TICK_MS = 200;

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
  const bridgeCanvasRef = useRef(null);
  const bridgeCtxRef = useRef(null);

  // Engine state
  const stateRef = useRef(STATE_IDLE);
  const currentItemTypeRef = useRef(null);
  const activeImageRef = useRef('A');
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
    const ts = fmtTimestamp(performance.now());
    eventLogRef.current = [{ ts, klass, msg }, ...eventLogRef.current].slice(0, LOG_RING_SIZE);
  }, [fmtTimestamp]);

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
      logEvent('state', `bridge on (${w}x${h})`);
      return true;
    } catch (err) {
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
      } else {
        pendingDataRef.current = { display: data, media: filteredMedia };
      }
    } catch (err) {
      console.error(err);
    }
  }, [id, isPreview, previewPlaylist]);

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
    let triedReload = false;

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

      // Stuck-frame watchdog
      if (!vid.paused && now - lastCtAtRef.current > FRAME_STUCK_WARN_MS) {
        if (!warnedStuck) {
          logEvent('warn', `frame-stuck rs=${vid.readyState} ns=${vid.networkState} ct=${ct.toFixed(2)}`);
          warnedStuck = true;
        }
        if (!triedReload && now - lastCtAtRef.current > FRAME_STUCK_FATAL_MS) {
          logEvent('error', 'frame-stuck-fatal — reloading');
          triedReload = true;
          try {
            vid.load();
            const p = vid.play();
            if (p && typeof p.then === 'function') p.catch(() => {});
          } catch (_) { /* swallow */ }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenValid, goState, applyPendingIfNeeded, startPrefetch]);

  /* ---------------------------- TRANSITION CASES ---------------------------- */

  const fadeOutBridge = useCallback((token, onDone) => {
    const el = bridgeCanvasRef.current;
    if (!el) { onDone(); return; }
    setBridgeOpacity(0, BRIDGE_FADE_DURATION);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      if (!tokenValid(token)) return;
      el.style.transition = 'none';
      const elapsed = Math.round(performance.now() - swapStartAtRef.current);
      logEvent('state', `bridge off (${elapsed}ms after swap)`);
      onDone();
    };
    const onEnd = () => finish();
    el.addEventListener('transitionend', onEnd);
    setTimeout(finish, BRIDGE_FADE_DURATION + 100);
  }, [setBridgeOpacity, tokenValid, logEvent]);

  const runVideoToVideo = useCallback((nextItem, nextIdx) => {
    const v = videoRef.current;
    if (!v) return;
    const token = bumpToken();
    swapStartAtRef.current = performance.now();
    goState(STATE_SWAPPING);

    captureBridge();
    setBridgeOpacity(1, 0);

    const url = nextItem.file_path;
    logEvent('lifecycle', `src-set ${basename(url)}`);
    v.src = url;
    v.load();
    logEvent('lifecycle', 'load() called');

    swapDeadlineRef.current = setTimeout(() => {
      if (!tokenValid(token)) return;
      logEvent('error', `swap-timeout (${SWAP_TIMEOUT_MS}ms) — forcing fade`);
      setBridgeOpacity(0, 0);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
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
      logEvent('state', 'video fade start (bridge)');
      fadeOutBridge(token, () => {
        logEvent('state', 'video fade end (bridge)');
        finalizeSwap(token, nextItem, nextIdx);
      });
    });
  }, [bumpToken, goState, captureBridge, setBridgeOpacity, logEvent, tokenValid, finalizeSwap, startFirstFrameLoop, fadeOutBridge]);

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
        nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        nextImg.style.opacity = '1';
        prevImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        prevImg.style.opacity = '0';
        setTimeout(() => {
          if (!tokenValid(token)) return;
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
        logEvent('state', `image fade start [video→${toKey}]`);
        nextImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        nextImg.style.opacity = '1';
        v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        v.style.opacity = '0';
        logEvent('lifecycle', 'video opacity 1→0');
        setTimeout(() => {
          if (!tokenValid(token)) return;
          logEvent('state', `image fade end [video→${toKey}]`);
          try { v.pause(); logEvent('lifecycle', 'video paused'); } catch (_) {}
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
      v.style.transition = 'none';
      v.style.opacity = '0';
      try { v.pause(); } catch (_) {}
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
      logEvent('error', `swap-timeout (${SWAP_TIMEOUT_MS}ms) — forcing fade`);
      v.style.transition = 'none';
      v.style.opacity = '1';
      activeImg.style.transition = 'none';
      activeImg.style.opacity = '0';
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
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
      requestAnimationFrame(() => {
        if (!tokenValid(token)) return;
        logEvent('state', `image fade out [${activeKey}]`);
        logEvent('state', 'video fade in');
        v.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
        v.style.opacity = '1';
        activeImg.style.transition = `opacity ${CROSSFADE_DURATION}ms ease-in-out`;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [bumpToken, goState, logEvent, startPrefetch]);

  /* ----------------------------- AUTOSTART EFFECT --------------------------- */

  useEffect(() => {
    if (stateRef.current !== STATE_IDLE) return;
    if (!display || media.length === 0) return;
    if (!videoRef.current || !imageARef.current || !imageBRef.current || !bridgeCanvasRef.current) return;
    logEvent('lifecycle', 'mount [video]');
    logEvent('lifecycle', 'mount [img-A]');
    logEvent('lifecycle', 'mount [img-B]');
    logEvent('lifecycle', 'mount [bridge]');
    start(media[0]);
  }, [display, media, start, logEvent]);

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
    if (stateRef.current === STATE_SWAPPING && swapDeadlineRef.current) {
      // Fast-fail the swap
      clearTimeout(swapDeadlineRef.current);
      swapDeadlineRef.current = setTimeout(() => {}, 0);
    }
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
    ? 'clamp(8px, 1.35vh, 15px)'
    : 'clamp(10px, 1.8vh, 20px)';

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
  const currentName = currentItem ? basename(currentItem.file_path) : '—';
  const v = videoRef.current;
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
              background: 'rgba(0,0,0,0.85)',
              color: '#0f0',
              fontFamily: 'monospace',
              fontSize: 12,
              lineHeight: 1.25,
              border: '1px solid rgba(0,255,128,0.35)',
            }}
          >
            <div style={{ color: stateColor, fontWeight: 700 }}>STATE: {stateRef.current}</div>
            <div>ITEM:  {currentName} ({ct}s / {dur}s)</div>
            <div>rs={rs} ns={ns} ct={ct} paused={paused} muted={muted}</div>
            <div>BRIDGE: {bridgeOn ? 'on' : 'off'}    PREFETCH: {prefetchNameRef.current} ({prefetchStatusRef.current})</div>
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
                  opacity: Math.max(0.25, 1 - i * 0.025),
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
                padding: 'clamp(6px, 1vh, 14px) 0',
                textAlign: 'center',
                color: '#ffffff',
              }}
            >
              <div style={{ fontSize: 'clamp(9px, 1.1vw, 14px)', fontWeight: 400, opacity: 0.9, marginBottom: 4 }}>
                {announcementLabel}
              </div>
              {announcementName && (
                <div style={{ fontSize: 'clamp(13px, 1.8vw, 24px)', fontWeight: 700, marginBottom: 2 }}>
                  {announcementName}
                </div>
              )}
              {announcementTitle && (
                <div style={{ fontSize: 'clamp(11px, 1.3vw, 18px)', fontWeight: 700 }}>
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
