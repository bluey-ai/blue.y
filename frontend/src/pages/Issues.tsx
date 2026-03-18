// @premium — BlueOnion internal only. BLY-84
import { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle, RefreshCw, Plus, ChevronRight, X, Send, Clock, User, Flag,
  CheckCircle, Circle, Loader, AlertCircle, XCircle, Eye,
} from 'lucide-react';
import {
  getIssues, createIssue, getIssueDetail, updateIssueStatus, assignIssueToMe, addIssueComment, getMe,
} from '../api';
import type { OpsIssue, OpsIssueComment, OpsIssueTimelineEntry, IssueStatus, IssueSeverity, IssueStats, MeResponse } from '../api';
import Card from '../components/Card';
import Badge from '../components/Badge';
import { formatDistanceToNow, parseISO } from 'date-fns';
import clsx from 'clsx';

// ── Role helpers ──────────────────────────────────────────────────────────────
const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, developer: 1.5, viewer: 1 };
function hasRole(me: MeResponse | null, minRole: string) {
  return (ROLE_RANK[me?.role ?? ''] ?? 0) >= (ROLE_RANK[minRole] ?? 99);
}

// ── Severity & status config ──────────────────────────────────────────────────
const SEV_VARIANTS: Record<IssueSeverity, 'critical' | 'warning' | 'info' | 'muted'> = {
  critical: 'critical', high: 'warning', medium: 'info', low: 'muted',
};

const STATUS_CONFIG: Record<IssueStatus, { label: string; icon: React.ElementType; color: string }> = {
  open:          { label: 'Open',          icon: Circle,        color: 'text-[#f85149]' },
  acknowledged:  { label: 'Acknowledged',  icon: Eye,           color: 'text-[#d29922]' },
  in_progress:   { label: 'In Progress',   icon: Loader,        color: 'text-[#58a6ff]' },
  needs_review:  { label: 'Needs Review',  icon: AlertCircle,   color: 'text-[#bc8cff]' },
  resolved:      { label: 'Resolved',      icon: CheckCircle,   color: 'text-[#3fb950]' },
  wont_fix:      { label: "Won't Fix",     icon: XCircle,       color: 'text-[#8b949e]'  },
};

// Admin status transitions (what each status can move to)
const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open:         ['acknowledged', 'wont_fix'],
  acknowledged: ['in_progress', 'wont_fix'],
  in_progress:  ['needs_review', 'resolved', 'wont_fix'],
  needs_review: ['resolved', 'in_progress', 'wont_fix'],
  resolved:     [],
  wont_fix:     [],
};

const CLOSE_STATUSES: IssueStatus[] = ['resolved', 'wont_fix'];

function fmtAge(ts: string) {
  try { return formatDistanceToNow(parseISO(ts), { addSuffix: true }); } catch { return ts; }
}

