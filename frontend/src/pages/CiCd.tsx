// BLY-75 — CI/CD Pipelines page
// Viewer: read-only (view pipelines + logs). Admin/SuperAdmin: trigger + stop.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  ExternalLink, Play, Square, ChevronDown, ChevronRight,
  RefreshCw, CheckCircle2, XCircle, Clock, Minus, Loader2,
  GitBranch, AlertCircle, Lock, Workflow, List, FileText, StopCircle,
  GitCommit, User, GitPullRequest, CalendarClock, Terminal, Zap, type LucideIcon,
} from 'lucide-react';
import {
  getCiRepos, getCiBranches, getCiPipelines, getCiSteps, getCiDeployments,
  triggerCiPipeline, stopCiPipeline, getStepLog, getMe,
} from '../api';
import type { CiRepo, CiPipeline, PipelineStep, MeResponse } from '../api';
import type { Page } from '../App';
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

function triggerLabel(raw: string): { label: string; Icon: LucideIcon } {
  const t = raw.toLowerCase();
  if (t === 'push' || t === 'push_trigger' || t.includes('push')) return { label: 'Push', Icon: Zap };
  if (t === 'pull_request' || t.includes('pr_')) return { label: 'PR', Icon: GitPullRequest };
  if (t === 'manual' || t === 'workflow_dispatch' || t.includes('manual')) return { label: 'Manual', Icon: Play };
  if (t === 'schedule' || t.includes('cron') || t.includes('schedule')) return { label: 'Scheduled', Icon: CalendarClock };
  if (t === 'api' || t.includes('api')) return { label: 'API', Icon: Terminal };
  return { label: raw, Icon: Zap };
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

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    ...(!sameYear && { year: 'numeric' }),
    hour: '2-digit', minute: '2-digit',
  });
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

function envBadge(name: string) {
  const n = name.toLowerCase();
  const cls = n.includes('prod') ? 'text-[#f85149] border-[#f85149]/30 bg-[#f85149]/10'
    : n.includes('stag') ? 'text-[#d29922] border-[#d29922]/30 bg-[#d29922]/10'
    : n.includes('dev') || n.includes('test') ? 'text-[#3fb950] border-[#3fb950]/30 bg-[#3fb950]/10'
    : 'text-[#8b949e] border-[#30363d] bg-[#21262d]';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {name}
    </span>
  );
}

