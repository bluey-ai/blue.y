import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Server, Box } from 'lucide-react';
import { getPods, getNodes } from '../api';
import type { PodInfo, NodeInfo } from '../types';
import Card from '../components/Card';
import Badge from '../components/Badge';
import clsx from 'clsx';

const NAMESPACES = ['prod', 'dev', 'monitoring', 'doris', 'wordpress', 'kube-system'];

export default function Cluster() {
  const [ns, setNs] = useState('prod');
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [customNs, setCustomNs] = useState('');

  const loadAll = useCallback(async (namespace: string) => {
    setLoading(true);
    try {
      const [p, n] = await Promise.all([getPods(namespace), getNodes()]);
      setPods(p.pods);
      setNodes(n.nodes);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAll(ns); }, [ns, loadAll]);

  const servicePods = pods.filter(p => !p.isJobPod);
  const jobPods = pods.filter(p => p.isJobPod);
  const unhealthy = servicePods.filter(p =>
    (p.status !== 'Running' && p.status !== 'Succeeded') || (!p.ready && p.status === 'Running') || p.restarts > 5
  );

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Cluster</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Live pod & node status</p>
        </div>
        <button onClick={() => loadAll(ns)} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
          <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
        </button>
      </div>

      {/* Nodes */}
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <Server size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">Nodes</h2>
          <span className="ml-auto text-xs text-[#6e7681]">{nodes.length} nodes</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[#30363d]">
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Roles</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">CPU</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Memory</th>
            </tr></thead>
            <tbody className="divide-y divide-[#21262d]">
              {nodes.map(n => (
                <tr key={n.name} className="hover:bg-[#161b22]">
                  <td className="px-4 py-2.5 font-mono text-xs text-[#e6edf3]">{n.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge label={n.status} variant={n.status === 'Ready' ? 'success' : 'critical'} size="xs" />
                  </td>
                  <td className="px-4 py-2.5 flex gap-1 flex-wrap">
                    {n.roles.length > 0 ? n.roles.map(r => <Badge key={r} label={r} variant="info" size="xs" />) : <span className="text-[#6e7681] text-xs">worker</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[#8b949e]">{n.allocatable.cpu}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[#8b949e]">{n.allocatable.memory}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Namespace selector */}
      <div className="flex items-center gap-2 flex-wrap">
        {NAMESPACES.map(n => (
          <button
            key={n}
            onClick={() => { setNs(n); setCustomNs(''); }}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-mono transition-colors',
              ns === n && !customNs ? 'bg-[#58a6ff]/20 text-[#58a6ff] border border-[#58a6ff]/30' : 'bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] border border-transparent',
            )}
          >{n}</button>
        ))}
        <input
          type="text"
          placeholder="custom namespace…"
          className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-1.5 text-xs font-mono text-[#e6edf3] outline-none focus:border-[#58a6ff] w-36"
          value={customNs}
          onChange={e => setCustomNs(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && customNs) { setNs(customNs); } }}
        />
      </div>

      {/* Unhealthy alert */}
      {unhealthy.length > 0 && (
        <div className="rounded-lg border border-[#f85149]/30 bg-[#f85149]/10 px-4 py-3 text-sm text-[#f85149]">
          ⚠ {unhealthy.length} unhealthy pod{unhealthy.length > 1 ? 's' : ''} in <code className="font-mono text-xs">{ns}</code>:{' '}
          {unhealthy.map(p => p.name).join(', ')}
        </div>
      )}

      {/* Service pods */}
      <PodTable title="Service Pods" pods={servicePods} loading={loading} />

      {/* Job pods */}
      {jobPods.length > 0 && <PodTable title="Jobs / CronJobs" pods={jobPods} loading={false} />}
    </div>
  );
}

function PodTable({ title, pods, loading }: { title: string; pods: PodInfo[]; loading: boolean }) {
  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
        <Box size={14} className="text-[#58a6ff]" />
        <h2 className="text-sm font-semibold text-[#e6edf3]">{title}</h2>
        <span className="ml-auto text-xs text-[#6e7681]">{pods.length} pods</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-[#30363d]">
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Name</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Status</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Ready</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Restarts</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Age</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Containers</th>
          </tr></thead>
          <tbody className="divide-y divide-[#21262d]">
            {loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6e7681] text-sm">Loading…</td></tr>}
            {!loading && pods.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-[#6e7681] text-sm">No pods found.</td></tr>}
            {pods.map(pod => {
              const isUnhealthy = !pod.isJobPod && ((pod.status !== 'Running' && pod.status !== 'Succeeded') || (!pod.ready && pod.status === 'Running') || pod.restarts > 5);
              return (
                <tr key={pod.name} className={clsx('hover:bg-[#161b22] transition-colors', isUnhealthy && 'bg-[#f85149]/5')}>
                  <td className="px-4 py-2.5 font-mono text-xs text-[#e6edf3]">{pod.name}</td>
                  <td className="px-4 py-2.5">
                    <PodStatusBadge status={pod.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    {pod.ready
                      ? <span className="text-[#3fb950] text-xs">✓</span>
                      : <span className="text-[#f85149] text-xs">✗</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={clsx('font-mono text-xs', pod.restarts > 5 ? 'text-[#f85149]' : pod.restarts > 0 ? 'text-[#d29922]' : 'text-[#8b949e]')}>
                      {pod.restarts}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[#8b949e]">{pod.age}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1 flex-wrap">
                      {pod.containers.map(c => (
                        <span key={c.name} className={clsx(
                          'text-[10px] font-mono px-1.5 py-px rounded',
                          c.state === 'running' ? 'bg-[#3fb950]/10 text-[#3fb950]' : 'bg-[#f85149]/10 text-[#f85149]',
                        )}>
                          {c.name}{c.reason ? ` (${c.reason})` : ''}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PodStatusBadge({ status }: { status: string }) {
  const v = status === 'Running' ? 'success' : status === 'Succeeded' ? 'muted' : status === 'Pending' ? 'warning' : 'critical';
  return <Badge label={status} variant={v} size="xs" />;
}
