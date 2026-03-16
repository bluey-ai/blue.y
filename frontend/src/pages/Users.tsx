import { useEffect, useState } from 'react';
import { UserPlus, Trash2, RefreshCw, Shield } from 'lucide-react';
import { getUsers, addUser, deleteUser } from '../api';
import type { AdminUser } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import clsx from 'clsx';

const PLATFORMS = ['telegram', 'slack', 'teams', 'whatsapp'];
const PLATFORM_ICONS: Record<string, string> = {
  telegram: '✈️', slack: '💬', teams: '🟦', whatsapp: '📱',
};

export default function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ platform: 'telegram', userId: '', displayName: '' });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { const r = await getUsers(); setUsers(r.users); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.userId.trim() || !form.displayName.trim()) { setError('All fields required.'); return; }
    setAdding(true); setError(''); setSuccess('');
    try {
      await addUser(form);
      setSuccess(`Added ${form.displayName} (${form.platform}).`);
      setForm(f => ({ ...f, userId: '', displayName: '' }));
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setAdding(false); }
  };

  const handleDelete = async (platform: string, userId: string, name: string) => {
    if (!confirm(`Remove ${name} (${platform})?`)) return;
    const key = `${platform}:${userId}`;
    setDeleting(key);
    try { await deleteUser(platform, userId); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(null); }
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Admin Users</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Manage who can access this dashboard via magic link</p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Add user form */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <UserPlus size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Add Admin User</h2>
        </div>
        <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-xs text-[#8b949e]">Platform</label>
            <select
              value={form.platform}
              onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
              className="block bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] outline-none focus:border-[#58a6ff]"
            >
              {PLATFORMS.map(p => <option key={p} value={p}>{PLATFORM_ICONS[p]} {p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[#8b949e]">User ID</label>
            <input
              type="text"
              placeholder="e.g. 8735878307"
              className="block bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff] w-40"
              value={form.userId}
              onChange={e => setForm(f => ({ ...f, userId: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[#8b949e]">Display Name</label>
            <input
              type="text"
              placeholder="e.g. Zeeshan Ali"
              className="block bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff] w-40"
              value={form.displayName}
              onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
            />
          </div>
          <button
            type="submit"
            disabled={adding}
            className="flex items-center gap-2 px-4 py-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            <UserPlus size={12} />
            {adding ? 'Adding…' : 'Add User'}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-[#f85149]">{error}</p>}
        {success && <p className="mt-2 text-xs text-[#3fb950]">{success}</p>}
      </Card>

      {/* User list */}
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <Shield size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Whitelisted Users</h2>
          <span className="ml-auto text-xs text-[#6e7681]">{users.length} users</span>
        </div>
        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-[#6e7681]">Loading…</p>
        ) : users.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[#6e7681]">No users yet. Add one above.</p>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {users.map(u => {
              const key = `${u.platform}:${u.userId}`;
              return (
                <div key={key} className="px-4 py-3 flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#58a6ff] to-[#bc8cff] flex items-center justify-center text-xs text-white font-bold shrink-0">
                    {u.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[#e6edf3]">{u.displayName}</div>
                    <div className="text-xs font-mono text-[#6e7681]">{u.userId}</div>
                  </div>
                  <Badge label={`${PLATFORM_ICONS[u.platform] ?? ''} ${u.platform}`} variant="info" />
                  <button
                    onClick={() => handleDelete(u.platform, u.userId, u.displayName)}
                    disabled={deleting === key}
                    className="p-1.5 rounded text-[#6e7681] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors disabled:opacity-40"
                    title="Remove user"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e] space-y-1">
        <div className="flex items-center gap-1.5 text-[#58a6ff] font-medium mb-1.5"><Shield size={11} /> How admin access works</div>
        <div>1. Add a user's platform ID to this whitelist.</div>
        <div>2. They send <code className="font-mono bg-[#0d1117] px-1 rounded">/admin</code> in the chat bot.</div>
        <div>3. Bot sends a magic link (4h, single-use) — clicking it sets a secure session cookie.</div>
        <div>4. Session lasts 8 hours, then they need a new link.</div>
      </div>
    </div>
  );
}
