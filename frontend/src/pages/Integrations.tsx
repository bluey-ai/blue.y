import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Edit2, Save, X } from 'lucide-react';
import { getIntegrations, saveIntegration } from '../api';
import type { Integration } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

const PLATFORM_COLOR: Record<string, string> = {
  telegram:  'text-[#0088cc] bg-[#0088cc]/10 border-[#0088cc]/20',
  slack:     'text-[#4a154b] bg-[#4a154b]/10 border-[#4a154b]/20',
  microsoft: 'text-[#6264a7] bg-[#6264a7]/10 border-[#6264a7]/20',
  whatsapp:  'text-[#25d366] bg-[#25d366]/10 border-[#25d366]/20',
};

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'TG', slack: 'SL', microsoft: 'MS', whatsapp: 'WA',
};

export default function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [readOnly, setReadOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ id: string; type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getIntegrations();
      setIntegrations(r.integrations);
      setReadOnly(r.readOnly);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startEdit = (intg: Integration) => {
    const vals: Record<string, string> = {};
    intg.fields.forEach(f => { vals[f.key] = f.value; });
    setEditValues(vals);
    setEditing(intg.id);
    setMsg(null);
  };

  const cancelEdit = () => { setEditing(null); setEditValues({}); };

  const handleSave = async (id: string) => {
    setSaving(true); setMsg(null);
    try {
      await saveIntegration(id, editValues);
      setMsg({ id, type: 'ok', text: 'Saved successfully.' });
      setEditing(null);
      await load();
    } catch (e: any) {
      setMsg({ id, type: 'err', text: e.message });
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Integrations</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">
            {readOnly ? 'View integration status — contact SuperAdmin to edit credentials' : 'Configure messaging platform integrations'}
          </p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {loading ? (
        <p className="text-center text-sm text-[#6e7681] py-10">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {integrations.map(intg => {
            const isEditing = editing === intg.id;
            const colorClass = PLATFORM_COLOR[intg.icon] ?? 'text-[#8b949e] bg-[#21262d] border-[#30363d]';
            return (
              <Card key={intg.id}>
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={clsx('w-9 h-9 rounded-lg border flex items-center justify-center text-sm font-bold', colorClass)}>
                      {PLATFORM_LABEL[intg.icon] ?? intg.label.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-[#e6edf3]">{intg.label}</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        {intg.enabled
                          ? <><CheckCircle size={10} className="text-[#3fb950]" /><span className="text-[10px] text-[#3fb950]">Connected</span></>
                          : <><XCircle size={10} className="text-[#6e7681]" /><span className="text-[10px] text-[#6e7681]">Not configured</span></>
                        }
                      </div>
                    </div>
                  </div>
                  {!readOnly && !isEditing && (
                    <button
                      onClick={() => startEdit(intg)}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-[#21262d] border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:border-[#58a6ff] transition-colors"
                    >
                      <Edit2 size={10} /> Edit
                    </button>
                  )}
                  {isEditing && (
                    <div className="flex gap-2">
                      <button
                        onClick={cancelEdit}
                        className="p-1.5 rounded text-[#8b949e] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors"
                      >
                        <X size={13} />
                      </button>
                      <button
                        onClick={() => handleSave(intg.id)}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-[#238636] hover:bg-[#2ea043] text-white transition-colors disabled:opacity-50"
                      >
                        <Save size={10} /> {saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-2.5">
                  {intg.fields.map(f => (
                    <div key={f.key}>
                      <label className="block text-[10px] text-[#6e7681] mb-0.5">{f.label}</label>
                      {isEditing ? (
                        <input
                          type={f.type === 'password' ? 'password' : 'text'}
                          value={editValues[f.key] ?? ''}
                          onChange={e => setEditValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder={f.hasValue ? '(unchanged)' : `Enter ${f.label.toLowerCase()}`}
                          className="w-full bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 text-xs font-mono text-[#e6edf3] placeholder-[#6e7681] outline-none focus:border-[#58a6ff]"
                        />
                      ) : (
                        <div className="text-xs font-mono text-[#8b949e] bg-[#0d1117] border border-[#30363d] rounded px-2.5 py-1.5 truncate">
                          {f.value || <span className="text-[#6e7681] italic">not set</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {msg?.id === intg.id && (
                  <p className={clsx('mt-3 text-xs', msg.type === 'ok' ? 'text-[#3fb950]' : 'text-[#f85149]')}>
                    {msg.text}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-[#30363d] bg-[#161b22] px-4 py-3 text-xs text-[#8b949e]">
        ℹ Changes are written to the <code className="font-mono bg-[#0d1117] px-1 rounded">blue-y-config</code> ConfigMap and applied on the next bot hot-reload cycle (~30s).
      </div>
    </div>
  );
}
