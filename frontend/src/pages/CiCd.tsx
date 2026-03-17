// BLY-75 — CI/CD Pipelines page
// Viewer: read-only (view pipelines + logs). Admin/SuperAdmin: trigger + stop.
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  ExternalLink, Play, Square, ChevronDown, ChevronRight,
  RefreshCw, CheckCircle2, XCircle, Clock, Minus, Loader2,
  GitBranch, AlertCircle, Lock,
} from 'lucide-react';
import {
  getCiRepos, getCiBranches, getCiPipelines, getCiSteps,
  triggerCiPipeline, stopCiPipeline, getStepLog, getMe,
} from '../api';
import type { CiRepo, CiPipeline, PipelineStep, MeResponse } from '../api';
import clsx from 'clsx';

type StatusFilter = 'all' | 'running' | 'passed' | 'failed' | 'stopped';

// ── helpers ──────────────────────────────────────────────────────────────────

function statusIcon(status: string, size = 14) {
  if (status === 'passed')  return <CheckCircle2 size={size} className="text-[#3fb950] shrink-0" />;
  if (status === 'failed')  return <XCircle      size={size} className="text-[#f85149] shrink-0" />;
  if (status === 'running') return <Loader2      size={size} className="text-[#58a6ff] shrink-0 animate-spin" />;
  if (status === 'stopped') return <Minus        size={size} className="text-[#8b949e] shrink-0" />;
  return                           <Clock        size={size} className="text-[#d29922] shrink-0" />;
}

function statusBadge(status: string) {
  const cls: Record<string, string> = {
    passed:  'bg-[#3fb950]/10 text-[#3fb950] border-[#3fb950]/20',
    failed:  'bg-[#f85149]/10 text-[#f85149] border-[#f85149]/20',
    running: 'bg-[#58a6ff]/10 text-[#58a6ff] border-[#58a6ff]/20',
    stopped: 'bg-[#8b949e]/10 text-[#8b949e] border-[#8b949e]/20',
    pending: 'bg-[#d29922]/10 text-[#d29922] border-[#d29922]/20',
  };
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border capitalize', cls[status] ?? cls.pending)}>
      {statusIcon(status, 10)}
      {status}
    </span>
  );
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── StepLogViewer ─────────────────────────────────────────────────────────────

function StepLogViewer({ repo, pipelineId, step, provider }: {
  repo: string; pipelineId: string; step: PipelineStep; provider: string;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true); setErr(''); setLog(null);
    getStepLog(repo, pipelineId, step.id, provider)
      .then(r => setLog(r.log))
      .catch(e => setErr(e?.message ?? 'Failed to load log'))
      .finally(() => setLoading(false));
  }, [repo, pipelineId, step.id, provider]);

  return (
    <div className="mt-2 rounded border border-[#30363d] bg-[#0d1117] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#30363d] bg-[#161b22] text-xs text-[#8b949e]">
        <GitBranch size={10} />
        <span className="font-mono truncate">{step.name}</span>
        {step.durationSeconds != null && <span className="ml-auto">{fmtDuration(step.durationSeconds)}</span>}
      </div>
      {loading && <div className="p-4 text-xs text-[#8b949e] flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading log…</div>}
      {err && <div className="p-4 text-xs text-[#f85149]">{err}</div>}
      {log != null && (
        <pre className="p-3 text-[10px] font-mono text-[#e6edf3] overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
          {log || '(empty log)'}
        </pre>
      )}
    </div>
  );
}

// ── PipelineRow ───────────────────────────────────────────────────────────────

