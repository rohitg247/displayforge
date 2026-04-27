import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';


const IMAGE_DURATION = 5000;
const FADE_DURATION = 800;
const POLL_INTERVAL = 5000;


export function AmbientViewerPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const previewPlaylist = searchParams.get('playlist') || 'A';

  const [display, setDisplay] = useState(null);
  const [media, setMedia] = useState([]);
  const [activeLayer, setActiveLayer] = useState(0); // 0 or 1
  const [layerMedia, setLayerMedia] = useState([null, null]); // media index for each layer
  const [publishing, setPublishing] = useState(false); // ✅ NEW: publish loading state

  const pendingDataRef = useRef(null);
  const currentIdxRef = useRef(0);
  const mediaRef = useRef([]);
  const displayRef = useRef(null);
  const videoRefs = [useRef(null), useRef(null)];
  const timerRef = useRef(null);
  const initializedRef = useRef(false);
  const pendingActivateRef = useRef(null);
  const loadFallbackRef = useRef(null);


  // Fetch display data
  const fetchData = useCallback(async () => {
    try {
      // ✅ CHANGE 1: pass isPreview as admin flag so preview sees draft media
      const data = await api.getAmbientDisplay(Number(id), null, isPreview);
      const playlistToUse = isPreview ? previewPlaylist : (data.active_playlist || 'A');
      const filteredMedia = (data.media || []).filter(m => m.playlist === playlistToUse);

      if (!initializedRef.current) {
        // First load — apply immediately
        setDisplay(data);
        displayRef.current = data;
        setMedia(filteredMedia);
        mediaRef.current = filteredMedia;
        if (filteredMedia.length > 0) {
          currentIdxRef.current = 0;
          setLayerMedia([0, null]);
          setActiveLayer(0);
        }
        initializedRef.current = true;
      } else {
        // Store for next transition
        pendingDataRef.current = { display: data, media: filteredMedia, playlist: playlistToUse };
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, [id, isPreview, previewPlaylist]);


  // Activate a layer only after its media has loaded; fallback after 2s for slow TV hardware
  const handleLayerReady = useCallback((layerIdx) => {
    if (pendingActivateRef.current !== layerIdx) return;
    if (loadFallbackRef.current) { clearTimeout(loadFallbackRef.current); loadFallbackRef.current = null; }
    pendingActivateRef.current = null;
    setActiveLayer(layerIdx);
  }, []);

  const armLayerActivation = useCallback((layerIdx) => {
    if (loadFallbackRef.current) clearTimeout(loadFallbackRef.current);
    pendingActivateRef.current = layerIdx;
    loadFallbackRef.current = setTimeout(() => {
      if (pendingActivateRef.current === layerIdx) {
        pendingActivateRef.current = null;
        setActiveLayer(layerIdx);
      }
    }, 2000);
  }, []);


  // Initial fetch + polling
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);


  // Apply pending data if media sequence changed
  const applyPendingIfNeeded = useCallback(() => {
    const pending = pendingDataRef.current;
    if (!pending) return false;

    // Update display info always (announcement, orientation etc)
    setDisplay(pending.display);
    displayRef.current = pending.display;

    // Check if media sequence actually changed
    const currentPaths = mediaRef.current.map(m => m.file_path).join(',');
    const newPaths = pending.media.map(m => m.file_path).join(',');

    if (currentPaths !== newPaths) {
      setMedia(pending.media);
      mediaRef.current = pending.media;
      currentIdxRef.current = 0;
      pendingDataRef.current = null;

      if (pending.media.length > 0) {
        const inactiveLayer = activeLayer === 0 ? 1 : 0;
        setLayerMedia(prev => {
          const next = [...prev];
          next[inactiveLayer] = 0;
          return next;
        });
        armLayerActivation(inactiveLayer);
      }
      return true;
    }

    pendingDataRef.current = null;
    return false;
  }, [activeLayer, armLayerActivation]);


  // Advance to next media
  const advance = useCallback(() => {
    // Try applying pending data first
    if (applyPendingIfNeeded()) return;

    const currentMedia = mediaRef.current;
    if (currentMedia.length <= 1) {
      // Still check for pending updates even with single media
      applyPendingIfNeeded();
      if (currentMedia.length === 1) {
        // Re-trigger timer for single image to keep checking
        const item = currentMedia[0];
        if (item?.media_type === 'image') {
          timerRef.current = setTimeout(advance, IMAGE_DURATION);
        }
      }
      return;
    }

    const nextIdx = (currentIdxRef.current + 1) % currentMedia.length;
    currentIdxRef.current = nextIdx;
    const inactiveLayer = activeLayer === 0 ? 1 : 0;

    // Load on inactive layer, activate only when media is ready
    setLayerMedia(prev => {
      const next = [...prev];
      next[inactiveLayer] = nextIdx;
      return next;
    });

    armLayerActivation(inactiveLayer);
  }, [activeLayer, applyPendingIfNeeded, armLayerActivation]);


  // Schedule advance for images on the active layer
  useEffect(() => {
    if (!media.length) return;
    const idx = layerMedia[activeLayer];
    if (idx === null || idx === undefined) return;
    const item = media[idx];
    if (!item) return;

    if (item.media_type === 'image') {
      timerRef.current = setTimeout(advance, IMAGE_DURATION);
    }
    return () => clearTimeout(timerRef.current);
  }, [activeLayer, layerMedia, media, advance]);


  // Handle video end
  const handleVideoEnd = useCallback(() => {
    advance();
  }, [advance]);


  // Auto-play video on active layer
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


  // ✅ NEW: Publish handler — called from preview overlay button
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


  // Orientation container styles
  const orientation = display?.orientation || 'landscape';
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
      maxWidth: '100%',
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
    const src = item.file_path; // relative — proxied through vite preview to backend
    const isActive = activeLayer === layerIdx;

    return (
      <div
        key={layerIdx}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: isActive ? 1 : 0,
          transition: `opacity ${FADE_DURATION}ms ease-in-out`,
          zIndex: isActive ? 2 : 1,
        }}
      >
        {item.media_type === 'video' ? (
          <video
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
        {/* Layer 0 */}
        {renderLayer(0)}
        {/* Layer 1 */}
        {renderLayer(1)}

        {/* ✅ CHANGE 2: Preview badge + Publish Live button (only shown in preview mode) */}
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

        {/* Announcement overlay — sits just above the color band */}
        {showAnnouncement && (
          <div
            style={{
              position: 'absolute',
              bottom: 'clamp(5px, 0.9vh, 10px)',
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

        {/* Color band — always visible, full width, pinned to bottom */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 'clamp(5px, 0.9vh, 10px)',
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
