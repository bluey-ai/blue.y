import type { IncidentRow, IncidentStats, PodInfo, NodeInfo, AdminUser, MeResponse, ConfigData, NamespaceHealth, StreamEvent, DeploymentInfo, LogAnalysis } from './types';

const BASE = '/admin/api';

export class ForbiddenError extends Error {
  constructor() { super('Requires SuperAdmin access'); this.name = 'ForbiddenError'; }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorized'); }
  if (res.status === 403) throw new ForbiddenError();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorized'); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any).error || `${res.status}`); }
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', credentials: 'include' });
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Unauthorized'); }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any).error || `${res.status}`); }
  return res.json();
}

// Auth
export const getMe = () => get<MeResponse>('/me');

// Incidents
export interface IncidentFilters { limit?: number; severity?: string; namespace?: string; monitor?: string; search?: string; }
export const getIncidents = (filters: IncidentFilters = {}) => {
  const p = new URLSearchParams();
  if (filters.limit) p.set('limit', String(filters.limit));
  if (filters.severity) p.set('severity', filters.severity);
  if (filters.namespace) p.set('namespace', filters.namespace);
  if (filters.monitor) p.set('monitor', filters.monitor);
  if (filters.search) p.set('search', filters.search);
  return get<{ incidents: IncidentRow[]; stats: IncidentStats; count: number }>(`/incidents?${p}`);
};
export const getIncidentStats = () => get<IncidentStats>('/incidents/stats');
export const getIncidentById = (id: number) => get<IncidentRow>(`/incidents/${id}`);

// Cluster
export const getClusterStatus = () => get<{ summary: string; nodes: NodeInfo[]; namespaces: string[] }>('/cluster/status');
export const getPods = (namespace = 'prod') => get<{ pods: PodInfo[]; namespace: string }>(`/cluster/pods?namespace=${encodeURIComponent(namespace)}`);
export const getNodes = () => get<{ nodes: NodeInfo[] }>('/cluster/nodes');

// Users
export const getUsers = () => get<{ users: AdminUser[]; count: number }>('/users');
export const addUser = (user: { platform: string; userId: string; displayName: string }) => post<{ ok: boolean; user: AdminUser }>('/users', user);
export const deleteUser = (platform: string, userId: string) => del(`/users/${encodeURIComponent(platform)}/${encodeURIComponent(userId)}`);

// Config
export const getConfig = () => get<ConfigData>('/config');
export const saveConfig = (data: Record<string, string>) => put<{ ok: boolean; keys: number }>('/config', { data });

// Deployments
export interface DeploymentActionResult {
  ok: boolean;
  message: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

export const getDeployments = (namespace = 'prod') =>
  get<{ deployments: DeploymentInfo[]; namespace: string }>(`/deployments?namespace=${encodeURIComponent(namespace)}`);
export const restartDeployment = (namespace: string, deployment: string) =>
  post<DeploymentActionResult>('/deployments/restart', { namespace, deployment });
export const scaleDeployment = (namespace: string, deployment: string, replicas: number) =>
  post<DeploymentActionResult>('/deployments/scale', { namespace, deployment, replicas });

/** Subscribe to an approval SSE stream. Returns a cleanup function. */
export function waitForApprovalDecision(
  approvalId: string,
  onDecision: (status: 'approved' | 'rejected' | 'expired') => void,
): () => void {
  const es = new EventSource(`${BASE}/deployments/approval/${encodeURIComponent(approvalId)}/wait`, { withCredentials: true });
  es.addEventListener('decision', (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data);
      onDecision(data.status);
    } catch {
      // ignore parse errors
    }
    es.close();
  });
  es.onerror = () => { onDecision('expired'); es.close(); };
  return () => es.close();
}

// Logs
export const getLogPods = (namespace = 'prod') =>
  get<{ pods: { name: string; containers: string[] }[]; namespace: string }>(`/logs/pods?namespace=${encodeURIComponent(namespace)}`);
export const fetchLogs = (namespace: string, pod: string, lines = 200) =>
  get<{ lines: string[]; pod: string; namespace: string }>(`/logs/fetch?namespace=${encodeURIComponent(namespace)}&pod=${encodeURIComponent(pod)}&lines=${lines}`);
export const analyzeLogs = (pod: string, namespace: string, logs: string) =>
  post<{ analysis: LogAnalysis }>('/logs/analyze', { pod, namespace, logs });
export function streamLogs(
  namespace: string, pod: string, container: string, tail: number,
  onLine: (line: string) => void, onError?: (e: Event) => void,
): EventSource {
  const params = new URLSearchParams({ namespace, pod, container, tail: String(tail) });
  const es = new EventSource(`/admin/api/logs/stream?${params}`, { withCredentials: true });
  es.addEventListener('log', (e: MessageEvent) => onLine(e.data));
  if (onError) es.addEventListener('error', onError);
  return es;
}

// SSO Invites (BLY-50/58)
export interface SsoInvite { id: number; email: string; role: string; status: string; invited_by: string; created_at: string; }
export const getInvites = () => get<{ invites: SsoInvite[]; activeCount: number; seatLimit: number }>('/invites');
export const createInvite = (email: string, role: string) => post<{ ok: boolean; invite: SsoInvite }>('/invites', { email, role });
export const revokeInvite = (email: string) => del(`/invites/${encodeURIComponent(email)}`);
export const changeInviteRole = (email: string, role: string) => {
  return fetch(`${BASE}/invites/${encodeURIComponent(email)}/role`, {
    method: 'PATCH', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
};

// IP Allowlist (BLY-55)
export interface AllowlistEntry { id: number; cidr: string; label: string; added_by: string; created_at: string; }
export const getAllowlist = () => get<{ entries: AllowlistEntry[] }>('/allowlist');
export const getMyIp = () => get<{ ip: string }>('/allowlist/myip');
export const addAllowlistEntry = (cidr: string, label: string) => post<{ ok: boolean; cidr: string }>('/allowlist', { cidr, label });
export const deleteAllowlistEntry = (id: number) => del(`/allowlist/${id}`);

// Integrations (BLY-59)
export interface IntegrationField { key: string; label: string; type: string; value: string; hasValue: boolean; }
export interface Integration { id: string; label: string; icon: string; enabled: boolean; fields: IntegrationField[]; }
export const getIntegrations = () => get<{ integrations: Integration[]; readOnly: boolean }>('/integrations');
export const saveIntegration = (id: string, fields: Record<string, string>) =>
  put<{ ok: boolean; integration: string }>(`/integrations/${encodeURIComponent(id)}`, { fields });
export const testIntegration = (id: string) =>
  post<{ ok: boolean; status: 'connected' | 'failed' | 'not_configured'; message: string }>(`/integrations/${encodeURIComponent(id)}/test`, {});

// Pod terminal — BLY-63
export const getDeploymentPods = (namespace: string, deployment: string) =>
  get<{ pods: PodInfo[]; namespace: string; deployment: string }>(`/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(deployment)}/pods`);

// Stream (SSE)
export function createStream(onEvent: (e: StreamEvent) => void, onError?: (e: Event) => void): EventSource {
  const es = new EventSource('/admin/api/stream', { withCredentials: true });
  es.addEventListener('cluster', (e: MessageEvent) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
  });
  if (onError) es.addEventListener('error', onError);
  return es;
}

export type { IncidentRow, IncidentStats, PodInfo, NodeInfo, AdminUser, MeResponse, ConfigData, NamespaceHealth, DeploymentInfo, LogAnalysis };
