import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@/services/api';

// One-time display login shown by ProtectedDisplayRoute when a display URL is gated and unpaired.
// Primary flow: QR pairing — an admin already logged in on their phone scans the QR (…/pair/<code>)
// and approves this display; the display polls and reloads itself once approved (nothing typed on the
// TV remote). Fallback: email + password entered on the display. Full-screen, TV-friendly.
export function DisplayLoginPage({ branchId, displayType, displayId }) {
  const [code, setCode] = useState(null);
  const [mode, setMode] = useState('qr'); // qr | password
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const pollRef = useRef(null);

  const ident = {
    branch_id: Number(branchId),
    display_type: displayType,
    display_id: Number(displayId),
    label: `${displayType === 2 ? 'Ambient' : 'Interactive'} display ${branchId}/${displayId}`,
  };

  // Request a pairing code on mount.
  useEffect(() => {
    let cancelled = false;
    api.pairStart(ident).then((r) => { if (!cancelled) setCode(r.code); }).catch(() => {});
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for approval; refresh the code if it expires.
  useEffect(() => {
    if (!code) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.pairPoll(code);
        if (r.status === 'approved') {
          clearInterval(pollRef.current);
          window.location.reload();
        } else if (r.status === 'expired') {
          clearInterval(pollRef.current);
          const nr = await api.pairStart(ident);
          setCode(nr.code);
        }
      } catch { /* keep polling */ }
    }, 2500);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const submitPassword = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await api.deviceLogin(email, password, ident);
      window.location.reload();
    } catch (e2) {
      setErr(e2.message || 'Login failed');
    }
  };

  const pairUrl = code ? `${window.location.origin}/pair/${code}` : '';

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>Actis Signage</div>
        <div style={S.title}>Authorize this display</div>

        {mode === 'qr' ? (
          <>
            <div style={S.qrBox}>
              {pairUrl ? <QRCodeSVG value={pairUrl} size={220} includeMargin /> : <div style={{ height: 220 }} />}
            </div>
            <div style={S.hint}>
              Scan with a phone that is signed in to the admin panel, then approve. This screen unlocks
              automatically.
            </div>
            <button style={S.linkBtn} onClick={() => setMode('password')}>
              Use email &amp; password instead
            </button>
          </>
        ) : (
          <form onSubmit={submitPassword} style={S.form}>
            <input style={S.input} type="email" placeholder="Email" autoFocus
                   value={email} onChange={(e) => setEmail(e.target.value)} />
            <input style={S.input} type="password" placeholder="Password"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
            {err && <div style={S.err}>{err}</div>}
            <button style={S.primaryBtn} type="submit">Sign in this display</button>
            <button style={S.linkBtn} type="button" onClick={() => setMode('qr')}>
              Back to QR pairing
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: { width: '100vw', height: '100vh', background: '#0b0b0f', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' },
  card: { background: '#16161d', border: '1px solid #2a2a35', borderRadius: 16, padding: '32px 36px',
          width: 'min(90vw, 420px)', textAlign: 'center', color: '#e8e8ee', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' },
  brand: { fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', color: '#8a8aa0', marginBottom: 6 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 20 },
  qrBox: { background: '#fff', borderRadius: 12, padding: 16, display: 'inline-block', marginBottom: 16 },
  hint: { fontSize: 14, color: '#a8a8ba', lineHeight: 1.5, marginBottom: 14 },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  input: { padding: '12px 14px', borderRadius: 10, border: '1px solid #333', background: '#0f0f14',
           color: '#fff', fontSize: 16 },
  primaryBtn: { padding: '12px 14px', borderRadius: 10, border: 'none', background: '#4f46e5',
                color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 'none', color: '#8a8aff', fontSize: 14, cursor: 'pointer', marginTop: 8 },
  err: { color: '#ff7a7a', fontSize: 14 },
};
