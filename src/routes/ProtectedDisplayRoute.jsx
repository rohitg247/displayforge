import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@/services/api';
import { DisplayLoginPage } from '@/pages/DisplayLoginPage';

// Gates the public display URLs (/:branchId/1/:id interactive, /:branchId/2/:id ambient) when the
// backend has DISPLAY_AUTH_ENABLED. It probes the viewer endpoint ONCE: a 401 means the display isn't
// paired -> show the one-time display login (QR pairing + password fallback). Any other outcome (200,
// or a transient network error) renders the viewer as before, so this is a NO-OP when auth is disabled
// and fails OPEN on ambiguous errors (a paired display is never blanked by a backend hiccup) — it only
// fails CLOSED on an explicit 401.
export function ProtectedDisplayRoute({ kind, children }) {
  const { branchId, id } = useParams();
  const [status, setStatus] = useState('checking'); // checking | ok | login

  useEffect(() => {
    let cancelled = false;
    const probe = kind === 'ambient' ? api.getAmbientDisplay(id) : api.getDisplay(id);
    probe
      .then(() => { if (!cancelled) setStatus('ok'); })
      .catch((e) => { if (!cancelled) setStatus(e?.status === 401 ? 'login' : 'ok'); });
    return () => { cancelled = true; };
  }, [kind, id]);

  if (status === 'checking') {
    return <div style={{ width: '100vw', height: '100vh', background: '#000' }} />;
  }
  if (status === 'login') {
    return (
      <DisplayLoginPage
        branchId={branchId}
        displayType={kind === 'ambient' ? 2 : 1}
        displayId={id}
      />
    );
  }
  return children;
}