function PipelineRow({ pipeline, repo, provider, canAct, onStop, environment }: {
  pipeline: CiPipeline; repo: string; provider: string;
  canAct: boolean; onStop: (p: CiPipeline) => void; environment?: string;
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

  const { label: tLabel, Icon: TIcon } = triggerLabel(pipeline.triggeredBy);

  return (
    <div className="border border-[#30363d] rounded-lg overflow-hidden">
      {/* Row header */}
      <button
        onClick={toggle}
        className="w-full flex items-start gap-3 px-4 py-3 bg-[#161b22] hover:bg-[#1c2128] transition-colors text-left"
      >
        {/* Chevron */}
        <span className="text-[#8b949e] mt-0.5 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>

        {/* Build # */}
        <span className="text-[#8b949e] font-mono text-xs w-10 shrink-0 mt-0.5">#{pipeline.buildNumber}</span>

        {/* Status badge */}
        <span className="shrink-0 mt-0.5">{statusBadge(pipeline.status)}</span>

        {/* Middle — branch + commit info */}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {/* Branch + SHA */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1 text-xs text-[#e6edf3] font-mono">
              <GitBranch size={11} className="text-[#58a6ff] shrink-0" />
              <span className="truncate max-w-[120px] sm:max-w-none">{pipeline.branch}</span>
            </span>
            {pipeline.commitSha && (
              <span className="flex items-center gap-1 text-[10px] text-[#6e7681] font-mono">
                <GitCommit size={10} className="shrink-0" />
                {pipeline.commitSha}
              </span>
            )}
          </div>
          {/* Commit message */}
          {pipeline.commitMessage && (
            <span className="text-[10px] text-[#8b949e] truncate leading-relaxed">
              {pipeline.commitMessage}
            </span>
          )}
          {/* Trigger user */}
          {pipeline.triggerUser && (
            <span className="flex items-center gap-1 text-[10px] text-[#6e7681]">
              <User size={9} className="shrink-0" />
              {pipeline.triggerUser}
            </span>
          )}
        </div>

        {/* Right meta */}
        <div className="flex flex-col items-end gap-1 shrink-0 ml-auto">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#8b949e]">{fmtDuration(pipeline.durationSeconds)}</span>
            <span className="text-[10px] text-[#8b949e]">{timeAgo(pipeline.createdAt)}</span>
          </div>
          <div className="text-[10px] text-[#6e7681] text-right">{fmtDate(pipeline.createdAt)}</div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {environment && envBadge(environment)}
            <span className="flex items-center gap-1 text-[10px] text-[#6e7681] bg-[#21262d] border border-[#30363d] px-1.5 py-0.5 rounded">
              <TIcon size={9} />
              {tLabel}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0 mt-0.5" onClick={e => e.stopPropagation()}>
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

// ── Environment inference ─────────────────────────────────────────────────────

function branchToEnv(branch: string): { label: string; color: string; dot: string } {
  const b = branch.toLowerCase();
  if (b === 'main' || b === 'master') return { label: 'Production', color: 'text-[#f85149]', dot: 'bg-[#f85149]' };
  if (b.startsWith('release/') || b.startsWith('release-')) return { label: 'Release', color: 'text-[#d29922]', dot: 'bg-[#d29922]' };
  if (b === 'staging' || b === 'stage' || b.startsWith('staging/')) return { label: 'Staging', color: 'text-[#d29922]', dot: 'bg-[#d29922]' };
  if (b === 'develop' || b === 'dev' || b === 'development' || b.startsWith('dev/')) return { label: 'Development', color: 'text-[#3fb950]', dot: 'bg-[#3fb950]' };
  if (b.startsWith('feat/') || b.startsWith('feature/')) return { label: 'Feature branch', color: 'text-[#bc8cff]', dot: 'bg-[#bc8cff]' };
  if (b.startsWith('fix/') || b.startsWith('hotfix/')) return { label: 'Hotfix', color: 'text-[#ff7b72]', dot: 'bg-[#ff7b72]' };
  return { label: 'Custom', color: 'text-[#8b949e]', dot: 'bg-[#8b949e]' };
}

// ── TriggerModal ──────────────────────────────────────────────────────────────

function TriggerModal({ repo, branches, branchEnvMap, onClose, onTriggered }: {
  repo: string; branches: string[]; branchEnvMap: Record<string, string>;
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
          {/* Environment — real data from Bitbucket deployments, fallback to name inference */}
          {branch && (() => {
            const realEnv = branchEnvMap[branch]; // from actual deployment history
            if (realEnv) {
              // Real environment from Bitbucket's deployments API
                const n = realEnv.toLowerCase();
              const color = n.includes('prod') ? 'text-[#f85149]' : n.includes('stag') ? 'text-[#d29922]' : n.includes('dev') || n.includes('test') ? 'text-[#3fb950]' : 'text-[#8b949e]';
              const dot = n.includes('prod') ? 'bg-[#f85149]' : n.includes('stag') ? 'bg-[#d29922]' : n.includes('dev') || n.includes('test') ? 'bg-[#3fb950]' : 'bg-[#8b949e]';
              return (
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[10px] text-[#6e7681]">Deploys to</span>
                  <span className={`flex items-center gap-1.5 text-[11px] font-medium ${color}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${dot} animate-pulse`} />
                    {realEnv}
                  </span>
                </div>
              );
            }
            // Fallback: infer from branch name (GitHub / branches not yet deployed)
            const env = branchToEnv(branch);
            return (
              <div className="flex items-center justify-between pt-1">
                <span className="text-[10px] text-[#6e7681]">Deploys to</span>
                <span className={`flex items-center gap-1.5 text-[11px] font-medium ${env.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${env.dot} animate-pulse`} />
                  {env.label}
                  <span className="text-[#6e7681] font-normal">(inferred)</span>
                </span>
              </div>
            );
          })()}
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

export default function CiCd({ onNavigate }: { onNavigate?: (p: Page) => void }) {
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
  const [reposError, setReposError] = useState('');
  const [error, setError] = useState('');
  const [showTrigger, setShowTrigger] = useState(false);
  const [envMap, setEnvMap] = useState<Record<string, string>>({});
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
      .catch(() => setReposError('not_configured'))
      .finally(() => setReposLoading(false));
  }, []);

  // Load branches when repo changes
  useEffect(() => {
    if (!selectedRepo) return;
    getCiBranches(selectedRepo).then(r => setBranches(r.branches)).catch(() => setBranches([]));
  }, [selectedRepo]);

  // Load deployment→environment map (Bitbucket only; no-ops for GitHub)
  useEffect(() => {
    if (!selectedRepo) return;
    setEnvMap({});
    getCiDeployments(selectedRepo)
      .then(r => {
        const map: Record<string, string> = {};
        r.deployments.forEach(d => { map[d.pipelineId] = d.environment; });
        setEnvMap(map);
      })
      .catch(() => {});
  }, [selectedRepo]);

  // Derive branch→environment from deployment history (pipelines ordered newest-first, so first match wins)
  const branchEnvMap = useMemo(() => {
    const map: Record<string, string> = {};
    pipelines.forEach(p => { if (envMap[p.pipelineId] && !map[p.branch]) map[p.branch] = envMap[p.pipelineId]; });
    return map;
  }, [pipelines, envMap]);

  // Load pipelines
  const loadPipelines = useCallback(async (repo: string, pg: number, filter: StatusFilter, append = false) => {
    if (!repo) return;
    setLoading(true); setError('');
    try {
      const r = await getCiPipelines(repo, pg, undefined);
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

  // Bitbucket not configured — show friendly onboarding state
  if (!reposLoading && reposError) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[calc(100vh-4rem)]">
        <div className="max-w-md w-full text-center space-y-6">
          {/* Icon */}
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-2xl bg-[#58a6ff]/10 border border-[#58a6ff]/20 flex items-center justify-center">
              <Workflow size={28} className="text-[#58a6ff]" />
            </div>
          </div>

          {/* Heading */}
          <div className="space-y-2">
            <h2 className="text-base font-semibold text-[#e6edf3]">Bitbucket CI/CD not configured</h2>
            <p className="text-sm text-[#8b949e] leading-relaxed">
              Connect your Bitbucket workspace to monitor and manage pipelines directly from this dashboard — no more tab-switching.
            </p>
          </div>

          {/* Feature list */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-4 text-left space-y-3">
            <div className="text-[10px] uppercase tracking-widest text-[#6e7681] font-semibold">What you'll get</div>
            {[
              { Icon: List,        text: 'All pipeline runs across every repository, with status and duration' },
              { Icon: FileText,    text: 'Step-by-step build logs — drill into any step inline without leaving the page' },
              { Icon: Play,        text: 'Trigger a new build on any branch with one click (Admin+)' },
              { Icon: StopCircle, text: 'Stop a running pipeline instantly (Admin+)' },
            ].map(({ Icon, text }) => (
              <div key={text} className="flex items-start gap-3">
                <Icon size={14} className="text-[#58a6ff] shrink-0 mt-0.5" />
                <span className="text-xs text-[#8b949e] leading-relaxed">{text}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          {me?.role === 'superadmin' ? (
            <button
              onClick={() => onNavigate?.('integrations')}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-[#58a6ff] text-[#0d1117] hover:bg-[#79c0ff] transition-colors"
            >
              Configure in Integrations →
            </button>
          ) : (
            <p className="text-xs text-[#6e7681]">
              Ask your <span className="text-[#bc8cff]">SuperAdmin</span> to add a Bitbucket API token under Integrations → CI/CD Providers.
            </p>
          )}
        </div>
      </div>
    );
  }

  const displayPipelines = statusFilter === 'all'
    ? pipelines
    : pipelines.filter(p => p.status === statusFilter);

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

      {/* Stats strip */}
      {displayPipelines.length > 0 && (() => {
        const counts = displayPipelines.reduce((acc, p) => { acc[p.status] = (acc[p.status] ?? 0) + 1; return acc; }, {} as Record<string, number>);
        const withDur = displayPipelines.filter(p => p.durationSeconds != null);
        const avgSecs = withDur.length > 0 ? Math.round(withDur.reduce((s, p) => s + (p.durationSeconds ?? 0), 0) / withDur.length) : null;
        const passRate = displayPipelines.length > 0 ? Math.round(((counts.passed ?? 0) / displayPipelines.length) * 100) : null;
        return (
          <div className="flex items-center gap-3 text-[10px] px-1 flex-wrap">
            <span className="text-[#6e7681]">{displayPipelines.length} build{displayPipelines.length !== 1 ? 's' : ''}</span>
            {(counts.passed ?? 0) > 0 && <span className="flex items-center gap-1 text-[#3fb950]"><CheckCircle2 size={10} /> {counts.passed} passed</span>}
            {(counts.failed ?? 0) > 0 && <span className="flex items-center gap-1 text-[#f85149]"><XCircle size={10} /> {counts.failed} failed</span>}
            {(counts.running ?? 0) > 0 && <span className="flex items-center gap-1 text-[#58a6ff]"><Loader2 size={10} className="animate-spin" /> {counts.running} running</span>}
            {(counts.stopped ?? 0) > 0 && <span className="flex items-center gap-1 text-[#8b949e]"><Minus size={10} /> {counts.stopped} stopped</span>}
            {passRate != null && <span className="text-[#6e7681] ml-1">· {passRate}% pass rate</span>}
            {avgSecs != null && <span className="text-[#6e7681]">· avg {fmtDuration(avgSecs)}</span>}
          </div>
        );
      })()}

      {/* Pipeline list */}
      <div className="space-y-2">
        {!loading && displayPipelines.length === 0 && !error && selectedRepo && (
          <div className="text-center py-12 text-sm text-[#8b949e]">No pipelines found</div>
        )}
        {displayPipelines.map(p => (
          <PipelineRow
            key={p.pipelineId}
            pipeline={p}
            repo={selectedRepo}
            provider={provider}
            canAct={canAct}
            onStop={handleStop}
            environment={envMap[p.pipelineId]}
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
          branchEnvMap={branchEnvMap}
          onClose={() => setShowTrigger(false)}
          onTriggered={() => loadPipelines(selectedRepo, 1, statusFilter)}
        />
      )}
    </div>
  );
}