// ── Raise Issue Modal ─────────────────────────────────────────────────────────
function RaiseIssueModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ title: '', description: '', severity: 'medium' as IssueSeverity });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!form.title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    try {
      await createIssue({ ...form, source_type: 'manual' });
      onCreated();
    } catch (e: any) {
      setError(e.message || 'Failed to create issue');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-lg mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d]">
          <div className="flex items-center gap-2">
            <Flag size={16} className="text-[#f85149]" />
            <span className="font-semibold text-[#e6edf3] text-sm">Raise Ops Issue</span>
          </div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3]"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-[#8b949e] mb-1.5">Title <span className="text-[#f85149]">*</span></label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Short description of the problem"
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff]"
            />
          </div>
          <div>
            <label className="block text-xs text-[#8b949e] mb-1.5">Severity</label>
            <select
              value={form.severity}
              onChange={e => setForm(f => ({ ...f, severity: e.target.value as IssueSeverity }))}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#8b949e] mb-1.5">Description</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Describe the problem, steps to reproduce, impact..."
              rows={4}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-sm text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-none"
            />
          </div>
          {error && <p className="text-xs text-[#f85149]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[#30363d]">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3]">Cancel</button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-[#f85149] text-white rounded-md hover:bg-[#da3633] disabled:opacity-50 transition-colors"
          >
            {saving ? 'Raising…' : 'Raise Issue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Issue Detail Drawer ───────────────────────────────────────────────────────
function IssueDrawer({
  issue, me, onClose, onUpdated,
}: {
  issue: OpsIssue; me: MeResponse | null; onClose: () => void; onUpdated: () => void;
}) {
  const [comments, setComments] = useState<OpsIssueComment[]>([]);
  const [timeline, setTimeline] = useState<OpsIssueTimelineEntry[]>([]);
  const [current, setCurrent] = useState<OpsIssue>(issue);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveInput, setShowResolveInput] = useState<IssueStatus | null>(null);
  const [working, setWorking] = useState(false);
  const isAdmin = hasRole(me, 'admin');

  const load = useCallback(async () => {
    try {
      const r = await getIssueDetail(current.id);
      setCurrent(r.issue);
      setComments(r.comments);
      setTimeline(r.timeline);
    } catch { /* ignore */ }
  }, [current.id]);

  useEffect(() => { load(); }, [load]);

  const handleAssign = async () => {
    setWorking(true);
    try { await assignIssueToMe(current.id); await load(); onUpdated(); } finally { setWorking(false); }
  };

  const handleStatus = async (status: IssueStatus) => {
    if (CLOSE_STATUSES.includes(status) && !resolutionNote.trim()) {
      setShowResolveInput(status); return;
    }
    setWorking(true);
    try {
      await updateIssueStatus(current.id, status, resolutionNote || undefined);
      setResolutionNote(''); setShowResolveInput(null);
      await load(); onUpdated();
    } finally { setWorking(false); }
  };

  const handleComment = async () => {
    if (!commentText.trim()) return;
    setSending(true);
    try {
      const c = await addIssueComment(current.id, commentText.trim());
      setComments(cs => [...cs, c]);
      setCommentText('');
    } finally { setSending(false); }
  };

  const sc = STATUS_CONFIG[current.status];
  const StatusIcon = sc.icon;
  const transitions = TRANSITIONS[current.status];

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-xl bg-[#161b22] border-l border-[#30363d] flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#30363d]">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge label={current.severity} variant={SEV_VARIANTS[current.severity]} size="xs" />
              <span className={clsx('flex items-center gap-1 text-[10px] font-medium', sc.color)}>
                <StatusIcon size={10} /> {sc.label}
              </span>
            </div>
            <h2 className="text-sm font-semibold text-[#e6edf3] leading-snug">{current.title}</h2>
            <p className="text-[10px] text-[#8b949e] mt-0.5">
              #{current.id} · raised by {current.raised_by_name} · {fmtAge(current.created_at)}
            </p>
          </div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] shrink-0 mt-0.5"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Source + assigned */}
          <div className="px-5 py-3 border-b border-[#30363d] space-y-2">
            {current.source_name && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-[#8b949e] w-20 shrink-0">Resource</span>
                <code className="text-[#58a6ff] bg-[#0d1117] px-1.5 py-0.5 rounded text-[10px]">
                  {current.source_namespace ? `${current.source_namespace}/` : ''}{current.source_name}
                </code>
              </div>
            )}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#8b949e] w-20 shrink-0">Assigned to</span>
              {current.assigned_to_name ? (
                <span className="flex items-center gap-1 text-[#e6edf3]">
                  <User size={10} /> {current.assigned_to_name}
                </span>
              ) : (
                <span className="text-[#484f58]">Unassigned</span>
              )}
              {isAdmin && !current.assigned_to_id && (
                <button
                  onClick={handleAssign} disabled={working}
                  className="ml-auto text-[10px] text-[#58a6ff] hover:underline"
                >
                  Assign to me
                </button>
              )}
            </div>
            {current.resolution_notes && (
              <div className="flex gap-2 text-xs">
                <span className="text-[#8b949e] w-20 shrink-0">Resolution</span>
                <span className="text-[#e6edf3]">{current.resolution_notes}</span>
              </div>
            )}
          </div>

          {/* Description */}
          {current.description && (
            <div className="px-5 py-3 border-b border-[#30363d]">
              <p className="text-xs text-[#8b949e] mb-1.5">Description</p>
              <p className="text-sm text-[#e6edf3] whitespace-pre-wrap leading-relaxed">{current.description}</p>
            </div>
          )}

          {/* AI Diagnosis snapshot */}
          {current.ai_diagnosis && (
            <div className="px-5 py-3 border-b border-[#30363d]">
              <p className="text-xs text-[#8b949e] mb-1.5">AI Diagnosis (at creation)</p>
              <p className="text-xs text-[#e6edf3] whitespace-pre-wrap leading-relaxed font-mono bg-[#0d1117] rounded-md p-3">
                {current.ai_diagnosis}
              </p>
            </div>
          )}

          {/* Admin actions */}
          {isAdmin && transitions.length > 0 && (
            <div className="px-5 py-3 border-b border-[#30363d]">
              <p className="text-xs text-[#8b949e] mb-2">Update Status</p>
              {showResolveInput ? (
                <div className="space-y-2">
                  <textarea
                    value={resolutionNote}
                    onChange={e => setResolutionNote(e.target.value)}
                    placeholder="Resolution notes required..."
                    rows={2}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStatus(showResolveInput)} disabled={working || !resolutionNote.trim()}
                      className="px-3 py-1.5 text-xs font-medium bg-[#3fb950] text-[#0d1117] rounded hover:bg-[#2ea043] disabled:opacity-50"
                    >
                      {STATUS_CONFIG[showResolveInput].label}
                    </button>
                    <button onClick={() => setShowResolveInput(null)} className="text-xs text-[#8b949e] hover:text-[#e6edf3]">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {transitions.map(s => {
                    const c = STATUS_CONFIG[s];
                    const Icon = c.icon;
                    return (
                      <button
                        key={s}
                        onClick={() => handleStatus(s)}
                        disabled={working}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[#30363d] rounded-md text-[#e6edf3] hover:bg-[#21262d] hover:border-[#58a6ff] disabled:opacity-50 transition-colors"
                      >
                        <Icon size={11} className={c.color} /> {c.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Comments */}
          <div className="px-5 py-3 border-b border-[#30363d]">
            <p className="text-xs text-[#8b949e] mb-3">Comments ({comments.length})</p>
            <div className="space-y-3">
              {comments.map(c => (
                <div key={c.id} className="flex gap-2.5">
                  <div className="w-6 h-6 rounded-full bg-[#21262d] border border-[#30363d] flex items-center justify-center shrink-0 mt-0.5">
                    <User size={10} className="text-[#8b949e]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-medium text-[#e6edf3]">{c.author_name}</span>
                      <span className="text-[10px] text-[#484f58]">{fmtAge(c.created_at)}</span>
                    </div>
                    <p className="text-xs text-[#8b949e] whitespace-pre-wrap">{c.content}</p>
                  </div>
                </div>
              ))}
              {comments.length === 0 && <p className="text-xs text-[#484f58]">No comments yet.</p>}
            </div>
          </div>

          {/* Add comment */}
          <div className="px-5 py-3 border-b border-[#30363d]">
            <div className="flex gap-2">
              <textarea
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
                className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-md px-3 py-2 text-xs text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-none"
              />
              <button
                onClick={handleComment} disabled={sending || !commentText.trim()}
                className="self-end p-2 rounded-md bg-[#21262d] text-[#58a6ff] hover:bg-[#30363d] disabled:opacity-50"
              >
                <Send size={13} />
              </button>
            </div>
          </div>

          {/* Timeline */}
          {timeline.length > 0 && (
            <div className="px-5 py-3">
              <p className="text-xs text-[#8b949e] mb-3">Timeline</p>
              <div className="space-y-2.5">
                {timeline.map(t => (
                  <div key={t.id} className="flex items-start gap-2 text-[11px] text-[#8b949e]">
                    <Clock size={10} className="mt-0.5 shrink-0" />
                    <span>
                      <span className="text-[#e6edf3] font-medium">{t.actor_name}</span>
                      {t.note ? ` — ${t.note}` : ` moved to `}
                      {!t.note && (
                        <span className={clsx('font-medium', STATUS_CONFIG[t.to_status as IssueStatus]?.color ?? 'text-[#e6edf3]')}>
                          {STATUS_CONFIG[t.to_status as IssueStatus]?.label ?? t.to_status}
                        </span>
                      )}
                      <span className="text-[#484f58]"> · {fmtAge(t.created_at)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Issues page ──────────────────────────────────────────────────────────
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'needs_review', label: 'Needs Review' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'wont_fix', label: "Won't Fix" },
];

export default function Issues() {
  const [issues, setIssues] = useState<OpsIssue[]>([]);
  const [stats, setStats] = useState<IssueStats | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [sevFilter, setSevFilter] = useState('');
  const [selected, setSelected] = useState<OpsIssue | null>(null);
  const [showRaise, setShowRaise] = useState(false);

  useEffect(() => { getMe().then(setMe).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getIssues({ status: statusFilter || undefined, severity: sevFilter || undefined });
      setIssues(r.issues);
      setStats(r.stats);
    } finally { setLoading(false); }
  }, [statusFilter, sevFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Ops Issues</h1>
          <p className="text-sm text-[#8b949e] mt-0.5">Raise, track, and resolve infrastructure issues across all roles</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-1.5 rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors">
            <RefreshCw size={14} className={clsx(loading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowRaise(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#f85149] text-white rounded-md hover:bg-[#da3633] transition-colors"
          >
            <Plus size={12} /> Raise Issue
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Open',        value: stats.open,          color: 'text-[#f85149]' },
            { label: 'In Progress', value: stats.in_progress,   color: 'text-[#58a6ff]' },
            { label: 'Resolved (7d)', value: stats.resolved_week, color: 'text-[#3fb950]' },
          ].map(s => (
            <Card key={s.label}>
              <div className={clsx('text-2xl font-bold', s.color)}>{s.value}</div>
              <div className="text-xs text-[#8b949e] mt-0.5">{s.label}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-[#21262d] border border-[#30363d] rounded-md px-2.5 py-1.5 text-xs text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
        >
          {STATUS_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select
          value={sevFilter}
          onChange={e => setSevFilter(e.target.value)}
          className="bg-[#21262d] border border-[#30363d] rounded-md px-2.5 py-1.5 text-xs text-[#e6edf3] focus:outline-none focus:border-[#58a6ff]"
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {/* Issue List */}
      <Card padding={false}>
        {loading && issues.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-[#8b949e] text-sm">
            <RefreshCw size={14} className="animate-spin mr-2" /> Loading issues…
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertTriangle size={32} className="text-[#484f58] mb-3" />
            <p className="text-sm text-[#8b949e]">No issues found</p>
            <p className="text-xs text-[#484f58] mt-1">Raise an issue from any unhealthy resource, or use the button above.</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#30363d]">
                {['Severity', 'Title', 'Source', 'Raised by', 'Assigned to', 'Status', 'Age', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] text-[#8b949e] font-medium uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262d]">
              {issues.map(issue => {
                const sc = STATUS_CONFIG[issue.status];
                const StatusIcon = sc.icon;
                return (
                  <tr
                    key={issue.id}
                    onClick={() => setSelected(issue)}
                    className="hover:bg-[#21262d] cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Badge label={issue.severity} variant={SEV_VARIANTS[issue.severity]} size="xs" />
                    </td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <span className="text-[#e6edf3] font-medium truncate block">{issue.title}</span>
                      <span className="text-[#484f58] text-[10px]">#{issue.id}</span>
                    </td>
                    <td className="px-4 py-3 max-w-[140px]">
                      {issue.source_name ? (
                        <code className="text-[#58a6ff] text-[10px] truncate block">
                          {issue.source_namespace ? `${issue.source_namespace}/` : ''}{issue.source_name}
                        </code>
                      ) : (
                        <span className="text-[#484f58]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[#8b949e]">{issue.raised_by_name}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {issue.assigned_to_name ? (
                        <span className="flex items-center gap-1 text-[#e6edf3]">
                          <User size={10} /> {issue.assigned_to_name}
                        </span>
                      ) : (
                        <span className="text-[#484f58]">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={clsx('flex items-center gap-1 font-medium', sc.color)}>
                        <StatusIcon size={10} /> {sc.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[#484f58]">{fmtAge(issue.created_at)}</td>
                    <td className="px-4 py-3">
                      <ChevronRight size={12} className="text-[#484f58]" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Modals */}
      {showRaise && (
        <RaiseIssueModal
          onClose={() => setShowRaise(false)}
          onCreated={() => { setShowRaise(false); load(); }}
        />
      )}
      {selected && (
        <IssueDrawer
          issue={selected}
          me={me}
          onClose={() => setSelected(null)}
          onUpdated={() => { load(); }}
        />
      )}
    </div>
  );
}
