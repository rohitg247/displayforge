import { useEffect, useState } from 'react';
import { api } from '@/services/api';
import { toast } from '@/components/ui/sonner';

// Admin view of authorized display devices (Part D). List + revoke; revocation is enforced
// server-side on the next viewer request (get_display_viewer looks the jti up in display_devices).
export function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.listDevices()
      .then((r) => setDevices(r.devices || []))
      .catch((e) => toast.error(e.message || 'Failed to load devices'))
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const revoke = async (id) => {
    try {
      await api.revokeDevice(id);
      toast.success('Device revoked');
      load();
    } catch (e) {
      toast.error(e.message || 'Failed to revoke');
    }
  };

  const typeLabel = (t) => (t === 2 ? 'Ambient' : t === 1 ? 'Interactive' : '—');

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Display Devices</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Displays that have completed one-time login. Gating is active only when the backend has
        <code className="mx-1 px-1 rounded bg-secondary">DISPLAY_AUTH_ENABLED</code>. Revoke forces a display to re-pair.
      </p>

      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-muted-foreground">No paired devices yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2">Label</th>
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Branch / Display</th>
                <th className="text-left px-4 py-2">Created</th>
                <th className="text-left px-4 py-2">Last seen</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-right px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="px-4 py-2 text-foreground">{d.label || `Device ${d.id}`}</td>
                  <td className="px-4 py-2">{typeLabel(d.display_type)}</td>
                  <td className="px-4 py-2">{d.branch_id ?? '—'} / {d.display_id ?? '—'}</td>
                  <td className="px-4 py-2">{d.created_at || '—'}</td>
                  <td className="px-4 py-2">{d.last_seen_at || 'never'}</td>
                  <td className="px-4 py-2">
                    {d.revoked ? <span className="text-red-500">revoked</span>
                               : <span className="text-green-500">active</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!d.revoked && (
                      <button
                        onClick={() => revoke(d.id)}
                        className="px-3 py-1 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
