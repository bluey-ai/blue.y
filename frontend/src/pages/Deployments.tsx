import { useEffect, useState, useCallback } from 'react';
import { Layers, RefreshCw, RotateCcw, ChevronUp, ChevronDown, Minus, Plus } from 'lucide-react';
import { getDeployments, restartDeployment, scaleDeployment } from '../api';
import type { DeploymentInfo } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import clsx from 'clsx';

const NAMESPACES = ['prod', 'dev', 'monitoring', 'doris', 'wordpress'];

export default function Deployments() {
  const [ns, setNs] = useState('prod');
  const [deployments, setDeployments] = useState<DeploymentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});
  const [scaleTargets, setScaleTargets] = useState<Record<string, number>>({});

  const load = useCallback(async (namespace: string) => {
    setLoading(true);
    try {
      const r = await getDeployments(namespace);
      setDeployments(r.deployments);
      const targets: Record<string, number> = {};
      r.deployments.forEach(d => { targets[d.name] = d.replicas; });
      setScaleTargets(targets);
    } catch (e: any) {
      console.error(e);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(ns); }, [ns, load]);

  const setStatus = (name: string, msg: string) => {
    setActionStatus(s => ({ ...s, [name]: msg }));
    setTimeout(() => setActionStatus(s => { const n = { ...s }; delete n[name]; return n; }), 4000);
  };

  const doRestart = async (d: DeploymentInfo) => {
    setStatus(d.name, '↻ restarting…');
    try {
      const r = await restartDeployment(ns, d.name);
      setStatus(d.name, r.message);
    } catch (e: any) {
      setStatus(d.name, `✗ ${e.message}`);
    }
  };

  const doScale = async (d: DeploymentInfo) => {
    const target = scaleTargets[d.name] ?? d.replicas;
    setStatus(d.name, `↕ scaling to ${target}…`);
    try {
      const r = await scaleDeployment(ns, d.name, target);
      setStatus(d.name, r.message);
      load(ns);
    } catch (e: any) {
      setStatus(d.name, `✗ ${e.message}`);
    }
  };

  const adjustScale = (name: string, delta: number, current: number) => {
    setScaleTargets(s => ({ ...s, [name]: Math.max(0, Math.min(20, (s[name] ?? current) + delta)) }));
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Deployments</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Restart, scale, and monitor Kubernetes deployments</p>
        </div>
        <button onClick={() => load(ns)} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Namespace selector */}
      <div className="flex items-center gap-2 flex-wrap">
        {NAMESPACES.map(n => (
          <button
            key={n}
            onClick={() => setNs(n)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-mono transition-colors border',
              ns === n
                ? 'bg-[#58a6ff]/20 text-[#58a6ff] border-[#58a6ff]/30'
                : 'bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] border-transparent',
            )}
          >{n}</button>
        ))}
      </div>

      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <Layers size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Deployments in <code className="font-mono text-[#58a6ff]">{ns}</code></h2>
          <span className="ml-auto text-xs text-[#6e7681]">{deployments.length} deployments</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[#30363d]">
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Replicas</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Image</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Age</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Scale</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-[#21262d]">
              {loading && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#6e7681] text-sm">Loading…</td></tr>
              )}
              {!loading && deployments.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-[#6e7681] text-sm">No deployments found in <code className="font-mono">{ns}</code>.</td></tr>
              )}
              {deployments.map(d => {
                const healthy = d.readyReplicas >= d.replicas && d.replicas > 0;
                const degraded = d.readyReplicas < d.replicas;
                const zero = d.replicas === 0;
                const target = scaleTargets[d.name] ?? d.replicas;
                const status = actionStatus[d.name];
                return (
                  <tr key={d.name} className={clsx('hover:bg-[#161b22] transition-colors', degraded && !zero && 'bg-[#d29922]/5')}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-[#e6edf3] font-medium">{d.name}</div>
                      {status && (
                        <div className={clsx('text-[10px] mt-0.5 font-mono',
                          status.startsWith('✗') ? 'text-[#f85149]' : 'text-[#3fb950]'
                        )}>{status}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {zero
                        ? <Badge label="Scaled Down" variant="muted" size="xs" />
                        : healthy
                          ? <Badge label="Healthy" variant="success" size="xs" />
                          : <Badge label="Degraded" variant="warning" size="xs" />}
                    </td>
                    <td className="px-4 py-3">
                      <ReplicaBar ready={d.readyReplicas} desired={d.replicas} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-[10px] text-[#8b949e] max-w-[200px] truncate" title={d.image}>
                        {d.image.split('/').pop()?.split(':').join(' : ') ?? d.image}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[#8b949e]">{d.age}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => adjustScale(d.name, -1, d.replicas)}
                          className="w-5 h-5 flex items-center justify-center rounded bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                          <Minus size={10} />
                        </button>
                        <span className={clsx('font-mono text-xs w-5 text-center font-bold',
                          target !== d.replicas ? 'text-[#d29922]' : 'text-[#e6edf3]'
                        )}>{target}</span>
                        <button onClick={() => adjustScale(d.name, 1, d.replicas)}
                          className="w-5 h-5 flex items-center justify-center rounded bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors">
                          <Plus size={10} />
                        </button>
                        {target !== d.replicas && (
                          <button onClick={() => doScale(d)}
                            className="ml-1 px-2 py-0.5 rounded text-[10px] bg-[#d29922]/20 text-[#d29922] hover:bg-[#d29922]/30 transition-colors font-semibold">
                            Apply
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => doRestart(d)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs bg-[#58a6ff]/10 text-[#58a6ff] hover:bg-[#58a6ff]/20 transition-colors border border-[#58a6ff]/20"
                        title="Rolling restart"
                      >
                        <RotateCcw size={11} />
                        Restart
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ReplicaBar({ ready, desired }: { ready: number; desired: number }) {
  if (desired === 0) return <span className="text-xs text-[#6e7681] font-mono">0 / 0</span>;
  const pct = Math.round((ready / desired) * 100);
  const color = pct === 100 ? '#3fb950' : pct >= 50 ? '#d29922' : '#f85149';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-[#21262d] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-xs text-[#8b949e]">{ready}/{desired}</span>
    </div>
  );
}
