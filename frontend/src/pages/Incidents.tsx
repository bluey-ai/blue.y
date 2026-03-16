import { useState, useEffect, useCallback } from 'react';
import { Search, ChevronDown, ChevronRight, RefreshCw, Bot } from 'lucide-react';
import { getIncidents } from '../api';
import type { IncidentRow, IncidentStats } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import { formatDistanceToNow, parseISO } from 'date-fns';
import clsx from 'clsx';

const MONITORS = ['', 'pods', 'nodes', 'certs', 'hpa', 'load', 'security'];
const SEVERITIES = ['', 'critical', 'warning'];

export default function Incidents() {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [stats, setStats] = useState<IncidentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const [severity, setSeverity] = useState('');
  const [monitor, setMonitor] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getIncidents({ limit: 100, severity: severity || undefined, monitor: monitor || undefined, search: debouncedSearch || undefined });
      setIncidents(r.incidents);
      setStats(r.stats);
    } finally { setLoading(false); }
  }, [severity, monitor, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Incidents</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">AI-diagnosed alerts from cluster monitors</p>
        </div>
        <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Total', value: stats.total, color: 'text-[#e6edf3]' },
            { label: 'Critical', value: stats.critical, color: 'text-[#f85149]' },
            { label: 'Warning', value: stats.warning, color: 'text-[#d29922]' },
          ].map(s => (
            <Card key={s.label} className="text-center py-3">
              <div className={clsx('text-2xl font-bold', s.color)}>{s.value}</div>
              <div className="text-xs text-[#8b949e] mt-0.5">{s.label}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <Card className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-48 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5">
          <Search size={12} className="text-[#6e7681] shrink-0" />
          <input
            type="text"
            placeholder="Search title, message, diagnosis…"
            className="bg-transparent text-sm text-[#e6edf3] placeholder-[#6e7681] outline-none w-full"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Select label="Severity" value={severity} options={SEVERITIES} onChange={setSeverity} />
        <Select label="Monitor" value={monitor} options={MONITORS} onChange={setMonitor} />
      </Card>

      {/* Table */}
      <Card padding={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#30363d]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e] w-4" />
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">Severity</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">Time</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">Namespace</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">Monitor</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[#8b949e]">AI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262d]">
              {loading && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#6e7681] text-sm">Loading…</td></tr>
              )}
              {!loading && incidents.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#6e7681] text-sm">No incidents found.</td></tr>
              )}
              {incidents.map(inc => (
                <>
                  <tr
                    key={inc.id}
                    className="hover:bg-[#161b22] cursor-pointer transition-colors"
                    onClick={() => setExpanded(expanded === inc.id ? null : inc.id)}
                  >
                    <td className="px-4 py-3 text-[#6e7681]">
                      {expanded === inc.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </td>
                    <td className="px-4 py-3">
                      <Badge label={inc.severity} variant={inc.severity === 'critical' ? 'critical' : 'warning'} />
                    </td>
                    <td className="px-4 py-3 text-xs text-[#8b949e] font-mono whitespace-nowrap">
                      {formatDistanceToNow(parseISO(inc.ts), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-[#58a6ff]">{inc.namespace || '—'}</td>
                    <td className="px-4 py-3">
                      <Badge label={inc.monitor || '—'} variant="info" size="xs" />
                    </td>
                    <td className="px-4 py-3 text-sm text-[#e6edf3] max-w-xs truncate">{inc.title}</td>
                    <td className="px-4 py-3">
                      {inc.ai_diagnosis && <span title="AI diagnosis available"><Bot size={12} className="text-[#bc8cff]" /></span>}
                    </td>
                  </tr>
                  {expanded === inc.id && (
                    <tr key={`${inc.id}-detail`} className="bg-[#0d1117]">
                      <td colSpan={7} className="px-6 py-4 space-y-3">
                        <div>
                          <div className="text-xs text-[#8b949e] mb-1">Message</div>
                          <pre className="text-xs text-[#e6edf3] whitespace-pre-wrap font-mono bg-[#161b22] rounded-lg p-3 border border-[#30363d] overflow-auto max-h-40">{inc.message}</pre>
                        </div>
                        {inc.ai_diagnosis && (
                          <div>
                            <div className="flex items-center gap-1.5 text-xs text-[#bc8cff] mb-1">
                              <Bot size={11} /> AI Diagnosis
                            </div>
                            <pre className="text-xs text-[#e6edf3] whitespace-pre-wrap font-mono bg-[#161b22] rounded-lg p-3 border border-[#bc8cff]/20 overflow-auto max-h-48">{inc.ai_diagnosis}</pre>
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-xs text-[#6e7681]">
                          <span>ID: #{inc.id}</span>
                          <span>Pod: {inc.pod || '—'}</span>
                          <span>{parseISO(inc.ts).toLocaleString()}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] outline-none focus:border-[#58a6ff] cursor-pointer"
    >
      <option value="">{label}: All</option>
      {options.filter(Boolean).map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
    </select>
  );
}