function PipelineRow({ pipeline, repo, provider, canAct, onStop }: {
  pipeline: CiPipeline; repo: string; provider: string;
  canAct: boolean; onStop: (p: CiPipeline) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<PipelineStep[] | null>(null);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const toggle = async () => {
    setExpanded(e => !e);
    if (!expanded && steps === null) {
      setLoadingSteps(true);
      try {
        const r = await getCiSteps(repo, pipeline.pipelineId);
        setSteps(r.steps);
      } catch { setSteps([]); }
      finally { setLoadingSteps(false); }
    }
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Stop pipeline #${pipeline.buildNumber} on ${pipeline.branch}?`)) return;
    setStopping(true);
    try { await onStop(pipeline); } finally { setStopping(false); }
  };

  return (
    <div className="border border-[#30363d] rounded-lg overflow-hidden">
      {/* Row header */}
      <button
        onClick={toggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-[#161b22] hover:bg-[#1c2128] transition-colors text-left"
      >
        <span className="text-[#8b949e]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[#8b949e] font-mono text-xs w-10 shrink-0">#{pipeline.buildNumber}</span>
        <span className="shrink-0">{statusBadge(pipeline.status)}</span>
        <span className="flex items-center gap-1.5 text-xs text-[#e6edf3] font-mono min-w-0 flex-1 truncate">
          <GitBranch size={11} className="text-[#58a6ff] shrink-0" />
          <span className="truncate">{pipeline.branch}</span>
        </span>
        <span className="text-[10px] text-[#8b949e] shrink-0 hidden sm:block">{fmtDuration(pipeline.durationSeconds)}</span>
        <span className="text-[10px] text-[#8b949e] shrink-0 hidden md:block">{timeAgo(pipeline.createdAt)}</span>
        <span className="text-[10px] text-[#6e7681] shrink-0 hidden lg:block capitalize">{pipeline.triggeredBy}</span>
        <div className="flex items-center gap-1 shrink-0 ml-auto" onClick={e => e.stopPropagation()}>
          {canAct && pipeline.status === 'running' && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-[#f85149]/10 text-[#f85149] border border-[#f85149]/20 hover:bg-[#f85149]/20 transition-colors disabled:opacity-50"
              title="Stop pipeline"
            >
              {stopping ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />}
              Stop
            </button>
          )}
          <a
            href={pipeline.url} target="_blank" rel="noopener noreferrer"
            className="p-1.5 text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            title="Open in Bitbucket/GitHub"
          >
            <ExternalLink size={12} />
          </a>
        </div>
      </button>

      {/* Expanded steps */}
      {expanded && (
        <div className="border-t border-[#30363d] bg-[#0d1117] px-4 py-3 space-y-1">
          {loadingSteps && (
            <div className="flex items-center gap-2 text-xs text-[#8b949e] py-2">
              <Loader2 size={12} className="animate-spin" /> Loading steps…
            </div>
          )}
          {steps?.length === 0 && !loadingSteps && (
            <div className="text-xs text-[#6e7681] py-2">No steps found</div>
          )}
          {steps?.map(step => (
            <div key={step.id}>
              <button
                onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-[#161b22] transition-colors text-left"
              >
                {statusIcon(step.status, 12)}
                <span className="text-xs text-[#e6edf3] flex-1 truncate font-mono">{step.name}</span>
                <span className="text-[10px] text-[#8b949e] shrink-0">{fmtDuration(step.durationSeconds)}</span>
                <span className="text-[#8b949e] shrink-0">
                  {expandedStep === step.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
              </button>
              {expandedStep === step.id && (
                <StepLogViewer repo={repo} pipelineId={pipeline.pipelineId} step={step} provider={provider} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TriggerModal ──────────────────────────────────────────────────────────────

function TriggerModal({ repo, branches, onClose, onTriggered }: {
  repo: string; branches: string[];
  onClose: () => void; onTriggered: () => void;
}) {
  const [branch, setBranch] = useState(branches[0] ?? '');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const trigger = async () => {
    if (!branch) return;
    setLoading(true); setErr('');
    try {
      await triggerCiPipeline(repo, branch);
      onTriggered();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to trigger pipeline');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-sm p-5 space-y-4">
        <div>
          <div className="text-sm font-semibold text-[#e6edf3]">Trigger Pipeline</div>
          <div className="text-xs text-[#8b949e] mt-0.5 font-mono truncate">{repo}</div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-[#8b949e]">Branch</label>
          {branches.length > 0 ? (
            <select
              value={branch}
              onChange={e => setBranch(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
            >
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          ) : (
            <input
              value={branch} onChange={e => setBranch(e.target.value)}
              placeholder="branch name"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-[#e6edf3] font-mono focus:outline-none focus:border-[#58a6ff]"
            />
          )}
        </div>
        {err && <div className="text-xs text-[#f85149] bg-[#f85149]/5 border border-[#f85149]/20 rounded-lg px-3 py-2">{err}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-sm rounded-lg border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
            Cancel
          </button>
          <button
            onClick={trigger} disabled={loading || !branch}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg bg-[#58a6ff] text-[#0d1117] font-semibold hover:bg-[#79c0ff] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {loading ? 'Triggering…' : 'Trigger'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main CiCd page ────────────────────────────────────────────────────────────

export default function CiCd() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [repos, setRepos] = useState<CiRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [pipelines, setPipelines] = useState<CiPipeline[]>([]);
  const [provider, setProvider] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reposLoading, setReposLoading] = useState(true);
  const [error, setError] = useState('');
  const [showTrigger, setShowTrigger] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canAct = me?.role === 'admin' || me?.role === 'superadmin';

  useEffect(() => { getMe().then(setMe).catch(() => {}); }, []);

  // Load repos on mount
  useEffect(() => {
    setReposLoading(true);
    getCiRepos()
      .then(r => {
        setRepos(r.repos);
        setProvider(r.provider);
        setWorkspace(r.workspace);
        if (r.repos.length > 0) setSelectedRepo(r.repos[0].slug);
      })
      .catch(e => setError(e?.message ?? 'Failed to load repos'))
      .finally(() => setReposLoading(false));
  }, []);

  // Load branches when repo changes
  useEffect(() => {
    if (!selectedRepo) return;
    getCiBranches(selectedRepo).then(r => setBranches(r.branches)).catch(() => setBranches([]));
  }, [selectedRepo]);

  // Load pipelines
  const loadPipelines = useCallback(async (repo: string, pg: number, filter: StatusFilter, append = false) => {
    if (!repo) return;
    setLoading(true); setError('');
    try {
      const r = await getCiPipelines(repo, pg, filter === 'all' ? undefined : filter);
      setProvider(r.provider); setWorkspace(r.workspace);
      setPipelines(prev => append ? [...prev, ...r.pipelines] : r.pipelines);
      setHasMore(r.hasMore);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load pipelines');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!selectedRepo) return;
    setPage(1); setPipelines([]);
    loadPipelines(selectedRepo, 1, statusFilter);
  }, [selectedRepo, statusFilter, loadPipelines]);

  // Auto-refresh every 10s while any pipeline is running
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const hasRunning = pipelines.some(p => p.status === 'running' || p.status === 'pending');
    if (hasRunning && selectedRepo) {
      pollRef.current = setInterval(() => loadPipelines(selectedRepo, 1, statusFilter), 10000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pipelines, selectedRepo, statusFilter, loadPipelines]);

  const handleStop = async (p: CiPipeline) => {
    await stopCiPipeline(selectedRepo, p.pipelineId);
    loadPipelines(selectedRepo, 1, statusFilter);
  };

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    loadPipelines(selectedRepo, next, statusFilter, true);
  };

  // No CI configured
  if (!reposLoading && error.includes('No CI provider')) {
    return (
      <div className="p-6 flex items-center justify-center min-h-64">
        <div className="text-center space-y-3">
          <AlertCircle size={32} className="text-[#d29922] mx-auto" />
          <div className="text-sm font-semibold text-[#e6edf3]">CI provider not configured</div>
          <div className="text-xs text-[#8b949e]">Go to Integrations → CI/CD Providers and add a Bitbucket or GitHub token.</div>
        </div>
      </div>
    );
  }

  const STATUS_TABS: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'running', label: 'Running' },
    { id: 'failed', label: 'Failed' },
    { id: 'passed', label: 'Passed' },
    { id: 'stopped', label: 'Stopped' },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-[#e6edf3]">CI/CD Pipelines</h1>
          {workspace && provider && (
            <div className="text-xs text-[#8b949e] mt-0.5">
              {provider === 'bitbucket' ? 'Bitbucket' : 'GitHub'} · {workspace}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadPipelines(selectedRepo, 1, statusFilter)}
            disabled={loading || !selectedRepo}
            className="p-2 rounded-lg text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          {canAct ? (
            <button
              onClick={() => setShowTrigger(true)}
              disabled={!selectedRepo}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-[#238636] text-white hover:bg-[#2ea043] transition-colors disabled:opacity-40"
            >
              <Play size={13} /> Trigger Build
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[#8b949e] bg-[#21262d] border border-[#30363d]">
              <Lock size={11} /> View only
            </div>
          )}
        </div>
      </div>

      {/* Repo + status filters */}
      <div className="flex items-center gap-3 flex-wrap">
        {reposLoading ? (
          <div className="flex items-center gap-2 text-xs text-[#8b949e]">
            <Loader2 size={12} className="animate-spin" /> Loading repos…
          </div>
        ) : (
          <select
            value={selectedRepo}
            onChange={e => setSelectedRepo(e.target.value)}
            className="bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-1.5 text-sm text-[#e6edf3] focus:outline-none focus:border-[#58a6ff] min-w-48"
          >
            {repos.map(r => (
              <option key={r.slug} value={r.slug}>{r.name}</option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1 bg-[#161b22] border border-[#30363d] rounded-lg p-0.5">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={clsx(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                statusFilter === tab.id
                  ? 'bg-[#21262d] text-[#e6edf3]'
                  : 'text-[#8b949e] hover:text-[#e6edf3]',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-[#f85149]/20 bg-[#f85149]/5 px-4 py-3 text-sm text-[#f85149]">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Pipeline list */}
      <div className="space-y-2">
        {!loading && pipelines.length === 0 && !error && selectedRepo && (
          <div className="text-center py-12 text-sm text-[#8b949e]">No pipelines found</div>
        )}
        {pipelines.map(p => (
          <PipelineRow
            key={p.pipelineId}
            pipeline={p}
            repo={selectedRepo}
            provider={provider}
            canAct={canAct}
            onStop={handleStop}
          />
        ))}
        {loading && pipelines.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-[#8b949e]">
            <Loader2 size={14} className="animate-spin" /> Loading pipelines…
          </div>
        )}
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="w-full py-2 text-xs text-[#58a6ff] hover:text-[#79c0ff] transition-colors disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {/* Trigger modal */}
      {showTrigger && (
        <TriggerModal
          repo={selectedRepo}
          branches={branches}
          onClose={() => setShowTrigger(false)}
          onTriggered={() => loadPipelines(selectedRepo, 1, statusFilter)}
        />
      )}
    </div>
  );
}
