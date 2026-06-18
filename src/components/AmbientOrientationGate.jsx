import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { api } from "@/services/api";

// Orientation gate for the ambient viewer. Wraps <AmbientViewerPage/> at the route level so the
// viewer itself is never touched. It detects the DEVICE orientation (matchMedia) and compares it to
// the display's CONFIGURED orientation (fetched once). On a mismatch it overlays a polished message
// telling the operator to use the correctly-oriented screen. The viewer stays mounted underneath, so
// nothing tears down — the overlay is purely visual (z-index above everything).
//
// Only the LIVE view is gated; admin preview (?preview=true) is left alone so it can be checked on any
// device. Standalone visuals (framer-motion only — no theme/TOD dependencies).

const EASE = [0.22, 1, 0.36, 1];

export default function AmbientOrientationGate({ children }) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get("preview") === "true";

  const [required, setRequired] = useState(null); // 'portrait' | 'landscape' | null (unknown → no gate)
  const [isPortrait, setIsPortrait] = useState(
    () => window.matchMedia("(orientation: portrait)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(orientation: portrait)");
    const handler = (e) => setIsPortrait(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getAmbientDisplay(Number(id), null, isPreview)
      .then((d) => {
        if (!cancelled && (d?.orientation === "portrait" || d?.orientation === "landscape")) {
          setRequired(d.orientation);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, isPreview]);

  const deviceOrientation = isPortrait ? "portrait" : "landscape";
  const mismatch = !isPreview && required && required !== deviceOrientation;

  const requiredLabel = required === "portrait" ? "Portrait" : "Landscape";

  return (
    <>
      {children}

      <AnimatePresence>
        {mismatch && (
          <motion.div
            key="ambient-orientation-gate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 2147483000,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 28,
            }}
          >
            {/* L1 — base gradient */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "radial-gradient(ellipse 90% 55% at 50% -5%, rgba(90,130,220,0.22) 0%, transparent 62%), linear-gradient(160deg, rgba(10,14,22,0.98) 0%, rgba(14,20,32,0.97) 44%, rgba(10,14,26,0.98) 100%)",
              }}
            />
            {/* L2 — frost */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
              }}
            />
            {/* L3 — vignette */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                opacity: 0.6,
                background:
                  "radial-gradient(ellipse 88% 88% at 50% 50%, transparent 38%, rgba(4,4,10,0.72) 100%)",
              }}
            />

            {/* Content */}
            <motion.div
              style={{
                position: "relative",
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                userSelect: "none",
                gap: 24,
                textAlign: "center",
                padding: "0 24px",
              }}
              initial={{ opacity: 0, y: 18, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.52, delay: 0.12, ease: EASE }}
            >
              {/* Badge */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 14px 5px 10px",
                  borderRadius: 100,
                  border: "1px solid rgba(180,190,230,0.18)",
                  background: "rgba(255,255,255,0.05)",
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                }}
              >
                <motion.span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "rgba(150,180,240,0.95)",
                    display: "block",
                    flexShrink: 0,
                  }}
                  animate={{ opacity: [1, 0.3, 1], scale: [1, 0.72, 1] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                />
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.28em",
                    textTransform: "uppercase",
                    color: "rgba(205,210,235,0.62)",
                  }}
                >
                  {requiredLabel} Display Required
                </span>
              </div>

              {/* Rotate icon */}
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div
                  style={{
                    position: "absolute",
                    width: 120,
                    height: 120,
                    borderRadius: "50%",
                    pointerEvents: "none",
                    background: "radial-gradient(circle, rgba(90,130,220,0.22) 0%, transparent 72%)",
                    filter: "blur(16px)",
                  }}
                />
                <motion.div
                  animate={{ rotate: [0, 90, 0] }}
                  transition={{ duration: 3.5, repeat: Infinity, ease: EASE, repeatDelay: 2 }}
                  style={{ color: "rgba(150,180,240,0.92)" }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width={64}
                    height={64}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x={5} y={2} width={14} height={20} rx={2} />
                    <path d="M17.5 2.5 A11 11 0 0 1 21 12" />
                    <polyline points="20,8.5 21,12 17.5,12" />
                  </svg>
                </motion.div>
              </div>

              {/* Heading */}
              <h2
                style={{
                  fontSize: "clamp(1.5rem, 4vw, 2.4rem)",
                  fontWeight: 200,
                  letterSpacing: "-0.025em",
                  color: "rgba(234,236,252,0.94)",
                  lineHeight: 1.1,
                  margin: 0,
                  textShadow: "0 2px 28px rgba(0,0,0,0.4)",
                }}
              >
                This display is set to {requiredLabel}
              </h2>

              {/* Divider */}
              <div
                style={{
                  width: 52,
                  height: 1,
                  background:
                    "linear-gradient(90deg, transparent, rgba(180,190,230,0.28), transparent)",
                }}
              />

              {/* Sub-label */}
              <p
                style={{
                  fontSize: "clamp(0.7rem, 1.4vw, 0.85rem)",
                  fontWeight: 500,
                  letterSpacing: "0.06em",
                  color: "rgba(200,205,232,0.55)",
                  margin: 0,
                  maxWidth: 420,
                  lineHeight: 1.6,
                }}
              >
                Please view it on a {requiredLabel.toLowerCase()} screen
                {required === "portrait"
                  ? " (rotate this device to portrait) to continue."
                  : " (rotate this device to landscape) to continue."}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
