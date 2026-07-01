import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';

// Admin-only (wrapped in ProtectedRoute) screen opened from a display's pairing QR: …/pair/<code>.
// One tap authorizes the polling display, which then unlocks itself.
export function PairApprovePage() {
  const { code } = useParams();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const approve = async () => {
    setBusy(true);
    try {
      await api.pairApprove(code);
      setDone(true);
      toast.success('Display approved — it will unlock shortly');
    } catch (e) {
      toast.error(e.message || 'Failed to approve (code may have expired)');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen gradient-bg flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card/60 p-8 text-center">
        <h1 className="text-xl font-semibold text-foreground mb-2">Authorize display</h1>
        <p className="text-sm text-muted-foreground mb-6 break-all">Pairing code: {code}</p>
        {done ? (
          <p className="text-green-500 font-medium">Approved. The display will unlock automatically.</p>
        ) : (
          <button
            onClick={approve}
            disabled={busy}
            className="w-full gradient-primary text-primary-foreground rounded-lg py-3 font-semibold disabled:opacity-60"
          >
            {busy ? 'Approving…' : 'Approve this display'}
          </button>
        )}
      </div>
    </div>
  );
}
