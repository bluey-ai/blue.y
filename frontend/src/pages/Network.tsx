import { useEffect, useState, useCallback, Fragment } from 'react';
import {
  Network as NetworkIcon, RefreshCw, Plus, Edit3, Trash2, ChevronDown, ChevronRight,
  Shield, Globe, Server, AlertTriangle, CheckCircle, Clock, X, Save, Copy, ExternalLink,
  Activity, Boxes, Zap, Brain, TrendingUp,
} from 'lucide-react';
import clsx from 'clsx';
import Card from '../components/Card';
import Badge from '../components/Badge';
import {
  getNetworkHealth, getIngresses, createIngress, updateIngress, deleteIngress,
  getServices, createService, updateService, deleteService, getNetworkPolicies,
  getAlbInfo, diagnoseRoute,
  type IngressInfo, type ServiceInfo, type NetworkPolicyInfo, type RouteHealth, type RouteHealthSummary,
  type AlbInfo, type RouteDiagnosis,
} from '../api';
import { ForbiddenError } from '../api';

const NAMESPACES = ['prod', 'dev', 'monitoring', 'doris', 'wordpress'];
type Tab = 'health' | 'ingresses' | 'services' | 'policies';

// ── Health colour helpers ─────────────────────────────────────────────────────
const HEALTH_COLOR = { green: '#3fb950', yellow: '#d29922', red: '#f85149' } as const;
const HEALTH_BG    = { green: 'bg-[#3fb950]/10 border-[#3fb950]/20', yellow: 'bg-[#d29922]/10 border-[#d29922]/20', red: 'bg-[#f85149]/10 border-[#f85149]/20' };
const HEALTH_TEXT  = { green: 'text-[#3fb950]', yellow: 'text-[#d29922]', red: 'text-[#f85149]' };

const SVC_TYPE_VARIANT: Record<string, 'info' | 'warning' | 'success' | 'purple' | 'muted'> = {
  ClusterIP:    'info',
  NodePort:     'warning',
  LoadBalancer: 'success',
  ExternalName: 'purple',
  Headless:     'muted',
};

const TLS_VARIANT: Record<string, 'muted' | 'success' | 'warning' | 'critical'> = {
  none:           'muted',
  valid:          'success',
  expiring:       'warning',
  expired:        'critical',
  'missing-secret': 'critical',
};

const INGRESS_TEMPLATE = JSON.stringify({
  apiVersion: 'networking.k8s.io/v1',
  kind: 'Ingress',
  metadata: {
    name: 'my-ingress',
    namespace: 'prod',
    annotations: { 'kubernetes.io/ingress.class': 'nginx' },
  },
  spec: {
    rules: [{
      host: 'example.com',
      http: {
        paths: [{
          path: '/',
          pathType: 'Prefix',
          backend: { service: { name: 'my-service', port: { number: 80 } } },
        }],
      },
    }],
  },
}, null, 2);

const SERVICE_TEMPLATE = JSON.stringify({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name: 'my-service', namespace: 'prod' },
  spec: {
    selector: { app: 'my-app' },
    ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }],
    type: 'ClusterIP',
  },
}, null, 2);

// ── Small components ──────────────────────────────────────────────────────────
function HealthDot({ health }: { health: 'green' | 'yellow' | 'red' }) {
  return (
    <span
      className={clsx('inline-block w-2 h-2 rounded-full shrink-0', {
        'bg-[#3fb950]': health === 'green',
        'bg-[#d29922]': health === 'yellow',
        'bg-[#f85149]': health === 'red',
      })}
    />
  );
}

function SummaryCard({ label, value, sub, color }: { label: string; value: number; sub?: string; color?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 flex flex-col gap-1">
      <span className="text-[#6e7681] text-xs">{label}</span>
      <span className={clsx('text-2xl font-bold', color ?? 'text-[#e6edf3]')}>{value}</span>
      {sub && <span className="text-[10px] text-[#6e7681]">{sub}</span>}
    </div>
  );
}

