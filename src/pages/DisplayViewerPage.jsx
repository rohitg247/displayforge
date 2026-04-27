import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ZoomIn } from 'lucide-react';
import { api } from '@/services/api';
import { DisplayNav } from '@/components/layout/DisplayNav';

import bgImage from '@/assets/BG.jpg';
import actisLogo from '@/assets/Actis_Logo.png';
import homeBg from '@/assets/Home.png';
import about1 from '@/assets/About_1.png';
import about2 from '@/assets/About_2.png';
import about3 from '@/assets/About_3.png';
import about4 from '@/assets/About_4.png';
import colorBand from '@/assets/ColorBand.png';

const aboutImages = [about1, about2, about3, about4];
const SECTIONS = ['home', 'about', 'caseStudies', 'solutions'];

export function DisplayViewerPage() {
  const { id: displayId } = useParams();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';

  const [display, setDisplay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [globalIndex, setGlobalIndex] = useState(0);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [mainImageBroken, setMainImageBroken] = useState(false);
  const [brokenThumbs, setBrokenThumbs] = useState({});

  useEffect(() => {
    setLoading(true);
    setError(null);

    api
      .getDisplay(Number(displayId), isPreview)
      .then((data) => {
        setDisplay(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [displayId, isPreview]);

  const caseStudies = display?.pages?.caseStudies || [];

  const sectionSizes = {
    home: 1,
    about: 4,
    caseStudies: Math.max(caseStudies.length, 1),
    solutions: 1,
  };

  const slides = [];
  SECTIONS.forEach((section) => {
    for (let i = 0; i < sectionSizes[section]; i++) {
      slides.push({ section, localIndex: i });
    }
  });

  const totalGlobal = slides.length;
  const currentSlide = slides[globalIndex] || slides[0];
  const activePage = currentSlide.section;
  const localIndex = currentSlide.localIndex;

  const sectionStartIndex = {};
  let counter = 0;
  SECTIONS.forEach((section) => {
    sectionStartIndex[section] = counter;
    counter += sectionSizes[section];
  });

  const isFirst = globalIndex === 0;
  const isLast = globalIndex === totalGlobal - 1;

  const activeCaseStudy =
    activePage === 'caseStudies' ? (caseStudies[localIndex] || null) : null;

  const getImageUrl = (path) => {
    if (!path) return null;
    if (path.startsWith('/uploads/')) return path;
    return path;
  };

  const displayedImage =
    getImageUrl(activeCaseStudy?.thumbnails?.[selectedImageIndex]) ||
    getImageUrl(activeCaseStudy?.mainImage) ||
    null;

  useEffect(() => {
    setMainImageBroken(false);
  }, [displayedImage, activePage, localIndex]);

  useEffect(() => {
    setBrokenThumbs({});
  }, [activeCaseStudy?.id]);

  const handlePrev = () => {
    if (globalIndex <= 0) return;
    setGlobalIndex((prev) => prev - 1);
    setSelectedImageIndex(0);
  };

  const handleNext = () => {
    if (globalIndex >= totalGlobal - 1) return;
    setGlobalIndex((prev) => prev + 1);
    setSelectedImageIndex(0);
  };

  const handleSetActivePage = (page) => {
    setGlobalIndex(sectionStartIndex[page] || 0);
    setSelectedImageIndex(0);
  };

  const staticSectionWrapStyle = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    minWidth: 0,
  };

  const staticImageStyle = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    objectPosition: 'center',
    display: 'block',
  };

  const caseStudyFrameStyle = {
    width: '100%',
    height: '100%',
    minHeight: 0,
    borderRadius: 'clamp(10px, 1.2vw, 18px)',
    backgroundColor: 'rgba(0,0,0,0.28)',
    border: '1px solid rgba(255,255,255,0.12)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 'clamp(10px, 1vw, 18px)',
  };

  if (loading) {
    return (
      <div
        className="w-screen h-screen flex items-center justify-center"
        style={{ backgroundColor: '#0a0f1e' }}
      >
        <p className="text-white text-lg">Loading...</p>
      </div>
    );
  }

  if (error || !display) {
    return (
      <div
        className="w-screen h-screen flex items-center justify-center"
        style={{ backgroundColor: '#0a0f1e' }}
      >
        <p className="text-white text-lg">{error || 'Display not found'}</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen overflow-hidden" style={{ position: 'relative' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url(${bgImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.45)',
          zIndex: 1,
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 20,
          pointerEvents: 'none',
        }}
      >
        <img
          src={actisLogo}
          alt="Actis Logo"
          style={{
            height: 'clamp(180px, 22vh, 340px)',
            width: 'auto',
            padding: 'clamp(12px, 1.4vw, 24px)',
            objectFit: 'contain',
            display: 'block',
          }}
        />
      </div>

      {isPreview && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 20,
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
          PREVIEW MODE
        </div>
      )}

      <DisplayNav
        activePage={activePage}
        setActivePage={handleSetActivePage}
        currentIndex={localIndex}
        totalPages={sectionSizes[activePage]}
        handlePrev={handlePrev}
        handleNext={handleNext}
        isFirst={isFirst}
        isLast={isLast}
      />

      <div
        style={{
          position: 'absolute',
          left: '10%',
          right: '10%',
          top: '16%',
          bottom: '20%',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {activePage === 'home' && (
          <div style={staticSectionWrapStyle}>
            <img src={homeBg} alt="Home" style={staticImageStyle} />
          </div>
        )}

        {activePage === 'about' && (
          <div style={staticSectionWrapStyle}>
            <img
              src={aboutImages[localIndex]}
              alt={`About ${localIndex + 1}`}
              style={staticImageStyle}
            />
          </div>
        )}

        {activePage === 'caseStudies' && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              width: '100%',
              minHeight: 0,
            }}
          >
            <h1
              style={{
                color: '#e8362a',
                fontSize: 'clamp(22px, 2.2vw, 34px)',
                fontWeight: 700,
                textAlign: 'center',
                marginBottom: 'clamp(12px, 2vh, 24px)',
                flexShrink: 0,
              }}
            >
              Problems we help solve...
            </h1>

            {activeCaseStudy ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '30% 1fr clamp(60px, 8vw, 100px)',
                  gap: 'clamp(12px, 2vw, 28px)',
                  flex: 1,
                  minHeight: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    minHeight: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      backgroundColor: '#e8362a',
                      clipPath: 'polygon(0 0, 90% 0, 100% 50%, 90% 100%, 0 100%)',
                      padding:
                        'clamp(4px,0.8vh,8px) clamp(18px,2.5vw,32px) clamp(4px,0.8vh,8px) clamp(12px,1.5vw,20px)',
                      color: '#ffffff',
                      fontSize: 'clamp(11px, 1.2vw, 16px)',
                      fontWeight: 600,
                      marginBottom: 'clamp(8px, 1vh, 16px)',
                      alignSelf: 'flex-start',
                      flexShrink: 0,
                    }}
                  >
                    Case Study: {activeCaseStudy.category}
                  </div>

                  <h2
                    style={{
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: 'clamp(18px, 1.8vw, 26px)',
                      lineHeight: 1.3,
                      marginBottom: 'clamp(10px, 1.5vh, 20px)',
                      flexShrink: 0,
                    }}
                  >
                    {activeCaseStudy.title}
                  </h2>

                  <div
                    style={{
                      flex: 1,
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'clamp(8px, 1vh, 16px)',
                      minHeight: 0,
                      paddingRight: 'clamp(2px, 0.4vw, 8px)',
                    }}
                  >
                    {activeCaseStudy.bulletPoints
                      ?.filter((p) => p.trim())
                      .map((point, index) => (
                        <div
                          key={index}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 'clamp(8px, 1vh, 16px)',
                          }}
                        >
                          <div
                            style={{
                              width: 'clamp(6px, 0.7vw, 10px)',
                              height: 'clamp(6px, 0.7vw, 10px)',
                              borderRadius: '50%',
                              backgroundColor: '#e8362a',
                              marginTop: 'clamp(5px, 0.6vh, 9px)',
                              flexShrink: 0,
                            }}
                          />
                          <p
                            style={{
                              color: '#ffffff',
                              fontSize: 'clamp(13px, 1.2vw, 16px)',
                              lineHeight: 1.6,
                              margin: 0,
                            }}
                          >
                            {point}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0,
                    minHeight: 0,
                    height: '100%',
                  }}
                >
                  <div style={caseStudyFrameStyle}>
                    {displayedImage && !mainImageBroken ? (
                      <img
                        src={displayedImage}
                        alt="Case Study"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'contain',
                          objectPosition: 'center',
                          display: 'block',
                        }}
                        onError={() => setMainImageBroken(true)}
                      />
                    ) : (
                      <span
                        style={{
                          color: 'rgba(255,255,255,0.45)',
                          fontSize: 'clamp(12px, 1.2vw, 16px)',
                          textAlign: 'center',
                        }}
                      >
                        No image uploaded
                      </span>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'clamp(6px, 0.8vh, 14px)',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                  }}
                >
                  {[0, 1, 2].map((index) => {
                    const thumbUrl = getImageUrl(activeCaseStudy.thumbnails?.[index]);
                    const isBroken = brokenThumbs[index];

                    return (
                      <button
                        key={index}
                        type="button"
                        onClick={() => setSelectedImageIndex(index)}
                        style={{
                          width: 'clamp(55px, 7vw, 95px)',
                          height: 'clamp(55px, 7vw, 95px)',
                          borderRadius: 'clamp(6px, 0.8vw, 10px)',
                          overflow: 'hidden',
                          cursor: 'pointer',
                          border:
                            selectedImageIndex === index
                              ? '2px solid #e8362a'
                              : '2px solid rgba(255,255,255,0.15)',
                          position: 'relative',
                          background: 'rgba(0,0,0,0.28)',
                          padding: 'clamp(4px, 0.5vw, 8px)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {thumbUrl && !isBroken ? (
                          <img
                            src={thumbUrl}
                            alt={`Thumb ${index + 1}`}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'contain',
                              objectPosition: 'center',
                              display: 'block',
                            }}
                            onError={() =>
                              setBrokenThumbs((prev) => ({ ...prev, [index]: true }))
                            }
                          />
                        ) : (
                          <ZoomIn size={14} color="rgba(255,255,255,0.35)" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <p style={{ color: 'rgba(255,255,255,0.5)' }}>
                  No case studies available
                </p>
              </div>
            )}
          </div>
        )}

        {activePage === 'solutions' && (
          <div style={staticSectionWrapStyle}>
            <img src={colorBand} alt="Solutions" style={staticImageStyle} />
          </div>
        )}
      </div>
    </div>
  );
}