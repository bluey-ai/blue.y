import { useEffect, useState, useRef } from 'react';
import { AlertTriangle, CheckCircle, Server, Activity, Zap, TrendingUp, Clock } from 'lucide-react';
import { createStream, getIncidentStats, getNodes } from '../api';
import type { StreamEvent, IncidentStats, NodeInfo } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: number | string; sub?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <Card className="flex items-start gap-4">
      <div className={clsx('p-2.5 rounded-lg', color)}>
        <Icon size={18} />
      </div>
      <div>
        <div className="text-2xl font-bold text-[#e6edf3]">{value}</div>
        <div className="text-xs text-[#8b949e] mt-0.5">{label}</div>
        {sub && <div className="text-[10px] text-[#6e7681] mt-1">{sub}</div>}
      </div>
    </Card>
  );
}

export default function Overview() {
  const [stream, setStream] = useState<StreamEvent | null>(null);
  const [stats, setStats] = useState<IncidentStats | null>(null);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    getIncidentStats().then(setStats).catch(() => {});
    getNodes().then(r => setNodes(r.nodes)).catch(() => {});

    esRef.current = createStream((e) => {
      setStream(e);
      setNodes(e.nodes);
      setLastUpdate(new Date());
    });

    return () => { esRef.current?.close(); };
  }, []);

  const allPods = stream?.namespaces.flatMap(n => n.pods) ?? [];
  const running = allPods.filter(p => p.status === 'Running').length;
  const unhealthy = allPods.filter(p => p.status !== 'Running' && p.status !== 'Succeeded').length;
  const readyNodes = nodes.filter(n => n.status === 'Ready').length;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Overview</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Real-time cluster health & incident summary</p>
        </div>
        {lastUpdate && (
          <div className="flex items-center gap-1.5 text-xs text-[#3fb950]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950] animate-pulse-slow" />
            Updated {formatDistanceToNow(lastUpdate, { addSuffix: true })}
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Running Pods" value={running} icon={CheckCircle} color="bg-[#3fb950]/10 text-[#3fb950]" />
        <StatCard label="Unhealthy Pods" value={unhealthy} icon={AlertTriangle} color={unhealthy > 0 ? 'bg-[#f85149]/10 text-[#f85149]' : 'bg-[#21262d] text-[#8b949e]'} />
        <StatCard label="Nodes Ready" value={`${readyNodes}/${nodes.length}`} icon={Server} color="bg-[#58a6ff]/10 text-[#58a6ff]" />
        <StatCard label="Total Incidents" value={stats?.total ?? '—'} sub={stats ? `${stats.critical} critical · ${stats.warning} warning` : undefined} icon={Activity} color="bg-[#bc8cff]/10 text-[#bc8cff]" />
      </div>

      {/* Namespace health grid */}
      {stream && (
        <Card padding={false}>
          <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
            <Zap size={14} className="text-[#58a6ff]" />
            <h2 className="text-sm font-semibold text-[#e6edf3]">Namespace Health</h2>
            <span className="ml-auto text-xs text-[#6e7681]">{stream.namespaces.length} namespaces</span>
          </div>
          <div className="divide-y divide-[#21262d]">
            {stream.namespaces.map(ns => {
              const total = ns.pods.length;
              const pct = total > 0 ? Math.round((ns.healthy / total) * 100) : 100;
              const isHealthy = ns.unhealthy === 0;
              return (
                <div key={ns.namespace} className="px-4 py-3 flex items-center gap-4">
                  <div className="flex items-center gap-2 w-36 shrink-0">
                    <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', isHealthy ? 'bg-[#3fb950]' : 'bg-[#f85149]')} />
                    <span className="text-sm font-mono text-[#e6edf3] truncate">{ns.namespace}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-[#21262d] overflow-hidden">
                        <div
                          className={clsx('h-full rounded-full transition-all', isHealthy ? 'bg-[#3fb950]' : 'bg-[#d29922]')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-[#8b949e] w-20 shrink-0 text-right">
                        {ns.healthy}/{total} healthy
                      </span>
                    </div>
                  </div>
                  {ns.unhealthy > 0 && (
                    <Badge label={`${ns.unhealthy} issue${ns.unhealthy > 1 ? 's' : ''}`} variant="warning" size="xs" />
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Nodes */}
      {nodes.length > 0 && (
        <Card padding={false}>
          <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
            <Server size={14} className="text-[#58a6ff]" />
            <h2 className="text-sm font-semibold text-[#e6edf3]">Nodes</h2>
          </div>
          <div className="divide-y divide-[#21262d]">
            {nodes.map(node => (
              <div key={node.name} className="px-4 py-3 flex items-center gap-4">
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', node.status === 'Ready' ? 'bg-[#3fb950]' : 'bg-[#f85149]')} />
                <span className="text-sm font-mono text-[#e6edf3] flex-1 truncate">{node.name}</span>
                <div className="flex items-center gap-2 text-xs text-[#8b949e]">
                  {node.roles.map(r => <Badge key={r} label={r} variant="muted" size="xs" />)}
                </div>
                <div className="text-xs text-[#6e7681] font-mono">{node.allocatable.cpu} / {node.allocatable.memory}</div>
                <Badge
                  label={node.status}
                  variant={node.status === 'Ready' ? 'success' : 'critical'}
                  size="xs"
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Incident severity chart */}
      {stats && stats.total > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={14} className="text-[#58a6ff]" />
            <h2 className="text-sm font-semibold text-[#e6edf3]">Incident Breakdown</h2>
          </div>
          <div className="flex items-center gap-6">
            <IncidentDonut stats={stats} />
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[#f85149]" />
                <span className="text-sm text-[#e6edf3]">Critical</span>
                <span className="ml-auto text-sm font-mono text-[#f85149]">{stats.critical}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[#d29922]" />
                <span className="text-sm text-[#e6edf3]">Warning</span>
                <span className="ml-auto text-sm font-mono text-[#d29922]">{stats.warning}</span>
              </div>
              <div className="border-t border-[#30363d] pt-2 flex items-center gap-3">
                <Clock size={10} className="text-[#6e7681]" />
                <span className="text-xs text-[#8b949e]">Total: {stats.total}</span>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function IncidentDonut({ stats }: { stats: IncidentStats }) {
  const r = 30, cx = 40, cy = 40, stroke = 8;
  const circumference = 2 * Math.PI * r;
  const critPct = stats.total > 0 ? stats.critical / stats.total : 0;
  const warnPct = stats.total > 0 ? stats.warning / stats.total : 0;
  const critDash = critPct * circumference;
  const warnDash = warnPct * circumference;

  return (
    <svg width="80" height="80" className="shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#21262d" strokeWidth={stroke} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d29922" strokeWidth={stroke}
        strokeDasharray={`${warnDash} ${circumference - warnDash}`}
        strokeDashoffset={-critDash}
        transform={`rotate(-90 ${cx} ${cy})`} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f85149" strokeWidth={stroke}
        strokeDasharray={`${critDash} ${circumference - critDash}`}
        strokeDashoffset="0"
        transform={`rotate(-90 ${cx} ${cy})`} />
      <text x={cx} y={cy+4} textAnchor="middle" fill="#e6edf3" fontSize="13" fontWeight="bold">{stats.total}</text>
    </svg>
  );
}
