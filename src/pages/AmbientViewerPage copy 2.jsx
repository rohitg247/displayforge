import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';

const IMAGE_DURATION = 5000;
const CROSSFADE_DURATION = 500;
const POLL_INTERVAL = 5000;

export function AmbientViewerPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const previewPlaylist = searchParams.get('playlist') || 'A';

  const [display, setDisplay] = useState(null);
  const [media, setMedia] = useState([]);
  const [activeLayer, setActiveLayer] = useState(0);
  const [layerMedia, setLayerMedia] = useState([null, null]);
  const [layerSeq, setLayerSeq] = useState([0, 0]);
  const [publishing, setPublishing] = useState(false);

  const mediaRef = useRef([]);
  const currentIdxRef = useRef(0);
  const nextIndexRef = useRef(null);
  const timerRef = useRef(null);
  const transitionStateRef = useRef('INIT');
  const initializedRef = useRef(false);
  const pendingDataRef = useRef(null);
  const activeLayerRef = useRef(0);   // always-current mirror of activeLayer state
  const expectedLayerRef = useRef(0); // which layer index we're waiting to fire onCanPlay/onLoad
  const videoRefs = [useRef(null), useRef(null)];
  const prebufferedLayerRef = useRef(null); // null | 0 | 1 — layer with video frozen at frame 0
  const eventLogRef = useRef([]);           // rolling debug event log (last 15 entries)
  // True while the freeze sequence (play→pause→currentTime=0) is executing.
  // Acts as a synchronous mutex: some WebKit/Tizen builds fire onCanPlay re-entrantly
  // inside play() before JS yields, so expectedLayerRef = -1 alone is not sufficient.
  const prebufferFrozenRef = useRef(false);

  const isDebug = searchParams.get('debug') === 'true';
  const [, setDebugTick] = useState(0);

  const logEvent = useCallback((label) => {
    const ts = (performance.now() / 1000).toFixed(2);
    eventLogRef.current = [`${ts}s — ${label}`, ...eventLogRef.current].slice(0, 15);
  }, []);

  /* ---------------- FETCH ---------------- */

  const fetchData = useCallback(async () => {
    try {
      const data = await api.getAmbientDisplay(Number(id), null, isPreview);
      const playlistToUse = isPreview ? previewPlaylist : (data.active_playlist || 'A');
      const filteredMedia = (data.media || []).filter(m => m.playlist === playlistToUse);

      if (!initializedRef.current) {
        setDisplay(data);
        setMedia(filteredMedia);
        mediaRef.current = filteredMedia;

        if (filteredMedia.length > 0) {
          currentIdxRef.current = 0;
          nextIndexRef.current = 0;
          expectedLayerRef.current = 0;
          transitionStateRef.current = 'LOADING_NEXT';
          setLayerMedia([0, null]);
          setLayerSeq(prev => [prev[0] + 1, prev[1]]);
        }

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
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    if (!isDebug) return;
    const id = setInterval(() => setDebugTick(t => t + 1), 200);
    return () => clearInterval(id);
  }, [isDebug]);

  /* ---------------- PLAYBACK ENGINE ---------------- */

  // No activeLayer in deps — all reactive values accessed via refs (stable callback).
  const applyPendingIfNeeded = useCallback(() => {
    const pending = pendingDataRef.current;
    if (!pending) return false;

    const currentPaths = mediaRef.current.map(m => m.file_path).join(',');
    const newPaths = pending.media.map(m => m.file_path).join(',');

    setDisplay(pending.display);

    if (currentPaths !== newPaths) {
      setMedia(pending.media);
      mediaRef.current = pending.media;
      currentIdxRef.current = 0;
      nextIndexRef.current = 0;
      prebufferedLayerRef.current = null;
      transitionStateRef.current = 'LOADING_NEXT';

      const inactiveLayer = activeLayerRef.current === 0 ? 1 : 0;
      expectedLayerRef.current = inactiveLayer;

      setLayerMedia(prev => { const next = [...prev]; next[inactiveLayer] = 0; return next; });
      setLayerSeq(prev => { const next = [...prev]; next[inactiveLayer] += 1; return next; });

      pendingDataRef.current = null;
      return true;
    }

    pendingDataRef.current = null;
    return false;
  }, []);

  // deps [] — requestTransition is captured via setTimeout closure (called after both are defined);
  // setLayerMedia/setLayerSeq are stable React setters.
  const startDisplayClock = useCallback((item) => {
    if (!item) return;
    transitionStateRef.current = 'DISPLAYING';
    logEvent(`startDisplayClock — ${item.file_path?.split('/').pop()}`);

    if (item.media_type === 'image') {
      timerRef.current = setTimeout(() => { requestTransition(); }, IMAGE_DURATION);
    }

    // Pre-buffer next item on inactive layer immediately
    const currentMedia = mediaRef.current;
    if (currentMedia.length <= 1) return;

    const nextIdx = (currentIdxRef.current + 1) % currentMedia.length;
    nextIndexRef.current = nextIdx;
    const inactiveLayer = activeLayerRef.current === 0 ? 1 : 0;
    expectedLayerRef.current = inactiveLayer;
    prebufferedLayerRef.current = null; // reset: new pre-buffer cycle starting
    prebufferFrozenRef.current = false; // reset mutex for new pre-buffer cycle

    setLayerMedia(prev => { const n = [...prev]; n[inactiveLayer] = nextIdx; return n; });
    setLayerSeq(prev  => { const n = [...prev]; n[inactiveLayer] += 1;    return n; });
    logEvent(`prebuffer mounted [${inactiveLayer}] — ${currentMedia[nextIdx]?.file_path?.split('/').pop()}`);

    // Fallback for platforms (e.g. Tizen WebKit) where onCanPlay does not fire on hidden
    // (inactive) layer videos. preload="auto" still causes decode; after 300ms treat the
    // layer as pre-buffered even without onCanPlay confirmation.
    // inactiveLayer is a local const — each call captures its own value in the closure.
    // Three guards prevent a stale timeout from a previous cycle misfiring:
    //   1. transitionStateRef === 'DISPLAYING'  — state hasn't changed
    //   2. expectedLayerRef   === inactiveLayer — this cycle's inactive layer is still expected
    //   3. prebufferedLayerRef === null         — onCanPlay didn't already resolve it
    setTimeout(() => {
      if (
        transitionStateRef.current === 'DISPLAYING' &&
        expectedLayerRef.current === inactiveLayer &&
        prebufferedLayerRef.current === null
      ) {
        prebufferedLayerRef.current = inactiveLayer;
        expectedLayerRef.current = -1; // consistent with Case B — stop any late onCanPlay
        logEvent(`prebuffer fallback [${inactiveLayer}] (onCanPlay did not fire)`);
      }
    }, 300);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestTransition = useCallback(() => {
    if (transitionStateRef.current !== 'DISPLAYING') return;

    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }

    if (applyPendingIfNeeded()) { prebufferedLayerRef.current = null; return; }

    // Fast path: next video is already pre-buffered at frame 0 — flip instantly.
    // Covers image→video transitions (including playlist loop reset) where requestTransition
    // is the caller rather than handleVideoEnd.
    if (prebufferedLayerRef.current !== null) {
      const readyLayer = prebufferedLayerRef.current;
      currentIdxRef.current = nextIndexRef.current;
      activeLayerRef.current = readyLayer;
      prebufferedLayerRef.current = null;
      transitionStateRef.current = 'DISPLAYING';
      setActiveLayer(readyLayer); // autoplay useEffect fires → play() from frame 0
      logEvent(`setActiveLayer → ${readyLayer} (pre-buffer fast path)`);
      const item = mediaRef.current[currentIdxRef.current];
      startDisplayClock(item);
      return;
    }

    const currentMedia = mediaRef.current;
    if (currentMedia.length <= 1) return;

    transitionStateRef.current = 'LOADING_NEXT';

    const nextIdx = (currentIdxRef.current + 1) % currentMedia.length;
    nextIndexRef.current = nextIdx;

    const inactiveLayer = activeLayerRef.current === 0 ? 1 : 0;
    expectedLayerRef.current = inactiveLayer;

    setLayerMedia(prev => { const next = [...prev]; next[inactiveLayer] = nextIdx; return next; });
    setLayerSeq(prev => { const next = [...prev]; next[inactiveLayer] += 1; return next; });
  }, [applyPendingIfNeeded, startDisplayClock, logEvent]);

  const handleLayerReady = useCallback((layerIdx) => {
    // Case B: pre-buffer completion — fired while current item is still DISPLAYING
    if (transitionStateRef.current === 'DISPLAYING') {
      if (layerIdx !== expectedLayerRef.current) return;
      // Primary guard: freeze sequence is already in progress — block re-entry.
      // Handles synchronous onCanPlay re-fires that occur inside play() on some
      // WebKit/Tizen builds before JS yields back to the event loop.
      if (prebufferFrozenRef.current) return;
      const item = mediaRef.current[nextIndexRef.current];
      logEvent(`onCanPlay/onLoad [${layerIdx}] — ${item?.file_path?.split('/').pop()}`);
      if (item?.media_type === 'video') {
        const vr = videoRefs[layerIdx].current;
        if (vr) {
          prebufferFrozenRef.current = true; // set before play() — blocks re-entrant onCanPlay
          vr.play().catch(() => {}); // fire-and-forget
          vr.pause();                // synchronous cancel — freeze in same microtask
          vr.currentTime = 0;
          logEvent(`play() called [${layerIdx}]`);
          logEvent(`pause() called [${layerIdx}] (pre-buffer freeze)`);
        }
      }
      prebufferedLayerRef.current = layerIdx;
      // Secondary guard: blocks async onCanPlay re-fires (future event-loop ticks).
      expectedLayerRef.current = -1;
      return;
    }

    // Case A: normal transition — LOADING_NEXT → flip → DISPLAYING
    if (transitionStateRef.current !== 'LOADING_NEXT') return;
    if (layerIdx !== expectedLayerRef.current) return;

    transitionStateRef.current = 'FADING';
    activeLayerRef.current = layerIdx;
    setActiveLayer(layerIdx);
    currentIdxRef.current = nextIndexRef.current;

    const nextItem = mediaRef.current[currentIdxRef.current];
    logEvent(`setActiveLayer → ${layerIdx}`);

    if (nextItem?.media_type !== 'image') {
      // Video: enter DISPLAYING immediately and kick off the pre-buffer cycle
      transitionStateRef.current = 'DISPLAYING';
      startDisplayClock(nextItem);
    } else {
      // Image: wait for CSS crossfade, then start display clock
      setTimeout(() => { startDisplayClock(nextItem); }, CROSSFADE_DURATION);
    }
  }, [startDisplayClock, logEvent]);

  const handleVideoEnd = useCallback(() => {
    if (transitionStateRef.current !== 'DISPLAYING') return;
    logEvent(`onEnded [${activeLayerRef.current}]`);

    if (prebufferedLayerRef.current !== null) {
      // Fast path: pre-buffered video is frozen at frame 0 — instant flip
      const readyLayer = prebufferedLayerRef.current;
      currentIdxRef.current = nextIndexRef.current;
      activeLayerRef.current = readyLayer;
      prebufferedLayerRef.current = null;
      transitionStateRef.current = 'DISPLAYING';
      setActiveLayer(readyLayer); // autoplay useEffect fires → play() from frame 0
      logEvent(`setActiveLayer → ${readyLayer} (pre-buffer fast path)`);
      const item = mediaRef.current[currentIdxRef.current];
      startDisplayClock(item); // immediately pre-buffer the item after this one
      return;
    }

    // Slow path: pre-buffer wasn't ready, fall back to normal transition
    requestTransition();
  }, [requestTransition, startDisplayClock, logEvent]);

  /* ---------------- VIDEO AUTOPLAY ---------------- */

  useEffect(() => {
    const idx = layerMedia[activeLayer];
    if (idx === null || idx === undefined || !media[idx]) return;
    if (media[idx].media_type === 'video') {
      const ref = videoRefs[activeLayer];
      if (ref.current) {
        ref.current.currentTime = 0;
        ref.current.play().catch(() => {});
      }
    }
  }, [activeLayer, layerMedia, media]);

  /* ---------------- PUBLISH ---------------- */

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

  /* ---------------- RENDER ---------------- */

  const orientation = display?.orientation || 'landscape';

  const colorBarHeight =
    orientation === 'portrait'
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

  const renderLayer = (layerIdx) => {
    const mediaIdx = layerMedia[layerIdx];
    if (mediaIdx === null || mediaIdx === undefined) return null;
    const item = media[mediaIdx];
    if (!item) return null;
    const src = item.file_path;
    const isActive = activeLayer === layerIdx;

    return (
      <div
        key={layerIdx}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: isActive ? 1 : 0,
          transition: item.media_type === 'image' ? `opacity ${CROSSFADE_DURATION}ms ease` : 'none',
          zIndex: isActive ? 2 : 1,
        }}
      >
        {item.media_type === 'video' ? (
          <video
            key={layerSeq[layerIdx]}
            ref={videoRefs[layerIdx]}
            src={src}
            muted
            playsInline
            preload="auto"
            onCanPlay={() => handleLayerReady(layerIdx)}
            onEnded={isActive ? handleVideoEnd : undefined}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <img
            key={layerSeq[layerIdx]}
            src={src}
            alt=""
            onLoad={() => handleLayerReady(layerIdx)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </div>
    );
  };

  const announcementLabel = display.announcement_label || 'Actis welcomes';
  const announcementName = display.announcement_name || '';
  const announcementTitle = display.announcement_title || '';
  const showAnnouncement = !!display.announcement_enabled && (announcementName || announcementTitle);

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
        {renderLayer(0)}
        {renderLayer(1)}

        {isDebug && (
          <div style={{
            position: 'fixed', top: 0, left: 0, zIndex: 999,
            pointerEvents: 'none', padding: 8,
            background: 'rgba(0,0,0,0.78)', color: '#0f0',
            fontFamily: 'monospace', fontSize: 10, lineHeight: 1.5,
            maxWidth: 380,
          }}>
            <div>State: <b>{transitionStateRef.current}</b></div>
            <div>Active Layer: <b>{activeLayerRef.current}</b></div>
            <div>Pre-buffer: <b>{prebufferedLayerRef.current ?? 'none'}</b></div>
            {[0, 1].map(li => {
              const mIdx = layerMedia[li];
              const fname = mIdx != null ? (mediaRef.current[mIdx]?.file_path?.split('/').pop() ?? '?') : '—';
              return (
                <div key={li}>
                  L{li}: {fname}
                  {prebufferedLayerRef.current === li ? '  PRE-BUFFERED' : ''}
                  {activeLayerRef.current === li ? '  ACTIVE' : ''}
                </div>
              );
            })}
            <hr style={{ borderColor: '#0f04', margin: '4px 0' }} />
            {eventLogRef.current.map((e, i) => (
              <div key={i} style={{ opacity: Math.max(0.15, 1 - i * 0.065) }}>{e}</div>
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
