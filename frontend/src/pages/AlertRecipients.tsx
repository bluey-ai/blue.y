// BLY-73 — Alert Recipient Directory
// Universal contact list: Internal (staff/engineers) and Client (external) recipients.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Edit2, Save, X, Users, UserCheck, Mail, Tag } from 'lucide-react';
import { getRecipients, addRecipient, updateRecipient, deleteRecipient } from '../api';
import type { AlertRecipient } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

type TypeFilter = 'all' | 'internal' | 'client';

const TYPE_STYLE: Record<string, string> = {
  internal: 'bg-[#1f6feb]/15 text-[#58a6ff] border-[#1f6feb]/30',
  client:   'bg-[#3fb950]/15 text-[#3fb950] border-[#3fb950]/30',
};
const TYPE_LABEL: Record<string, string> = { internal: 'Internal', client: 'Client' };

const EMPTY_FORM = { name: '', email: '', type: 'internal' as 'internal' | 'client', tags: '' };

export default function AlertRecipients() {
  const [recipients, setRecipients] = useState<AlertRecipient[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState<TypeFilter>('all');
  const [showAdd, setShowAdd]       = useState(false);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');
  const [editId, setEditId]         = useState<string | null>(null);
  const [editForm, setEditForm]     = useState<{ name: string; type: 'internal' | 'client'; tags: string }>({ name: '', type: 'internal', tags: '' });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getRecipients();
      setRecipients(r.recipients);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filter === 'all' ? recipients : recipients.filter(r => r.type === filter);
  const internalCount = recipients.filter(r => r.type === 'internal').length;
  const clientCount   = recipients.filter(r => r.type === 'client').length;

  const handleAdd = async () => {
    if (!form.name.trim() || !form.email.trim()) { setErr('Name and email are required.'); return; }
    if (!form.email.includes('@')) { setErr('Enter a valid email address.'); return; }
    setSaving(true); setErr('');
    try {
      await addRecipient(form);
      setShowAdd(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (e: any) {
      setErr(e.message ?? 'Failed to add recipient');
    } finally { setSaving(false); }
  };

  const startEdit = (r: AlertRecipient) => {
    setEditId(r.id);
    setEditForm({ name: r.name, type: r.type, tags: r.tags });
  };

  const saveEdit = async (id: string) => {
    setSaving(true);
    try {
      await updateRecipient(id, editForm);
      setEditId(null);
      await load();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteRecipient(id);
      await load();
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Alert Recipients</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">
            Universal contact directory for service alert emails — Internal staff and Client contacts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
            <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
          </button>
          <button
            onClick={() => { setShowAdd(true); setErr(''); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white transition-colors"
          >
            <Plus size={12} /> Add Recipient
          </button>
        </div>
      </div>

      {/* Stats + filter */}
      <div className="flex items-center gap-3 flex-wrap">
        {(['all', 'internal', 'client'] as TypeFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              filter === f
                ? f === 'internal' ? 'bg-[#1f6feb]/20 text-[#58a6ff] border-[#1f6feb]/40'
                  : f === 'client' ? 'bg-[#3fb950]/20 text-[#3fb950] border-[#3fb950]/40'
                  : 'bg-[#21262d] text-[#e6edf3] border-[#484f58]'
                : 'bg-transparent text-[#8b949e] border-[#30363d] hover:border-[#484f58] hover:text-[#e6edf3]',
            )}
          >
            {f === 'all'      && <><Users size={11} /> All ({recipients.length})</>}
            {f === 'internal' && <><UserCheck size={11} /> Internal ({internalCount})</>}
            {f === 'client'   && <><Mail size={11} /> Client ({clientCount})</>}
          </button>
        ))}
      </div>

      {/* Add form */}
      {showAdd && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Plus size={13} className="text-[#3fb950]" />
            <span className="text-sm font-semibold text-[#e6edf3]">New Recipient</span>
            <button onClick={() => setShowAdd(false)} className="ml-auto p-1 rounded text-[#8b949e] hover:text-[#f85149] transition-colors">
              <X size={13} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-[#6e7681] mb-1">Name *</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Zeeshan Ali"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-[#6e7681] mb-1">Email *</label>
              <input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="e.g. zeeshan@blueonion.today"
                type="email"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-[#6e7681] mb-1">Type *</label>
              <div className="flex gap-2">
                {(['internal', 'client'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setForm(f => ({ ...f, type: t }))}
                    className={clsx(
                      'flex-1 py-1.5 rounded text-xs font-medium border transition-colors',
                      form.type === t ? TYPE_STYLE[t] : 'bg-[#0d1117] border-[#30363d] text-[#8b949e] hover:border-[#484f58]',
                    )}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-[#6e7681] mb-1">Tags (optional)</label>
              <input
                value={form.tags}
                onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                placeholder="e.g. on-call, engineering"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
              />
            </div>
          </div>
          {err && <p className="mt-2 text-[11px] text-[#f85149]">{err}</p>}
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] rounded transition-colors">Cancel</button>
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white disabled:opacity-50 transition-colors"
            >
              {saving ? 'Adding…' : 'Add Recipient'}
            </button>
          </div>
        </Card>
      )}

      {/* Recipient list */}
      {loading ? (
        <p className="text-center text-sm text-[#6e7681] py-10">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-[#6e7681]">
          <Users size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{filter === 'all' ? 'No recipients yet — add one above.' : `No ${filter} recipients.`}</p>
        </div>
      ) : (
        <Card>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#21262d]">
                <th className="text-left pb-2.5 text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider">Name</th>
                <th className="text-left pb-2.5 text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider">Email</th>
                <th className="text-left pb-2.5 text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider">Type</th>
                <th className="text-left pb-2.5 text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider hidden sm:table-cell">Tags</th>
                <th className="pb-2.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                const isEditing = editId === r.id;
                return (
                  <tr key={r.id} className="border-b border-[#21262d] last:border-0">
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <input
                          value={editForm.name}
                          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#e6edf3] outline-none focus:border-[#58a6ff]"
                        />
                      ) : (
                        <span className="font-medium text-[#e6edf3]">{r.name}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-[#8b949e]">{r.email}</td>
                    <td className="py-2.5 pr-3">
                      {isEditing ? (
                        <div className="flex gap-1">
                          {(['internal', 'client'] as const).map(t => (
                            <button
                              key={t}
                              onClick={() => setEditForm(f => ({ ...f, type: t }))}
                              className={clsx(
                                'px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors',
                                editForm.type === t ? TYPE_STYLE[t] : 'bg-[#0d1117] border-[#30363d] text-[#6e7681]',
                              )}
                            >{TYPE_LABEL[t]}</button>
                          ))}
                        </div>
                      ) : (
                        <span className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border', TYPE_STYLE[r.type])}>
                          {TYPE_LABEL[r.type]}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 hidden sm:table-cell">
                      {isEditing ? (
                        <input
                          value={editForm.tags}
                          onChange={e => setEditForm(f => ({ ...f, tags: e.target.value }))}
                          placeholder="tag1, tag2"
                          className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-xs text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
                        />
                      ) : r.tags ? (
                        <span className="flex items-center gap-1 text-[#6e7681]">
                          <Tag size={9} />
                          {r.tags}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isEditing ? (
                          <>
                            <button onClick={() => setEditId(null)} className="p-1 rounded text-[#8b949e] hover:text-[#f85149] transition-colors"><X size={12} /></button>
                            <button onClick={() => saveEdit(r.id)} disabled={saving} className="p-1 rounded text-[#3fb950] hover:bg-[#3fb950]/10 transition-colors"><Save size={12} /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(r)} className="p-1 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors"><Edit2 size={11} /></button>
                            <button
                              onClick={() => handleDelete(r.id)}
                              disabled={deletingId === r.id}
                              className="p-1 rounded text-[#8b949e] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors disabled:opacity-40"
                            >
                              <Trash2 size={11} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e]">
        ℹ Recipients are stored in the <code className="font-mono bg-[#0d1117] px-1 rounded">blue-y-config</code> ConfigMap.
        <strong className="text-[#e6edf3]"> Internal</strong> = staff/engineers &middot;
        <strong className="text-[#3fb950]"> Client</strong> = external contacts (PwC, ICBC, etc.).
        When sending alert emails, select by type to reach the right audience.
      </div>
    </div>
  );
}
