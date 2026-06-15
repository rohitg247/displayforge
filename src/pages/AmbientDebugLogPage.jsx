import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';

const REFRESH_MS = 10000;

// Reads the on-panel debug transcript at the SAME origin + URL pattern as the viewer
// (/:branchId/2/:id/debug-log/latest), so logs are readable in any browser without photographing the
// TV. The data is fetched from the backend via api.getAmbientDebugLog (env-driven API_BASE); only the
// user-facing URL lives on the frontend route. Auto-refreshes so it stays live while a panel runs.
export function AmbientDebugLogPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const date = searchParams.get('date');
  const [text, setText] = useState('Loading…');

  const load = useCallback(() => {
    api
      .getAmbientDebugLog(Number(id), date)
      .then(setText)
      .catch((e) => setText(`Error loading debug log for display ${id}: ${e?.message ?? e}`));
  }, [id, date]);

  useEffect(() => {
    load();
    const handle = setInterval(load, REFRESH_MS);
    return () => clearInterval(handle);
  }, [load]);

  return (
    <pre
      style={{
        margin: 0,
        minHeight: '100vh',
        padding: 16,
        background: '#0b0b0b',
        color: '#cfe',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}
