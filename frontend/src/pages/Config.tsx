import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, RefreshCw, Settings, Info } from 'lucide-react';
import { getConfig, saveConfig } from '../api';
import Card from '../components/Card';
import clsx from 'clsx';

type KV = { key: string; value: string };

export default function Config() {
  const [rows, setRows] = useState<KV[]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    setLoading(true); setDirty(false); setMsg(null);
    try {
      const r = await getConfig();
      setNote(r.note);
      setRows(Object.entries(r.configMap).map(([key, value]) => ({ key, value })));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const update = (i: number, field: 'key' | 'value', val: string) => {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
    setDirty(true);
  };
  const addRow = () => { setRows(prev => [...prev, { key: '', value: '' }]); setDirty(true); };
  const removeRow = (i: number) => { setRows(prev => prev.filter((_, idx) => idx !== i)); setDirty(true); };

  const handleSave = async () => {
    const data: Record<string, string> = {};
    for (const { key, value } of rows) {
      if (!key.trim()) continue;
      data[key.trim()] = value;
    }
    setSaving(true); setMsg(null);
    try {
      const r = await saveConfig(data);
      setMsg({ type: 'ok', text: `Saved ${r.keys} key${r.keys !== 1 ? 's' : ''} to ConfigMap.` });
      setDirty(false);
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message });
    } finally { setSaving(false); }
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Configuration</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Edit the <code className="font-mono text-xs">blue-y-config</code> ConfigMap</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors" title="Reload">
            <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-2 px-4 py-1.5 bg-[#238636] hover:bg-[#2ea043] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
          >
            <Save size={12} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {note && (
        <div className="flex items-start gap-2 rounded-lg border border-[#30363d] px-4 py-3 text-xs text-[#8b949e]">
          <Info size={12} className="text-[#58a6ff] mt-0.5 shrink-0" />
          {note}
        </div>
      )}

      {msg && (
        <div className={clsx('rounded-lg border px-4 py-2 text-sm',
          msg.type === 'ok' ? 'border-[#3fb950]/30 bg-[#3fb950]/10 text-[#3fb950]' : 'border-[#f85149]/30 bg-[#f85149]/10 text-[#f85149]')}>
          {msg.text}
        </div>
      )}

      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <Settings size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">ConfigMap Keys</h2>
          <span className="ml-auto text-xs text-[#6e7681]">{rows.length} keys</span>
        </div>

        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-[#6e7681]">Loading…</p>
        ) : (
          <div className="divide-y divide-[#21262d]">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#0d1117]">
                <input
                  type="text"
                  placeholder="KEY"
                  value={row.key}
                  onChange={e => update(i, 'key', e.target.value)}
                  className="font-mono text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#58a6ff] outline-none focus:border-[#58a6ff] w-52"
                />
                <span className="text-[#30363d] text-sm">=</span>
                <input
                  type="text"
                  placeholder="value"
                  value={row.value}
                  onChange={e => update(i, 'value', e.target.value)}
                  className="font-mono text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-[#e6edf3] outline-none focus:border-[#58a6ff] flex-1 min-w-0"
                />
                <button
                  onClick={() => removeRow(i)}
                  className="p-1 rounded text-[#6e7681] hover:text-[#f85149] hover:bg-[#f85149]/10 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="px-4 py-2.5">
              <button
                onClick={addRow}
                className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#58a6ff] transition-colors"
              >
                <Plus size={12} /> Add key
              </button>
            </div>
          </div>
        )}
      </Card>

      <div className="rounded-lg border border-[#d29922]/20 bg-[#d29922]/5 px-4 py-3 text-xs text-[#d29922]">
        ⚠ Changes are applied to the live ConfigMap immediately. The bot hot-reloads config every 30s — no restart needed for most settings.
      </div>
    </div>
  );
}
