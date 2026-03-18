import { useEffect, useState, useCallback } from 'react';
import { UserPlus, Trash2, RefreshCw, Shield, Mail, Globe, ShieldCheck, Eye, MapPin, Plus, X, Crosshair, Send, Clock } from 'lucide-react';
import {
  getInvites, createInvite, revokeInvite, changeInviteRole, resendInvite,
  getAllowlist, getMyIp, addAllowlistEntry, deleteAllowlistEntry,
} from '../api';
import type { SsoInvite, AllowlistEntry } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

const ROLE_OPTS = [
  { value: 'admin',     label: 'Admin' },
  { value: 'developer', label: 'Developer' },
  { value: 'viewer',    label: 'Viewer' },
];

const ROLE_COLORS: Record<string, string> = {
  superadmin: 'text-[#f0883e] bg-[#f0883e]/10 border-[#f0883e]/20',
  admin:      'text-[#58a6ff] bg-[#58a6ff]/10 border-[#58a6ff]/20',
  developer:  'text-[#3fb950] bg-[#3fb950]/10 border-[#3fb950]/20',
  viewer:     'text-[#8b949e] bg-[#21262d] border-[#30363d]',
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-px rounded-full text-[10px] font-medium border', ROLE_COLORS[role] ?? ROLE_COLORS.viewer)}>
      {role === 'superadmin' ? <ShieldCheck size={9} /> : role === 'admin' ? <Shield size={9} /> : role === 'developer' ? <Shield size={9} /> : <Eye size={9} />}
      {role}
    </span>
  );
}