// ── Edit/Create modal ─────────────────────────────────────────────────────────
interface EditModalProps {
  title: string;
  initial: string;
  onSave: (json: object) => Promise<void>;
  onClose: () => void;
}
function EditModal({ title, initial, onSave, onClose }: EditModalProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    try {
      const parsed = JSON.parse(value);
      setError('');
      setSaving(true);
      await onSave(parsed);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Invalid JSON');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#30363d]">
          <span className="font-semibold text-[#e6edf3] text-sm">{title}</span>
          <button onClick={onClose} className="text-[#6e7681] hover:text-[#e6edf3] transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 p-5 overflow-auto">
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            spellCheck={false}
            className="w-full h-80 bg-[#0d1117] border border-[#30363d] rounded-lg p-3 text-xs font-mono text-[#e6edf3] outline-none resize-none focus:border-[#2dd4bf]/50 transition-colors"
          />
          {error && (
            <p className="mt-2 text-xs text-[#f85149]">{error}</p>
          )}
          <p className="mt-2 text-[10px] text-[#6e7681]">
            Edit the JSON spec directly. The full object including <code className="text-[#79c0ff]">metadata.resourceVersion</code> must be preserved when updating.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-[#30363d]">
          <button onClick={onClose} className="px-4 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 border border-[#2dd4bf]/30 rounded-md text-xs text-[#2dd4bf] font-medium transition-colors disabled:opacity-50"
          >
            <Save size={12} />
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Delete confirmation modal ─────────────────────────────────────────────────
interface DeleteModalProps { name: string; kind: string; onConfirm: () => Promise<void>; onClose: () => void; }
function DeleteModal({ name, kind, onConfirm, onClose }: DeleteModalProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const handle = async () => {
    setDeleting(true);
    try { await onConfirm(); onClose(); }
    catch (e: any) { setError(e?.message || String(e)); setDeleting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#161b22] border border-[#30363d] rounded-xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="text-[#f85149] shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-[#e6edf3] text-sm">Delete {kind}</p>
            <p className="text-xs text-[#8b949e] mt-1">
              Are you sure you want to delete <span className="text-[#e6edf3] font-mono">{name}</span>?
              This action cannot be undone.
            </p>
          </div>
        </div>
        {error && <p className="text-xs text-[#f85149]">{error}</p>}
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-1.5 text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors">Cancel</button>
          <button
            onClick={handle}
            disabled={deleting}
            className="px-4 py-1.5 bg-[#f85149]/10 hover:bg-[#f85149]/20 border border-[#f85149]/30 rounded-md text-xs text-[#f85149] font-medium transition-colors disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Health Tab ────────────────────────────────────────────────────────────────
const CONFIDENCE_COLOR = { high: 'text-[#3fb950]', medium: 'text-[#d29922]', low: 'text-[#f85149]' } as const;
const SEVERITY_BG = {
  critical: 'bg-[#f85149]/10 border-[#f85149]/20',
  warning:  'bg-[#d29922]/10 border-[#d29922]/20',
  info:     'bg-[#2dd4bf]/10 border-[#2dd4bf]/20',
} as const;

function HealthTab({ namespace, isAdmin }: { namespace: string; isAdmin: boolean }) {
  const [routes, setRoutes] = useState<RouteHealth[]>([]);
  const [summary, setSummary] = useState<RouteHealthSummary | null>(null);
  const [albs, setAlbs] = useState<AlbInfo[]>([]);
  const [ingresses, setIngresses] = useState<IngressInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [diagnoses, setDiagnoses] = useState<Record<string, RouteDiagnosis>>({});
  const [diagnosing, setDiagnosing] = useState<Set<string>>(new Set());
  const [editModal, setEditModal] = useState<IngressInfo | null>(null);
  const [deleteModal, setDeleteModal] = useState<IngressInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [healthRes, albRes, ingressRes] = await Promise.all([
        getNetworkHealth(namespace),
        getAlbInfo(namespace).catch(() => ({ albs: [] as AlbInfo[], namespace })),
        getIngresses(namespace).catch(() => ({ ingresses: [] as IngressInfo[] })),
      ]);
      setRoutes(healthRes.routes);
      setSummary(healthRes.summary);
      setAlbs(albRes.albs);
      setIngresses(ingressRes.ingresses);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [namespace]);

  useEffect(() => { load(); }, [load]);

  const handleDiagnose = async (ingressName: string) => {
    const key = `${namespace}/${ingressName}`;
    setDiagnosing(prev => new Set(prev).add(key));
    try {
      const res = await diagnoseRoute(ingressName, namespace);
      setDiagnoses(prev => ({ ...prev, [key]: res.diagnosis }));
    } catch (e: any) {
      setDiagnoses(prev => ({
        ...prev,
        [key]: { rootCause: e?.message || 'Diagnosis failed', confidence: 'low', breakpoint: 'unknown', severity: 'warning', suggestions: [] },
      }));
    } finally {
      setDiagnosing(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  };

  const handleEditSave = async (body: object) => {
    if (!editModal) return;
    await updateIngress(editModal.namespace, editModal.name, body);
    await load();
  };

  const handleDeleteConfirm = async () => {
    if (!deleteModal) return;
    await deleteIngress(deleteModal.namespace, deleteModal.name);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#6e7681]">Full Ingress → Service → Endpoints chain walk</span>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#2dd4bf] transition-colors disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* ALB Panel */}
      {albs.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider flex items-center gap-1.5">
            <TrendingUp size={10} /> AWS Load Balancer — CloudWatch metrics (last 1h)
          </p>
          {albs.map(alb => (
            <div key={alb.hostname} className="bg-[#161b22] border border-[#30363d] rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <span className="font-mono text-xs text-[#2dd4bf] font-semibold">{alb.lbName}</span>
                  <span className="text-[#6e7681] text-[10px] ml-2">{alb.region}</span>
                </div>
                <span className="font-mono text-[10px] text-[#6e7681] truncate max-w-xs">{alb.hostname}</span>
              </div>
              {alb.usedBy.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {alb.usedBy.map(h => (
                    <span key={h} className="text-[10px] bg-[#21262d] text-[#8b949e] border border-[#30363d] rounded px-1.5 py-0.5 font-mono">{h}</span>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <div className="bg-[#0d1117] rounded p-2">
                  <p className="text-[10px] text-[#6e7681]">Requests</p>
                  <p className="text-sm font-bold text-[#e6edf3]">{alb.requestCount != null ? alb.requestCount.toLocaleString() : '—'}</p>
                </div>
                <div className="bg-[#0d1117] rounded p-2">
                  <p className="text-[10px] text-[#6e7681]">5xx Errors</p>
                  <p className={clsx('text-sm font-bold', (alb.errors5xx ?? 0) > 0 ? 'text-[#f85149]' : 'text-[#e6edf3]')}>{alb.errors5xx ?? '—'}</p>
                </div>
                <div className="bg-[#0d1117] rounded p-2">
                  <p className="text-[10px] text-[#6e7681]">4xx Errors</p>
                  <p className={clsx('text-sm font-bold', (alb.errors4xx ?? 0) > 100 ? 'text-[#d29922]' : 'text-[#e6edf3]')}>{alb.errors4xx ?? '—'}</p>
                </div>
                <div className="bg-[#0d1117] rounded p-2">
                  <p className="text-[10px] text-[#6e7681]">Avg Latency</p>
                  <p className={clsx('text-sm font-bold', (alb.latencyMs ?? 0) > 1000 ? 'text-[#d29922]' : 'text-[#e6edf3]')}>
                    {alb.latencyMs != null ? `${Math.round(alb.latencyMs)}ms` : '—'}
                  </p>
                </div>
              </div>
              {alb.errorRate5xx != null && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-[#21262d] rounded-full overflow-hidden">
                    <div
                      className={clsx('h-full rounded-full transition-all', alb.errorRate5xx > 5 ? 'bg-[#f85149]' : alb.errorRate5xx > 1 ? 'bg-[#d29922]' : 'bg-[#3fb950]')}
                      style={{ width: `${Math.min(alb.errorRate5xx, 100)}%` }}
                    />
                  </div>
                  <span className={clsx('text-[10px] font-mono shrink-0', alb.errorRate5xx > 5 ? 'text-[#f85149]' : alb.errorRate5xx > 1 ? 'text-[#d29922]' : 'text-[#3fb950]')}>
                    {alb.errorRate5xx.toFixed(2)}% 5xx rate
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard label="Total Routes" value={summary.total} />
          <SummaryCard label="Healthy" value={summary.green} color="text-[#3fb950]" sub="all endpoints ready" />
          <SummaryCard label="Degraded" value={summary.yellow} color="text-[#d29922]" sub="partial endpoints" />
          <SummaryCard label="Dead" value={summary.red} color="text-[#f85149]" sub="service or pod missing" />
        </div>
      )}

      {error && <p className="text-sm text-[#f85149]">{error}</p>}

      {loading && !routes.length ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">Scanning routes…</div>
      ) : routes.length === 0 ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">No ingress routes found in {namespace}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[#30363d]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#30363d] bg-[#161b22]">
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Health</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Ingress</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Host → Path</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Backend Service</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Endpoints</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Issue</th>
                <th className="px-3 py-2.5 text-left text-[#6e7681] font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r, i) => {
                const diagKey = `${namespace}/${r.ingressName}`;
                const diag = diagnoses[diagKey];
                const isDiagnosing = diagnosing.has(diagKey);
                const ingressObj = ingresses.find(ing => ing.name === r.ingressName);
                return (
                  <Fragment key={i}>
                    <tr className="border-b border-[#21262d] hover:bg-[#21262d]/40 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <HealthDot health={r.health} />
                          <span className={clsx('font-medium', HEALTH_TEXT[r.health])}>{r.health}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[#79c0ff]">{r.ingressName}</td>
                      <td className="px-3 py-2.5">
                        <span className="text-[#e6edf3]">{r.host}</span>
                        <span className="text-[#6e7681] mx-1">→</span>
                        <span className="font-mono text-[#8b949e]">{r.path}</span>
                      </td>
                      <td className="px-3 py-2.5 font-mono">
                        <span className="text-[#e6edf3]">{r.serviceName}</span>
                        <span className="text-[#6e7681]">:{r.servicePort}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        {r.endpointsTotal > 0 ? (
                          <span className={clsx(r.endpointsReady === r.endpointsTotal ? 'text-[#3fb950]' : 'text-[#d29922]')}>
                            {r.endpointsReady}/{r.endpointsTotal}
                          </span>
                        ) : (
                          <span className="text-[#6e7681]">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[#8b949e] max-w-xs truncate">{r.issue || '—'}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          {(r.health === 'red' || r.health === 'yellow') && (
                            <button
                              onClick={() => handleDiagnose(r.ingressName)}
                              disabled={isDiagnosing}
                              title="AI Diagnose"
                              className={clsx(
                                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors disabled:opacity-50',
                                diag
                                  ? 'bg-[#2dd4bf]/10 border border-[#2dd4bf]/20 text-[#2dd4bf] hover:bg-[#2dd4bf]/20'
                                  : 'bg-[#d29922]/10 border border-[#d29922]/20 text-[#d29922] hover:bg-[#d29922]/20',
                              )}
                            >
                              <Zap size={10} className={isDiagnosing ? 'animate-pulse' : ''} />
                              {isDiagnosing ? 'Analysing…' : diag ? 'Re-diagnose' : 'Diagnose'}
                            </button>
                          )}
                          {isAdmin && ingressObj && (
                            <>
                              <button
                                onClick={() => setEditModal(ingressObj)}
                                title="Edit Ingress"
                                className="p-1.5 text-[#6e7681] hover:text-[#2dd4bf] transition-colors rounded"
                              >
                                <Edit3 size={11} />
                              </button>
                              <button
                                onClick={() => setDeleteModal(ingressObj)}
                                title="Delete Ingress"
                                className="p-1.5 text-[#6e7681] hover:text-[#f85149] transition-colors rounded"
                              >
                                <Trash2 size={11} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {diag && (
                      <tr className="border-b border-[#21262d] bg-[#0d1117]">
                        <td colSpan={7} className="px-3 py-3">
                          <div className={clsx('rounded-lg border p-3 space-y-2', SEVERITY_BG[diag.severity])}>
                            <div className="flex items-start gap-2">
                              <Brain size={14} className="text-[#2dd4bf] shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-semibold text-[#e6edf3]">{diag.rootCause}</span>
                                  <span className={clsx('text-[10px] font-mono font-medium', CONFIDENCE_COLOR[diag.confidence])}>
                                    {diag.confidence} confidence
                                  </span>
                                  {diag.breakpoint && diag.breakpoint !== 'unknown' && (
                                    <span className="text-[10px] bg-[#21262d] text-[#8b949e] border border-[#30363d] rounded px-1.5 py-0.5 font-mono">
                                      breakpoint: {diag.breakpoint}
                                    </span>
                                  )}
                                </div>
                                {diag.suggestions.length > 0 && (
                                  <div className="mt-2 space-y-1.5">
                                    {diag.suggestions.map((s, si) => (
                                      <div key={si} className="flex items-start gap-2">
                                        <span className="text-[10px] text-[#6e7681] shrink-0 font-mono mt-0.5">{s.rank}.</span>
                                        <div className="min-w-0">
                                          <p className="text-[11px] text-[#8b949e]">{s.action}</p>
                                          {s.command && (
                                            <code className="block mt-0.5 text-[10px] font-mono text-[#79c0ff] bg-[#161b22] border border-[#21262d] rounded px-2 py-0.5 break-all">
                                              {s.command}
                                            </code>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editModal && (
        <EditModal
          title={`Edit Ingress — ${editModal.name}`}
          initial={JSON.stringify(editModal.raw, null, 2)}
          onSave={handleEditSave}
          onClose={() => setEditModal(null)}
        />
      )}
      {deleteModal && (
        <DeleteModal
          name={deleteModal.name}
          kind="Ingress"
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteModal(null)}
        />
      )}
    </div>
  );
}

// ── Ingresses Tab ─────────────────────────────────────────────────────────────
function IngressesTab({ namespace, isAdmin }: { namespace: string; isAdmin: boolean }) {
  const [ingresses, setIngresses] = useState<IngressInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<{ ingress: IngressInfo | null }>({ ingress: null });
  const [createModal, setCreateModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState<IngressInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await getIngresses(namespace);
      setIngresses(r.ingresses);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [namespace]);

  useEffect(() => { load(); }, [load]);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const handleCreate = async (body: object) => {
    await createIngress(namespace, body);
    await load();
  };

  const handleEdit = async (body: object) => {
    if (!editModal.ingress) return;
    await updateIngress(editModal.ingress.namespace, editModal.ingress.name, body);
    await load();
  };

  const handleDelete = async () => {
    if (!deleteModal) return;
    await deleteIngress(deleteModal.namespace, deleteModal.name);
    await load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#6e7681]">{ingresses.length} ingress{ingresses.length !== 1 ? 'es' : ''} in {namespace}</span>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#2dd4bf] transition-colors disabled:opacity-50">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {isAdmin && (
            <button
              onClick={() => setCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 border border-[#2dd4bf]/30 rounded-md text-xs text-[#2dd4bf] font-medium transition-colors"
            >
              <Plus size={12} /> Add Ingress
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-[#f85149]">{error}</p>}

      {loading && !ingresses.length ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">Loading ingresses…</div>
      ) : ingresses.length === 0 ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">No ingresses found in {namespace}</div>
      ) : (
        <div className="space-y-1">
          {ingresses.map((ing) => {
            const key = `${ing.namespace}/${ing.name}`;
            const isOpen = expanded === key;
            const annotCount = Object.keys(ing.annotations).length;
            const allHosts = ing.rules.map(r => r.host).join(', ');

            return (
              <div key={key} className="border border-[#30363d] rounded-lg overflow-hidden">
                {/* Row */}
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-[#161b22] hover:bg-[#21262d] cursor-pointer transition-colors"
                  onClick={() => setExpanded(isOpen ? null : key)}
                >
                  <button className="text-[#6e7681] shrink-0">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Globe size={14} className="text-[#2dd4bf] shrink-0" />
                  <span className="font-mono text-sm text-[#e6edf3] font-medium">{ing.name}</span>
                  {ing.ingressClass && (
                    <span className="text-[10px] bg-[#21262d] text-[#6e7681] border border-[#30363d] rounded px-1.5 py-0.5 font-mono">{ing.ingressClass}</span>
                  )}
                  <span className="text-xs text-[#8b949e] truncate flex-1 min-w-0">{allHosts}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge label={ing.tlsStatus === 'none' ? 'No TLS' : `TLS: ${ing.tlsStatus}`} variant={TLS_VARIANT[ing.tlsStatus] ?? 'muted'} size="xs" />
                    {annotCount > 0 && <span className="text-[10px] text-[#6e7681]">{annotCount} annotations</span>}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setEditModal({ ingress: ing })}
                        className="p-1.5 text-[#6e7681] hover:text-[#2dd4bf] transition-colors rounded"
                        title="Edit"
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        onClick={() => setDeleteModal(ing)}
                        className="p-1.5 text-[#6e7681] hover:text-[#f85149] transition-colors rounded"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Expanded */}
                {isOpen && (
                  <div className="border-t border-[#30363d] bg-[#0d1117] p-4 space-y-4">
                    {/* Routing table */}
                    {ing.rules.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">Routing Rules</p>
                        <div className="rounded-lg border border-[#21262d] overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-[#161b22] border-b border-[#21262d]">
                                <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Host</th>
                                <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Path</th>
                                <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Type</th>
                                <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Backend</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ing.rules.flatMap((rule, ri) =>
                                rule.paths.map((path, pi) => (
                                  <tr key={`${ri}-${pi}`} className="border-b border-[#21262d] last:border-0">
                                    <td className="px-3 py-2 font-mono text-[#e6edf3]">{rule.host}</td>
                                    <td className="px-3 py-2 font-mono text-[#79c0ff]">{path.path}</td>
                                    <td className="px-3 py-2 text-[#6e7681]">{path.pathType}</td>
                                    <td className="px-3 py-2 font-mono">
                                      <span className="text-[#3fb950]">{path.serviceName}</span>
                                      <span className="text-[#6e7681]">:{path.servicePort}</span>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* TLS */}
                    {ing.tls.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">TLS</p>
                        {ing.tls.map((t, i) => (
                          <div key={i} className="text-xs flex items-center gap-2">
                            <span className="font-mono text-[#8b949e]">secret:</span>
                            <span className="font-mono text-[#e6edf3]">{t.secretName}</span>
                            <span className="text-[#6e7681]">→</span>
                            <span className="text-[#8b949e]">{t.hosts.join(', ')}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Annotations */}
                    {annotCount > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">Annotations ({annotCount})</p>
                        <div className="space-y-1">
                          {Object.entries(ing.annotations).map(([k, v]) => (
                            <div key={k} className="flex items-start gap-2 text-xs font-mono">
                              <span className="text-[#79c0ff] shrink-0">{k}:</span>
                              <span className="text-[#8b949e] break-all">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Raw YAML toggle */}
                    <div>
                      <button
                        onClick={() => setShowYaml(showYaml === key ? null : key)}
                        className="flex items-center gap-1.5 text-xs text-[#6e7681] hover:text-[#2dd4bf] transition-colors"
                      >
                        {showYaml === key ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Raw JSON
                      </button>
                      {showYaml === key && (
                        <div className="mt-2 relative">
                          <button
                            onClick={() => handleCopy(JSON.stringify(ing.raw, null, 2), key)}
                            className="absolute top-2 right-2 p-1.5 text-[#6e7681] hover:text-[#2dd4bf] transition-colors"
                          >
                            {copied === key ? <CheckCircle size={12} className="text-[#3fb950]" /> : <Copy size={12} />}
                          </button>
                          <pre className="bg-[#161b22] rounded p-3 pr-8 text-[10px] font-mono text-[#8b949e] overflow-x-auto max-h-60">
                            {JSON.stringify(ing.raw, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {createModal && (
        <EditModal
          title="Create Ingress"
          initial={INGRESS_TEMPLATE}
          onSave={handleCreate}
          onClose={() => setCreateModal(false)}
        />
      )}
      {editModal.ingress && (
        <EditModal
          title={`Edit Ingress — ${editModal.ingress.name}`}
          initial={JSON.stringify(editModal.ingress.raw, null, 2)}
          onSave={handleEdit}
          onClose={() => setEditModal({ ingress: null })}
        />
      )}
      {deleteModal && (
        <DeleteModal
          name={deleteModal.name}
          kind="Ingress"
          onConfirm={handleDelete}
          onClose={() => setDeleteModal(null)}
        />
      )}
    </div>
  );
}

// ── Services Tab ──────────────────────────────────────────────────────────────
function ServicesTab({ namespace, isAdmin }: { namespace: string; isAdmin: boolean }) {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState<string | null>(null);
  const [editModal, setEditModal] = useState<{ svc: ServiceInfo | null }>({ svc: null });
  const [createModal, setCreateModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState<ServiceInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await getServices(namespace);
      setServices(r.services);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [namespace]);

  useEffect(() => { load(); }, [load]);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key); setTimeout(() => setCopied(null), 1500);
    });
  };

  const handleCreate = async (body: object) => { await createService(namespace, body); await load(); };
  const handleEdit   = async (body: object) => { if (!editModal.svc) return; await updateService(editModal.svc.namespace, editModal.svc.name, body); await load(); };
  const handleDelete = async () => { if (!deleteModal) return; await deleteService(deleteModal.namespace, deleteModal.name); await load(); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#6e7681]">{services.length} service{services.length !== 1 ? 's' : ''} in {namespace}</span>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#2dd4bf] transition-colors disabled:opacity-50">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {isAdmin && (
            <button
              onClick={() => setCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2dd4bf]/10 hover:bg-[#2dd4bf]/20 border border-[#2dd4bf]/30 rounded-md text-xs text-[#2dd4bf] font-medium transition-colors"
            >
              <Plus size={12} /> Add Service
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-[#f85149]">{error}</p>}

      {loading && !services.length ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">Loading services…</div>
      ) : services.length === 0 ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">No services found in {namespace}</div>
      ) : (
        <div className="space-y-1">
          {services.map((svc) => {
            const key = `${svc.namespace}/${svc.name}`;
            const isOpen = expanded === key;
            const svcType = svc.clusterIP === 'None' ? 'Headless' : svc.type;
            const endpointText = svc.endpointsTotal > 0
              ? `${svc.endpointsReady}/${svc.endpointsTotal} ready`
              : Object.keys(svc.selector).length > 0 ? '0 endpoints' : 'no selector';

            return (
              <div key={key} className="border border-[#30363d] rounded-lg overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-[#161b22] hover:bg-[#21262d] cursor-pointer transition-colors"
                  onClick={() => setExpanded(isOpen ? null : key)}
                >
                  <button className="text-[#6e7681] shrink-0">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Server size={14} className="text-[#2dd4bf] shrink-0" />
                  <span className="font-mono text-sm text-[#e6edf3] font-medium">{svc.name}</span>
                  <Badge label={svcType} variant={SVC_TYPE_VARIANT[svcType] ?? 'muted'} size="xs" />

                  {svc.isDead && <Badge label="DEAD" variant="critical" size="xs" />}
                  {svc.isOrphan && !svc.isDead && <Badge label="orphan" variant="warning" size="xs" />}

                  <span className="text-xs text-[#6e7681] font-mono flex-1 min-w-0 truncate">{svc.clusterIP}</span>

                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    <span className={clsx(
                      svc.endpointsReady === svc.endpointsTotal && svc.endpointsTotal > 0 ? 'text-[#3fb950]' :
                      svc.endpointsTotal > 0 ? 'text-[#d29922]' : 'text-[#6e7681]'
                    )}>
                      {endpointText}
                    </span>
                    <span className="text-[#6e7681]">
                      {svc.ports.map(p => `${p.port}/${p.protocol}`).join(' · ')}
                    </span>
                  </div>

                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setEditModal({ svc })} className="p-1.5 text-[#6e7681] hover:text-[#2dd4bf] transition-colors rounded" title="Edit">
                        <Edit3 size={12} />
                      </button>
                      <button onClick={() => setDeleteModal(svc)} className="p-1.5 text-[#6e7681] hover:text-[#f85149] transition-colors rounded" title="Delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {isOpen && (
                  <div className="border-t border-[#30363d] bg-[#0d1117] p-4 space-y-4">
                    {/* Port mapping */}
                    <div>
                      <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">Port Mapping</p>
                      <div className="rounded-lg border border-[#21262d] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-[#161b22] border-b border-[#21262d]">
                              <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Name</th>
                              <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Port</th>
                              <th className="px-3 py-2 text-left text-[#6e7681] font-medium">TargetPort</th>
                              <th className="px-3 py-2 text-left text-[#6e7681] font-medium">Protocol</th>
                              {svc.type === 'NodePort' && <th className="px-3 py-2 text-left text-[#6e7681] font-medium">NodePort</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {svc.ports.map((p, i) => (
                              <tr key={i} className="border-b border-[#21262d] last:border-0">
                                <td className="px-3 py-2 font-mono text-[#6e7681]">{p.name || '—'}</td>
                                <td className="px-3 py-2 font-mono text-[#e6edf3]">{p.port}</td>
                                <td className="px-3 py-2 font-mono text-[#79c0ff]">{p.targetPort}</td>
                                <td className="px-3 py-2 text-[#6e7681]">{p.protocol}</td>
                                {svc.type === 'NodePort' && <td className="px-3 py-2 font-mono text-[#d29922]">{p.nodePort ?? '—'}</td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Selector */}
                    {Object.keys(svc.selector).length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">Pod Selector</p>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(svc.selector).map(([k, v]) => (
                            <span key={k} className="font-mono text-[10px] bg-[#21262d] border border-[#30363d] rounded px-2 py-0.5 text-[#8b949e]">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* External IP */}
                    {svc.externalIP && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-[#6e7681]">External IP:</span>
                        <span className="font-mono text-[#2dd4bf]">{svc.externalIP}</span>
                        <ExternalLink size={10} className="text-[#6e7681]" />
                      </div>
                    )}

                    {/* Raw JSON toggle */}
                    <div>
                      <button
                        onClick={() => setShowYaml(showYaml === key ? null : key)}
                        className="flex items-center gap-1.5 text-xs text-[#6e7681] hover:text-[#2dd4bf] transition-colors"
                      >
                        {showYaml === key ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Raw JSON
                      </button>
                      {showYaml === key && (
                        <div className="mt-2 relative">
                          <button
                            onClick={() => handleCopy(JSON.stringify(svc.raw, null, 2), key)}
                            className="absolute top-2 right-2 p-1.5 text-[#6e7681] hover:text-[#2dd4bf] transition-colors"
                          >
                            {copied === key ? <CheckCircle size={12} className="text-[#3fb950]" /> : <Copy size={12} />}
                          </button>
                          <pre className="bg-[#161b22] rounded p-3 pr-8 text-[10px] font-mono text-[#8b949e] overflow-x-auto max-h-60">
                            {JSON.stringify(svc.raw, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {createModal && (
        <EditModal title="Create Service" initial={SERVICE_TEMPLATE} onSave={handleCreate} onClose={() => setCreateModal(false)} />
      )}
      {editModal.svc && (
        <EditModal
          title={`Edit Service — ${editModal.svc.name}`}
          initial={JSON.stringify(editModal.svc.raw, null, 2)}
          onSave={handleEdit}
          onClose={() => setEditModal({ svc: null })}
        />
      )}
      {deleteModal && (
        <DeleteModal name={deleteModal.name} kind="Service" onConfirm={handleDelete} onClose={() => setDeleteModal(null)} />
      )}
    </div>
  );
}

// ── Network Policies Tab ──────────────────────────────────────────────────────
function PoliciesTab({ namespace }: { namespace: string }) {
  const [policies, setPolicies] = useState<NetworkPolicyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await getNetworkPolicies(namespace);
      setPolicies(r.policies);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [namespace]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#6e7681]">{policies.length} polic{policies.length !== 1 ? 'ies' : 'y'} in {namespace}</span>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#2dd4bf] transition-colors disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <p className="text-sm text-[#f85149]">{error}</p>}

      {loading && !policies.length ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">Loading network policies…</div>
      ) : policies.length === 0 ? (
        <div className="text-center py-12 text-[#6e7681] text-sm">No network policies in {namespace}</div>
      ) : (
        <div className="space-y-1">
          {policies.map((np) => {
            const key = `${np.namespace}/${np.name}`;
            const isOpen = expanded === key;
            const selectorText = Object.keys(np.podSelector).length === 0
              ? 'all pods'
              : Object.entries(np.podSelector).map(([k, v]) => `${k}=${v}`).join(', ');

            return (
              <div key={key} className="border border-[#30363d] rounded-lg overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-[#161b22] hover:bg-[#21262d] cursor-pointer transition-colors"
                  onClick={() => setExpanded(isOpen ? null : key)}
                >
                  <button className="text-[#6e7681] shrink-0">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <Shield size={14} className="text-[#2dd4bf] shrink-0" />
                  <span className="font-mono text-sm text-[#e6edf3] font-medium">{np.name}</span>

                  {np.isDefaultDeny && <Badge label="default-deny" variant="critical" size="xs" />}

                  <span className="text-xs text-[#6e7681] flex-1 truncate">selector: {selectorText}</span>

                  <div className="flex items-center gap-3 shrink-0 text-xs text-[#6e7681]">
                    {np.ingressRuleCount > 0 && <span className="text-[#3fb950]">↓ {np.ingressRuleCount} ingress</span>}
                    {np.egressRuleCount > 0 && <span className="text-[#79c0ff]">↑ {np.egressRuleCount} egress</span>}
                    {np.ingressRuleCount === 0 && np.egressRuleCount === 0 && !np.isDefaultDeny && (
                      <span className="text-[#6e7681]">no rules</span>
                    )}
                    {np.affectedPods.length > 0 && (
                      <span className="text-[#d29922]">{np.affectedPods.length} pod{np.affectedPods.length !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-[#30363d] bg-[#0d1117] p-4 space-y-3">
                    {/* Affected pods */}
                    {np.affectedPods.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">
                          Affected Pods ({np.affectedPods.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {np.affectedPods.map(p => (
                            <span key={p} className="font-mono text-[10px] bg-[#21262d] border border-[#30363d] rounded px-2 py-0.5 text-[#8b949e]">{p}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Pod selector */}
                    <div>
                      <p className="text-[10px] font-semibold text-[#6e7681] uppercase tracking-wider mb-2">Pod Selector</p>
                      {Object.keys(np.podSelector).length === 0 ? (
                        <span className="text-xs text-[#d29922]">All pods in namespace (empty selector)</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(np.podSelector).map(([k, v]) => (
                            <span key={k} className="font-mono text-[10px] bg-[#21262d] border border-[#30363d] rounded px-2 py-0.5 text-[#8b949e]">{k}={v}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Rules summary */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-[#161b22] border border-[#21262d] rounded p-3">
                        <p className="text-[10px] text-[#6e7681] mb-1">Ingress Rules (inbound)</p>
                        <p className="text-lg font-bold text-[#3fb950]">{np.ingressRuleCount}</p>
                        <p className="text-[10px] text-[#6e7681]">{np.ingressRuleCount === 0 ? 'block all inbound' : 'rules allowing traffic in'}</p>
                      </div>
                      <div className="bg-[#161b22] border border-[#21262d] rounded p-3">
                        <p className="text-[10px] text-[#6e7681] mb-1">Egress Rules (outbound)</p>
                        <p className="text-lg font-bold text-[#79c0ff]">{np.egressRuleCount}</p>
                        <p className="text-[10px] text-[#6e7681]">{np.egressRuleCount === 0 ? 'block all outbound' : 'rules allowing traffic out'}</p>
                      </div>
                    </div>

                    {/* Raw JSON */}
                    <details className="group">
                      <summary className="cursor-pointer text-xs text-[#6e7681] hover:text-[#2dd4bf] transition-colors list-none flex items-center gap-1.5">
                        <ChevronRight size={12} className="group-open:rotate-90 transition-transform" />
                        Raw JSON
                      </summary>
                      <pre className="mt-2 bg-[#161b22] rounded p-3 text-[10px] font-mono text-[#8b949e] overflow-x-auto max-h-60">
                        {JSON.stringify(np.raw, null, 2)}
                      </pre>
                    </details>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Network page ─────────────────────────────────────────────────────────
export default function Network() {
  const [tab, setTab] = useState<Tab>('health');
  const [ns, setNs] = useState('prod');
  const [isAdmin, setIsAdmin] = useState(false);

  // Determine admin status from /api/me (already cached in Layout, but we re-read here)
  useEffect(() => {
    fetch('/admin/api/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(me => { if (me?.role === 'admin' || me?.role === 'superadmin') setIsAdmin(true); })
      .catch(() => {});
  }, []);

  const TABS: { id: Tab; label: string; Icon: React.ElementType }[] = [
    { id: 'health',    label: 'Route Health',     Icon: Activity },
    { id: 'ingresses', label: 'Ingresses',         Icon: Globe },
    { id: 'services',  label: 'Services',          Icon: Server },
    { id: 'policies',  label: 'Network Policies',  Icon: Shield },
  ];

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#2dd4bf]/10 border border-[#2dd4bf]/20">
            <NetworkIcon size={18} className="text-[#2dd4bf]" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-[#e6edf3]">Network Explorer</h1>
            <p className="text-xs text-[#6e7681]">Ingresses · Services · Routing · Network Policies</p>
          </div>
        </div>

        {/* Namespace selector */}
        <select
          value={ns}
          onChange={e => setNs(e.target.value)}
          className="bg-[#21262d] border border-[#30363d] text-[#e6edf3] text-xs rounded-md px-3 py-1.5 outline-none focus:border-[#2dd4bf]/50 transition-colors"
        >
          {NAMESPACES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 bg-[#161b22] border border-[#30363d] rounded-lg p-1 w-fit">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
              tab === id
                ? 'bg-[#2dd4bf]/10 text-[#2dd4bf] border border-[#2dd4bf]/20'
                : 'text-[#6e7681] hover:text-[#e6edf3] hover:bg-[#21262d]',
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <Card>
        {tab === 'health'    && <HealthTab    namespace={ns} isAdmin={isAdmin} />}
        {tab === 'ingresses' && <IngressesTab namespace={ns} isAdmin={isAdmin} />}
        {tab === 'services'  && <ServicesTab  namespace={ns} isAdmin={isAdmin} />}
        {tab === 'policies'  && <PoliciesTab  namespace={ns} />}
      </Card>
    </div>
  );
}
