import { useEffect, useState, useCallback, useRef } from 'react';
import { Layers, RefreshCw, RotateCcw, Minus, Plus, CheckCircle, XCircle, Loader, Clock, ChevronDown, ChevronRight, Terminal as TerminalIcon, ScrollText, History, X } from 'lucide-react';
import { getDeployments, restartDeployment, scaleDeployment, waitForApprovalDecision, getDeploymentPods, getDeploymentHistory, rollbackDeployment } from '../api';
import type { DeploymentRevision } from '../api';
import type { DeploymentInfo, PodInfo } from '../types';
import PodTerminal from '../components/PodTerminal';
import PodLogsViewer from '../components/PodLogsViewer';
import Card from '../components/Card';
import Badge from '../components/Badge';
import clsx from 'clsx';

const NAMESPACES = ['prod', 'dev', 'monitoring', 'doris', 'wordpress'];

type ActionPhase = 'idle' | 'requesting' | 'awaiting_approval' | 'polling' | 'done' | 'error';

interface RowAction {
  phase: ActionPhase;
  message: string;
  ready?: number;
  desired?: number;
}

export default function Deployments() {
  const [ns, setNs] = useState('prod');
  const [deployments, setDeployments] = useState<DeploymentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [actions, setActions] = useState<Record<string, RowAction>>({});
  const [scaleTargets, setScaleTargets] = useState<Record<string, number>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const sseCancelRef = useRef<Record<string, () => void>>({});
  // Pod expansion + terminal (BLY-63) + logs viewer (BLY-65) + container picker (BLY-66)
  const [expandedDep, setExpandedDep] = useState<string | null>(null);
  const [podsMap, setPodsMap] = useState<Record<string, PodInfo[]>>({});
  const [loadingPods, setLoadingPods] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<{ namespace: string; pod: string; container: string } | null>(null);
  const [logsModal, setLogsModal] = useState<{ namespace: string; pod: string; container: string; containers: string[] } | null>(null);
  const [containerMenu, setContainerMenu] = useState<string | null>(null); // pod name whose shell menu is open
  // Rollback (BLY-68)
  const [rollbackModal, setRollbackModal] = useState<{ deployment: DeploymentInfo } | null>(null);
  const [rollbackHistory, setRollbackHistory] = useState<DeploymentRevision[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [confirmRevision, setConfirmRevision] = useState<DeploymentRevision | null>(null);

  const load = useCallback(async (namespace: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await getDeployments(namespace);
      setDeployments(r.deployments);
      // Update scale targets only for rows NOT currently being acted on
      setScaleTargets(prev => {
        const next = { ...prev };
        r.deployments.forEach(d => {
          if (!prev[d.name]) next[d.name] = d.replicas;
        });
        return next;
      });
      return r.deployments;
    } catch (e: any) {
      console.error(e);
      return [];
    } finally { if (!silent) setLoading(false); }
  }, []);

  useEffect(() => { load(ns); }, [ns, load]);

  // Clean up all poll timers and SSE listeners on unmount / ns change
  useEffect(() => {
    const timers = pollTimers.current;
    const cancels = sseCancelRef.current;
    return () => {
      Object.values(timers).forEach(clearInterval);
      Object.values(cancels).forEach(fn => fn());
    };
  }, [ns]);

  const setAction = (name: string, action: RowAction) => {
    setActions(s => ({ ...s, [name]: action }));
  };

  const clearAction = (name: string, delay = 4000) => {
    setTimeout(() => setActions(s => { const n = { ...s }; delete n[name]; return n; }), delay);
  };

  const stopPoll = (name: string) => {
    if (pollTimers.current[name]) {
      clearInterval(pollTimers.current[name]);
      delete pollTimers.current[name];
    }
  };

  const cancelSse = (name: string) => {
    if (sseCancelRef.current[name]) {
      sseCancelRef.current[name]();
      delete sseCancelRef.current[name];
    }
  };

  // Poll until deployment reaches desired state, with live feedback
  const startPolling = (name: string, desiredReplicas: number, type: 'restart' | 'scale') => {
    stopPoll(name);
    let ticks = 0;
    const maxTicks = 20; // 60s max (3s * 20)

    pollTimers.current[name] = setInterval(async () => {
      ticks++;
      const deps = await load(ns, true);
      const d = deps.find(x => x.name === name);
      if (!d) { stopPoll(name); return; }

      const ready = d.readyReplicas;
      const desired = d.replicas;

      setAction(name, {
        phase: 'polling',
        message: type === 'restart'
          ? ready < desired ? `Cycling pods… ${ready}/${desired} ready` : `Verifying restart…`
          : `Scaling… ${ready}/${desired} ready`,
        ready,
        desired,
      });

      // Update live replica bar in table
      setDeployments(prev => prev.map(x => x.name === name ? { ...x, readyReplicas: ready, replicas: desired } : x));

      if (ready >= desiredReplicas && desiredReplicas > 0) {
        stopPoll(name);
        setAction(name, { phase: 'done', message: type === 'restart' ? `All ${ready} pods restarted` : `Scaled to ${ready}`, ready, desired });
        clearAction(name, 5000);
      } else if (ticks >= maxTicks) {
        stopPoll(name);
        setAction(name, { phase: 'error', message: `Timeout — ${ready}/${desired} ready. Check cluster.` });
        clearAction(name, 6000);
      }
    }, 3000);
  };

  const handleApprovalResponse = (
    name: string,
    approvalId: string,
    onApproved: () => void,
  ) => {
    cancelSse(name);
    setAction(name, { phase: 'awaiting_approval', message: 'Awaiting SuperAdmin approval…' });
    const cancel = waitForApprovalDecision(approvalId, (status) => {
      cancelSse(name);
      if (status === 'approved') {
        setAction(name, { phase: 'polling', message: 'Approved — executing…' });
        onApproved();
      } else if (status === 'rejected') {
        setAction(name, { phase: 'error', message: 'Rejected by SuperAdmin.' });
        clearAction(name, 5000);
      } else {
        setAction(name, { phase: 'error', message: 'Approval request expired (10 min).' });
        clearAction(name, 5000);
      }
    });
    sseCancelRef.current[name] = cancel;
  };

  const doRestart = async (d: DeploymentInfo) => {
    stopPoll(d.name);
    cancelSse(d.name);
    setAction(d.name, { phase: 'requesting', message: 'Sending restart…' });
    try {
      const result = await restartDeployment(ns, d.name);
      if (result.requiresApproval && result.approvalId) {
        handleApprovalResponse(d.name, result.approvalId, () => {
          setAction(d.name, { phase: 'polling', message: 'Rolling restart triggered…', ready: d.readyReplicas, desired: d.replicas });
          startPolling(d.name, d.replicas, 'restart');
        });
      } else {
        setAction(d.name, { phase: 'polling', message: 'Rolling restart triggered…', ready: d.readyReplicas, desired: d.replicas });
        startPolling(d.name, d.replicas, 'restart');
      }
    } catch (e: any) {
      setAction(d.name, { phase: 'error', message: e.message });
      clearAction(d.name);
    }
  };

  const doScale = async (d: DeploymentInfo) => {
    const target = scaleTargets[d.name] ?? d.replicas;
    if (target === d.replicas) return;
    stopPoll(d.name);
    cancelSse(d.name);
    setAction(d.name, { phase: 'requesting', message: `Scaling to ${target}…` });
    try {
      const result = await scaleDeployment(ns, d.name, target);
      if (result.requiresApproval && result.approvalId) {
        handleApprovalResponse(d.name, result.approvalId, () => {
          setAction(d.name, { phase: 'polling', message: `Waiting for ${target} pod${target !== 1 ? 's' : ''}…`, ready: d.readyReplicas, desired: target });
          setDeployments(prev => prev.map(x => x.name === d.name ? { ...x, replicas: target } : x));
          setScaleTargets(s => ({ ...s, [d.name]: target }));
          startPolling(d.name, target, 'scale');
        });
      } else {
        setAction(d.name, { phase: 'polling', message: `Waiting for ${target} pod${target !== 1 ? 's' : ''}…`, ready: d.readyReplicas, desired: target });
        setDeployments(prev => prev.map(x => x.name === d.name ? { ...x, replicas: target } : x));
        setScaleTargets(s => ({ ...s, [d.name]: target }));
        startPolling(d.name, target, 'scale');
      }
    } catch (e: any) {
      setAction(d.name, { phase: 'error', message: e.message });
      clearAction(d.name);
    }
  };

  const adjustScale = (name: string, delta: number, current: number) => {
    setScaleTargets(s => ({ ...s, [name]: Math.max(0, Math.min(20, (s[name] ?? current) + delta)) }));
  };

  const openRollbackModal = async (d: DeploymentInfo) => {
    setRollbackModal({ deployment: d });
    setConfirmRevision(null);
    setLoadingHistory(true);
    try {
      const r = await getDeploymentHistory(ns, d.name);
      setRollbackHistory(r.history);
    } catch { setRollbackHistory([]); }
    finally { setLoadingHistory(false); }
  };

  const doRollback = async (d: DeploymentInfo, rev: DeploymentRevision) => {
    setConfirmRevision(null);
    setRollbackModal(null);
    stopPoll(d.name);
    cancelSse(d.name);
    setAction(d.name, { phase: 'requesting', message: `Rolling back to revision ${rev.revision}…` });
    try {
      const result = await rollbackDeployment(ns, d.name, rev.revision);
      if (result.requiresApproval && result.approvalId) {
        handleApprovalResponse(d.name, result.approvalId, () => {
          setAction(d.name, { phase: 'polling', message: `Rollback to r${rev.revision} executing…`, ready: d.readyReplicas, desired: d.replicas });
          startPolling(d.name, d.replicas, 'restart');
        });
      } else {
        setAction(d.name, { phase: 'polling', message: `Rolled back to r${rev.revision}…`, ready: d.readyReplicas, desired: d.replicas });
        startPolling(d.name, d.replicas, 'restart');
      }
    } catch (e: any) {
      setAction(d.name, { phase: 'error', message: e.message });
      clearAction(d.name);
    }
  };

  const togglePods = async (depName: string) => {
    if (expandedDep === depName) { setExpandedDep(null); return; }
    setExpandedDep(depName);
    if (podsMap[depName]) return; // already loaded
    setLoadingPods(depName);
    try {
      const r = await getDeploymentPods(ns, depName);
      setPodsMap(prev => ({ ...prev, [depName]: r.pods }));
    } catch { /* ignore */ }
    finally { setLoadingPods(null); }
  };

  return (
    <div className="p-4 md:p-6 space-y-5 animate-fade-in">
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
          <button key={n} onClick={() => setNs(n)}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-mono transition-colors border',
              ns === n ? 'bg-[#58a6ff]/20 text-[#58a6ff] border-[#58a6ff]/30' : 'bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] border-transparent',
            )}>{n}</button>
        ))}
      </div>

      <Card padding={false}>
        <div className="px-4 py-3 border-b border-[#30363d] flex items-center gap-2">
          <Layers size={14} className="text-[#58a6ff]" />
          <h2 className="text-sm font-semibold text-[#e6edf3]">
            Deployments in <code className="font-mono text-[#58a6ff]">{ns}</code>
          </h2>
          <span className="ml-auto text-xs text-[#6e7681]">{deployments.length} deployments</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead><tr className="border-b border-[#30363d]">
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Replicas</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e] hidden md:table-cell">Image</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e] hidden md:table-cell">Age</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]">Scale</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-[#8b949e]" colSpan={2}>Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-[#21262d]">
              {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-[#6e7681] text-sm">Loading…</td></tr>}
              {!loading && deployments.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-[#6e7681] text-sm">
                  No deployments found in <code className="font-mono">{ns}</code>.
                </td></tr>
              )}

              {deployments.map(d => {
                const act = actions[d.name];
                const target = scaleTargets[d.name] ?? d.replicas;
                const healthy = d.readyReplicas >= d.replicas && d.replicas > 0;
                const degraded = d.readyReplicas < d.replicas;
                const zero = d.replicas === 0;
                const isActive = act && act.phase !== 'idle';
                return (
                  <>
                  <tr key={d.name} className={clsx(
                    'hover:bg-[#161b22] transition-colors',
                    act?.phase === 'awaiting_approval' && 'bg-[#bc8cff]/5',
                    act?.phase === 'polling' && 'bg-[#58a6ff]/5',
                    act?.phase === 'done' && 'bg-[#3fb950]/5',
                    act?.phase === 'error' && 'bg-[#f85149]/5',
                    !isActive && degraded && !zero && 'bg-[#d29922]/5',
                  )}>
                    {/* Name — click to expand pods */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => togglePods(d.name)}
                        className="flex items-center gap-1.5 group text-left"
                        title="Click to expand pods"
                      >
                        {loadingPods === d.name
                          ? <Loader size={11} className="text-[#8b949e] animate-spin shrink-0" />
                          : expandedDep === d.name
                          ? <ChevronDown size={11} className="text-[#bc8cff] shrink-0" />
                          : <ChevronRight size={11} className="text-[#6e7681] group-hover:text-[#8b949e] shrink-0" />
                        }
                        <span className={clsx(
                          'font-mono text-xs font-medium transition-colors',
                          expandedDep === d.name ? 'text-[#bc8cff]' : 'text-[#e6edf3] group-hover:text-[#58a6ff]',
                        )}>{d.name}</span>
                      </button>
                      {act && act.phase !== 'idle' && (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          {act.phase === 'requesting' && <Loader size={10} className="text-[#58a6ff] animate-spin shrink-0" />}
                          {act.phase === 'awaiting_approval' && <Clock size={10} className="text-[#bc8cff] animate-pulse shrink-0" />}
                          {act.phase === 'polling' && <Loader size={10} className="text-[#d29922] animate-spin shrink-0" />}
                          {act.phase === 'done' && <CheckCircle size={10} className="text-[#3fb950] shrink-0" />}
                          {act.phase === 'error' && <XCircle size={10} className="text-[#f85149] shrink-0" />}
                          <span className={clsx('text-[10px] font-mono',
                            act.phase === 'done' ? 'text-[#3fb950]' :
                            act.phase === 'error' ? 'text-[#f85149]' :
                            act.phase === 'awaiting_approval' ? 'text-[#bc8cff]' :
                            act.phase === 'polling' ? 'text-[#d29922]' : 'text-[#8b949e]'
                          )}>{act.message}</span>
                        </div>
                      )}
                      {/* Live mini progress bar during poll */}
                      {act?.phase === 'polling' && act.desired !== undefined && act.desired > 0 && (
                        <div className="mt-1.5 w-32 h-1 bg-[#21262d] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#d29922] rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(((act.ready ?? 0) / act.desired) * 100)}%` }}
                          />
                        </div>
                      )}
                    </td>

                    {/* Health badge */}
                    <td className="px-4 py-3">
                      {zero ? <Badge label="Scaled Down" variant="muted" size="xs" />
                        : healthy ? <Badge label="Healthy" variant="success" size="xs" />
                        : <Badge label="Degraded" variant="warning" size="xs" />}
                    </td>

                    {/* Replica bar */}
                    <td className="px-4 py-3">
                      <ReplicaBar ready={d.readyReplicas} desired={d.replicas} animating={act?.phase === 'polling'} />
                    </td>

                    {/* Image */}
                    <td className="px-4 py-3 hidden md:table-cell">
                      <div className="font-mono text-[10px] text-[#8b949e] max-w-[180px] truncate" title={d.image}>
                        {d.image.split('/').pop()?.split(':').join(' : ') ?? d.image}
                      </div>
                    </td>

                    {/* Age */}
                    <td className="px-4 py-3 font-mono text-xs text-[#8b949e] hidden md:table-cell">{d.age}</td>

                    {/* Scale controls */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => adjustScale(d.name, -1, d.replicas)}
                          disabled={!!act && act.phase !== 'idle' && act.phase !== 'done' && act.phase !== 'error'}
                          className="w-6 h-6 flex items-center justify-center rounded bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors disabled:opacity-30"
                        >
                          <Minus size={10} />
                        </button>
                        <span className={clsx('font-mono text-xs w-6 text-center font-bold',
                          target !== d.replicas ? 'text-[#d29922]' : 'text-[#e6edf3]'
                        )}>{target}</span>
                        <button
                          onClick={() => adjustScale(d.name, 1, d.replicas)}
                          disabled={!!act && act.phase !== 'idle' && act.phase !== 'done' && act.phase !== 'error'}
                          className="w-6 h-6 flex items-center justify-center rounded bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] transition-colors disabled:opacity-30"
                        >
                          <Plus size={10} />
                        </button>
                        {target !== d.replicas && (
                          <button
                            onClick={() => doScale(d)}
                            disabled={act?.phase === 'requesting' || act?.phase === 'awaiting_approval' || act?.phase === 'polling'}
                            className="ml-1 px-2 py-0.5 rounded text-[10px] bg-[#d29922]/20 text-[#d29922] hover:bg-[#d29922]/30 transition-colors font-semibold disabled:opacity-40"
                          >
                            Apply
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Restart */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => doRestart(d)}
                        disabled={act?.phase === 'requesting' || act?.phase === 'awaiting_approval' || act?.phase === 'polling'}
                        className={clsx(
                          'flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors border disabled:opacity-40 disabled:cursor-not-allowed',
                          act?.phase === 'awaiting_approval'
                            ? 'bg-[#bc8cff]/10 text-[#bc8cff] border-[#bc8cff]/20'
                            : act?.phase === 'polling'
                            ? 'bg-[#d29922]/10 text-[#d29922] border-[#d29922]/20'
                            : act?.phase === 'done'
                              ? 'bg-[#3fb950]/10 text-[#3fb950] border-[#3fb950]/20'
                              : 'bg-[#58a6ff]/10 text-[#58a6ff] hover:bg-[#58a6ff]/20 border-[#58a6ff]/20',
                        )}
                      >
                        {act?.phase === 'awaiting_approval'
                          ? <Clock size={11} className="animate-pulse" />
                          : <RotateCcw size={11} className={clsx(act?.phase === 'polling' && 'animate-spin')} />
                        }
                        <span className="hidden sm:inline">
                          {act?.phase === 'awaiting_approval' ? 'Pending' :
                           act?.phase === 'polling' ? 'Restarting' :
                           act?.phase === 'done' ? 'Done' : 'Restart'}
                        </span>
                      </button>
                    </td>

                    {/* Rollback (BLY-68) */}
                    <td className="px-2 py-3">
                      <button
                        onClick={() => openRollbackModal(d)}
                        disabled={act?.phase === 'requesting' || act?.phase === 'awaiting_approval' || act?.phase === 'polling'}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors border bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] border-transparent disabled:opacity-30 disabled:cursor-not-allowed"
                        title="View revision history & rollback"
                      >
                        <History size={11} />
                        <span className="hidden sm:inline">Rollback</span>
                      </button>
                    </td>

                  </tr>

                  {/* Expanded pods row */}
                  {expandedDep === d.name && (
                    <tr className="bg-[#0d1117]">
                      <td colSpan={8} className="px-6 py-3 border-b border-[#21262d]">
                        {loadingPods === d.name ? (
                          <p className="text-xs text-[#6e7681]">Loading pods…</p>
                        ) : (podsMap[d.name] ?? []).length === 0 ? (
                          <p className="text-xs text-[#6e7681]">No running pods found for this deployment.</p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {(podsMap[d.name] ?? []).map(pod => {
                              const cnames = pod.containers.map(c => c.name);
                              const firstContainer = cnames[0] ?? '';
                              const multiContainer = cnames.length > 1;
                              return (
                              <div key={pod.name} className="flex items-center gap-2 bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 relative">
                                <div className={clsx('w-1.5 h-1.5 rounded-full shrink-0', pod.status === 'Running' ? 'bg-[#3fb950]' : 'bg-[#f85149]')} />
                                <span className="font-mono text-[10px] text-[#8b949e] max-w-[200px] truncate" title={pod.name}>{pod.name}</span>
                                <span className={clsx('text-[10px]', pod.status === 'Running' ? 'text-[#3fb950]' : 'text-[#f85149]')}>{pod.status}</span>
                                {pod.age && <span className="text-[10px] text-[#6e7681]">{pod.age}</span>}
                                {typeof pod.restarts === 'number' && pod.restarts > 0 && (
                                  <span className="text-[10px] text-[#d29922]" title="Restart count">{pod.restarts}↺</span>
                                )}

                                {/* Logs button (BLY-65) */}
                                <button
                                  onClick={() => setLogsModal({ namespace: ns, pod: pod.name, container: firstContainer, containers: cnames })}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#3fb950]/10 text-[#3fb950] hover:bg-[#3fb950]/20 border border-[#3fb950]/20 transition-colors"
                                  title="View logs"
                                >
                                  <ScrollText size={9} /> Logs
                                </button>

                                {/* Shell button — single or multi-container picker (BLY-66) */}
                                {!multiContainer ? (
                                  <button
                                    onClick={() => setTerminal({ namespace: ns, pod: pod.name, container: firstContainer })}
                                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#58a6ff]/10 text-[#58a6ff] hover:bg-[#58a6ff]/20 border border-[#58a6ff]/20 transition-colors"
                                    title="Open shell"
                                  >
                                    <TerminalIcon size={9} /> Shell
                                  </button>
                                ) : (
                                  <div className="relative">
                                    <button
                                      onClick={() => setContainerMenu(containerMenu === pod.name ? null : pod.name)}
                                      className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-[#58a6ff]/10 text-[#58a6ff] hover:bg-[#58a6ff]/20 border border-[#58a6ff]/20 transition-colors"
                                      title="Pick container to shell into"
                                    >
                                      <TerminalIcon size={9} /> Shell <ChevronDown size={8} />
                                    </button>
                                    {containerMenu === pod.name && (
                                      <div className="absolute bottom-full left-0 mb-1 bg-[#161b22] border border-[#30363d] rounded shadow-xl z-20 min-w-[160px] py-1">
                                        {cnames.map(c => (
                                          <button
                                            key={c}
                                            onClick={() => { setTerminal({ namespace: ns, pod: pod.name, container: c }); setContainerMenu(null); }}
                                            className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-[#8b949e] hover:bg-[#21262d] hover:text-[#58a6ff] transition-colors"
                                          >
                                            {c}
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>);
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pod terminal modal (BLY-63) */}
      {terminal && (
        <PodTerminal
          namespace={terminal.namespace}
          pod={terminal.pod}
          container={terminal.container}
          onClose={() => setTerminal(null)}
        />
      )}

      {/* Pod logs viewer modal (BLY-65) */}
      {logsModal && (
        <PodLogsViewer
          namespace={logsModal.namespace}
          pod={logsModal.pod}
          container={logsModal.container}
          containers={logsModal.containers}
          onClose={() => setLogsModal(null)}
        />
      )}

      {/* Rollback modal (BLY-68) */}
      {rollbackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-2xl mx-4 bg-[#161b22] rounded-xl border border-[#30363d] shadow-2xl flex flex-col overflow-hidden max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-5 py-3.5 bg-[#0d1117] border-b border-[#30363d] shrink-0">
              <History size={14} className="text-[#bc8cff]" />
              <span className="text-sm font-semibold text-[#e6edf3]">Revision History</span>
              <span className="font-mono text-xs text-[#8b949e]">— <span className="text-[#58a6ff]">{rollbackModal.deployment.name}</span></span>
              <button onClick={() => { setRollbackModal(null); setConfirmRevision(null); }}
                className="ml-auto p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
                <X size={14} />
              </button>
            </div>

            {/* Confirmation bar */}
            {confirmRevision && (
              <div className="px-5 py-3 bg-[#d29922]/10 border-b border-[#d29922]/30 flex items-center gap-3 shrink-0">
                <span className="text-xs text-[#d29922] font-medium flex-1">
                  Roll back <code className="font-mono">{rollbackModal.deployment.name}</code> to revision {confirmRevision.revision}?
                  <span className="ml-2 text-[#8b949e] font-mono">{confirmRevision.image.split('/').pop()}</span>
                </span>
                <button onClick={() => doRollback(rollbackModal.deployment, confirmRevision)}
                  className="px-3 py-1 rounded text-xs font-semibold bg-[#d29922] text-[#0d1117] hover:bg-[#d29922]/90 transition-colors">
                  Confirm Rollback
                </button>
                <button onClick={() => setConfirmRevision(null)}
                  className="px-3 py-1 rounded text-xs text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
                  Cancel
                </button>
              </div>
            )}

            {/* History table */}
            <div className="overflow-y-auto flex-1">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-12 gap-2 text-[#6e7681] text-sm">
                  <Loader size={14} className="animate-spin" /> Loading history…
                </div>
              ) : rollbackHistory.length === 0 ? (
                <div className="py-12 text-center text-[#6e7681] text-sm">No revision history found.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#30363d]">
                      <th className="px-5 py-2.5 text-left text-xs font-medium text-[#8b949e]">Revision</th>
                      <th className="px-5 py-2.5 text-left text-xs font-medium text-[#8b949e]">Image</th>
                      <th className="px-5 py-2.5 text-left text-xs font-medium text-[#8b949e]">Age</th>
                      <th className="px-5 py-2.5 text-left text-xs font-medium text-[#8b949e]">Replicas</th>
                      <th className="px-5 py-2.5 text-left text-xs font-medium text-[#8b949e]"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#21262d]">
                    {rollbackHistory.map(rev => (
                      <tr key={rev.revision} className={clsx(
                        'transition-colors',
                        rev.isCurrent ? 'bg-[#3fb950]/5' : 'hover:bg-[#161b22]',
                        confirmRevision?.revision === rev.revision && 'bg-[#d29922]/5',
                      )}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-[#e6edf3]">r{rev.revision}</span>
                            {rev.isCurrent && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#3fb950]/20 text-[#3fb950] border border-[#3fb950]/30">
                                current
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="font-mono text-[11px] text-[#8b949e] max-w-[260px] truncate" title={rev.image}>
                            {rev.image.split('/').pop()?.split(':').join(' : ') ?? rev.image}
                          </div>
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-[#6e7681]">{rev.age}</td>
                        <td className="px-5 py-3 font-mono text-xs text-[#8b949e]">
                          {rev.readyReplicas}/{rev.replicas}
                        </td>
                        <td className="px-5 py-3">
                          {!rev.isCurrent && (
                            <button
                              onClick={() => setConfirmRevision(rev)}
                              className={clsx(
                                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors border',
                                confirmRevision?.revision === rev.revision
                                  ? 'bg-[#d29922]/20 text-[#d29922] border-[#d29922]/30'
                                  : 'bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] border-transparent',
                              )}
                            >
                              <RotateCcw size={10} /> Roll back
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer note */}
            <div className="px-5 py-2.5 border-t border-[#30363d] bg-[#0d1117] shrink-0">
              <p className="text-[11px] text-[#6e7681]">
                History from Kubernetes ReplicaSets (up to <code className="font-mono">revisionHistoryLimit</code>, default 10).
                Rollback triggers a rolling update to the selected image.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReplicaBar({ ready, desired, animating }: { ready: number; desired: number; animating?: boolean }) {
  if (desired === 0) return <span className="text-xs text-[#6e7681] font-mono">0/0</span>;
  const pct = Math.round((ready / desired) * 100);
  const color = pct === 100 ? '#3fb950' : pct >= 50 ? '#d29922' : '#f85149';
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-[#21262d] rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full', animating && 'transition-all duration-500')}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="font-mono text-xs text-[#8b949e]">{ready}/{desired}</span>
    </div>
  );
}