export default function Users() {
  const [invites, setInvites] = useState<SsoInvite[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [joinedCount, setJoinedCount] = useState(0);
  const [seatLimit, setSeatLimit] = useState(10);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [myIp, setMyIp] = useState('');
  const [loading, setLoading] = useState(true);

  const [inviteForm, setInviteForm] = useState({ email: '', role: 'admin' });
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  const [ipForm, setIpForm] = useState({ cidr: '', label: '' });
  const [addingIp, setAddingIp] = useState(false);
  const [ipError, setIpError] = useState('');
  const [detectingIp, setDetectingIp] = useState(false);

  const [revoking, setRevoking] = useState<string | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [deletingIp, setDeletingIp] = useState<number | null>(null);
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [inv, al, ip] = await Promise.all([getInvites(), getAllowlist(), getMyIp()]);
      setInvites(inv.invites);
      setActiveCount(inv.activeCount);
      setJoinedCount(inv.joinedCount ?? 0);
      setSeatLimit(inv.seatLimit);
      setAllowlist(al.entries);
      setMyIp(ip.ip);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteForm.email.trim()) { setInviteError('Email is required.'); return; }
    setInviting(true); setInviteError(''); setInviteSuccess('');
    try {
      const r = await createInvite(inviteForm.email.trim(), inviteForm.role);
      setInviteSuccess(r.warning
        ? `Invite created but email failed: ${r.warning}`
        : `Invitation sent to ${inviteForm.email.trim()}`);
      setInviteForm(f => ({ ...f, email: '' }));
      await load();
    } catch (e: any) { setInviteError(e.message); }
    finally { setInviting(false); }
  };

  const handleResend = async (email: string) => {
    setResending(email);
    setInviteError('');
    try {
      await resendInvite(email);
      setInviteSuccess(`Invitation resent to ${email}`);
    } catch (e: any) { setInviteError(e.message || 'Failed to resend invitation'); }
    finally { setResending(null); }
  };

  const handleRevoke = async (email: string) => {
    if (!confirm(`Revoke access for ${email}?`)) return;
    setRevoking(email);
    try { await revokeInvite(email); await load(); }
    catch (e: any) { setInviteError(e.message); }
    finally { setRevoking(null); }
  };

  const handleRoleChange = async (email: string, role: string) => {
    setChangingRole(email);
    try { await changeInviteRole(email, role); await load(); }
    catch (e: any) { setInviteError(e.message); }
    finally { setChangingRole(null); }
  };

  const detectMyIp = async () => {
    setDetectingIp(true);
    try {
      const ip = await getMyIp();
      setMyIp(ip.ip);
      setIpForm(f => ({ cidr: ip.ip, label: f.label || 'My IP' }));
      setIpError('');
    } catch {
      setIpError('Could not detect IP — check your connection.');
    } finally { setDetectingIp(false); }
  };

  const handleAddIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ipForm.cidr.trim()) { setIpError('IP or CIDR is required.'); return; }
    setAddingIp(true); setIpError('');
    try { await addAllowlistEntry(ipForm.cidr.trim(), ipForm.label.trim()); setIpForm({ cidr: '', label: '' }); await load(); }
    catch (e: any) { setIpError(e.message); }
    finally { setAddingIp(false); }
  };

  const handleDeleteIp = async (id: number) => {
    setDeletingIp(id);
    try { await deleteAllowlistEntry(id); await load(); }
    catch { /* ignore */ }
    finally { setDeletingIp(null); }
  };

  const activeInvites = invites.filter(i => i.status === 'active');
  const revokedInvites = invites.filter(i => i.status === 'revoked');
  const seatPct = Math.round((joinedCount / seatLimit) * 100);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Users & Access</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Invite SSO users, manage roles, and control IP access</p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Seat usage bar */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-[#58a6ff]" />
            <span className="text-sm font-semibold text-[#e6edf3]">License Seats</span>
          </div>
          <span className="text-xs text-[#8b949e]">{joinedCount} / {seatLimit} used <span className="text-[#6e7681]">({activeCount - joinedCount} pending)</span></span>
        </div>
        <div className="h-1.5 bg-[#21262d] rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full transition-all', seatPct >= 100 ? 'bg-[#f85149]' : seatPct >= 80 ? 'bg-[#d29922]' : 'bg-[#3fb950]')}
            style={{ width: `${Math.min(seatPct, 100)}%` }}
          />
        </div>
        <p className="mt-1.5 text-[10px] text-[#6e7681]">Seats consumed only when a user first signs in. Pending invites are free.</p>
        {seatPct >= 100 && <p className="mt-0.5 text-[10px] text-[#f85149]">Seat limit reached. Upgrade your license to allow more users.</p>}
      </Card>

      {/* Invite form */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Mail size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Invite SSO User</h2>
        </div>
        <form onSubmit={handleInvite} className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1 flex-1 min-w-[180px]">
            <label className="text-xs text-[#8b949e]">Work Email</label>
            <input
              type="email"
              placeholder="colleague@company.com"
              className="block w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              value={inviteForm.email}
              onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[#8b949e]">Role</label>
            <select
              value={inviteForm.role}
              onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
              className="block bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] outline-none focus:border-[#58a6ff]"
            >
              {ROLE_OPTS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <button
            type="submit"
            disabled={inviting || activeCount >= seatLimit}
            className="flex items-center gap-2 px-4 py-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
          >
            <UserPlus size={12} />
            {inviting ? 'Inviting…' : 'Send Invite'}
          </button>
        </form>
        {inviteError && <p className="mt-2 text-xs text-[#f85149]">{inviteError}</p>}
        {inviteSuccess && <p className="mt-2 text-xs text-[#3fb950]">{inviteSuccess}</p>}
        <p className="mt-3 text-[10px] text-[#6e7681]">
          Invited users sign in via the Microsoft or Google SSO button using this exact email address.
        </p>
      </Card>

      {/* Active invites */}
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <UserPlus size={14} className="text-[#3fb950]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Active Users</h2>
          <span className="ml-auto text-xs text-[#6e7681]">{activeInvites.length} active</span>
        </div>
        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-[#6e7681]">Loading…</p>
        ) : activeInvites.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-[#6e7681]">No active invites. Invite someone above.</p>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {activeInvites.map(inv => (
              <div key={inv.email} className="px-4 py-3 flex items-center gap-3">
                <div className={clsx(
                  'w-7 h-7 rounded-full flex items-center justify-center text-[11px] text-white font-bold shrink-0',
                  inv.joined_at ? 'bg-gradient-to-br from-[#58a6ff] to-[#bc8cff]' : 'bg-[#21262d] text-[#8b949e]',
                )}>
                  {inv.email.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-[#e6edf3] truncate">{inv.email}</div>
                  <div className="text-[10px] text-[#6e7681]">Invited {new Date(inv.created_at).toLocaleDateString()}</div>
                </div>
                {/* Joined vs pending badge */}
                {inv.joined_at ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#3fb950]/15 text-[#3fb950] border border-[#3fb950]/20 shrink-0">Joined</span>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[#d29922]/10 text-[#d29922] border border-[#d29922]/20 shrink-0">
                    <Clock size={9} /> Pending
                  </span>
                )}
                <select
                  value={inv.role}
                  disabled={changingRole === inv.email}
                  onChange={e => handleRoleChange(inv.email, e.target.value)}
                  className="bg-[#21262d] border border-[#30363d] rounded px-2 py-px text-xs text-[#8b949e] outline-none focus:border-[#58a6ff] disabled:opacity-50"
                >
                  {ROLE_OPTS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <RoleBadge role={inv.role} />
                {/* Resend button — only for pending invites */}
                {!inv.joined_at && (
                  <button
                    onClick={() => handleResend(inv.email)}
                    disabled={resending === inv.email}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[#58a6ff]/10 text-[#58a6ff] hover:bg-[#58a6ff]/20 border border-[#58a6ff]/20 transition-colors disabled:opacity-40"
                    title="Resend invitation email"
                  >
                    {resending === inv.email ? <RefreshCw size={9} className="animate-spin" /> : <Send size={9} />}
                    <span className="hidden sm:inline">Resend</span>
                  </button>
                )}
                <button
                  onClick={() => handleRevoke(inv.email)}
                  disabled={revoking === inv.email}
                  className="p-1.5 rounded text-[#6e7681] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors disabled:opacity-40"
                  title="Revoke access"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Revoked invites */}
      {revokedInvites.length > 0 && (
        <Card padding={false}>
          <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
            <Trash2 size={13} className="text-[#6e7681]" />
            <h2 className="text-sm font-semibold text-[#6e7681]">Revoked ({revokedInvites.length})</h2>
          </div>
          <div className="divide-y divide-[#21262d]">
            {revokedInvites.map(inv => (
              <div key={inv.email} className="px-4 py-2.5 flex items-center gap-3 opacity-50">
                <div className="w-6 h-6 rounded-full bg-[#21262d] flex items-center justify-center text-[10px] text-[#6e7681] font-bold shrink-0">
                  {inv.email.charAt(0).toUpperCase()}
                </div>
                <span className="text-xs text-[#6e7681] flex-1 truncate line-through">{inv.email}</span>
                <RoleBadge role={inv.role} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* IP Allowlist */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Globe size={14} className="text-[#bc8cff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">IP Allowlist</h2>
          <span className="ml-1 text-[10px] text-[#6e7681]">(empty = open to all IPs)</span>
        </div>
        <form onSubmit={handleAddIp} className="flex flex-wrap gap-3 items-end mb-4">
          <div className="space-y-1 flex-1 min-w-[160px]">
            <label className="text-xs text-[#8b949e]">IP or CIDR</label>
            <input
              type="text"
              placeholder="1.2.3.4 or 10.0.0.0/8"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              value={ipForm.cidr}
              onChange={e => setIpForm(f => ({ ...f, cidr: e.target.value }))}
            />
            <div className="flex items-center gap-1.5 mt-1">
              <button
                type="button"
                onClick={detectMyIp}
                disabled={detectingIp}
                className="flex items-center gap-1 text-[10px] text-[#58a6ff] hover:text-[#79b8ff] disabled:opacity-50 transition-colors"
              >
                <Crosshair size={10} className={detectingIp ? 'animate-spin' : ''} />
                {detectingIp ? 'Detecting…' : 'Detect my IP'}
              </button>
              {myIp && !detectingIp && (
                <span className="text-[10px] text-[#6e7681]">
                  →{' '}
                  <button
                    type="button"
                    onClick={() => setIpForm(f => ({ cidr: myIp, label: f.label || 'My IP' }))}
                    className="font-mono text-[#8b949e] hover:text-[#e6edf3] transition-colors"
                  >
                    {myIp}
                  </button>
                </span>
              )}
            </div>
          </div>
          <div className="space-y-1 w-32 pb-5">
            <label className="text-xs text-[#8b949e]">Label</label>
            <input
              type="text"
              placeholder="e.g. Office"
              className="block w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              value={ipForm.label}
              onChange={e => setIpForm(f => ({ ...f, label: e.target.value }))}
            />
          </div>
          <div className="pb-5">
            <button
              type="submit"
              disabled={addingIp}
              className="flex items-center gap-2 px-4 py-1.5 bg-[#21262d] hover:bg-[#30363d] disabled:opacity-40 text-[#e6edf3] text-sm rounded-lg transition-colors border border-[#30363d]"
            >
              <Plus size={12} />
              {addingIp ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
        {ipError && <p className="mb-3 text-xs text-[#f85149]">{ipError}</p>}

        {allowlist.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg bg-[#d29922]/10 border border-[#d29922]/20 px-3 py-2.5 text-xs text-[#d29922]">
            <Globe size={12} /> Allowlist is empty — all IPs can access the dashboard. Add VPN/office IPs to enforce access control.
          </div>
        ) : (
          <div className="space-y-2">
            {allowlist.map(entry => (
              <div key={entry.id} className="flex items-center gap-3 bg-[#0d1117] rounded-lg px-3 py-2 border border-[#30363d]">
                <MapPin size={12} className="text-[#bc8cff] shrink-0" />
                <span className="font-mono text-sm text-[#e6edf3] flex-1">{entry.cidr}</span>
                {entry.label && <span className="text-xs text-[#8b949e]">{entry.label}</span>}
                <button
                  onClick={() => handleDeleteIp(entry.id)}
                  disabled={deletingIp === entry.id}
                  className="p-1 rounded text-[#6e7681] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors disabled:opacity-40"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
