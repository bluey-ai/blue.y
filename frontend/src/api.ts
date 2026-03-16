import type { IncidentRow, IncidentStats, PodInfo, NodeInfo, AdminUser, MeResponse, ConfigData, NamespaceHealth, StreamEvent } from './types';

const BASE = '/admin/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (res.status === 401 || res.status === 403) {
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }
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

// Stream (SSE)
export function createStream(onEvent: (e: StreamEvent) => void, onError?: (e: Event) => void): EventSource {
  const es = new EventSource('/admin/api/stream', { withCredentials: true });
  es.addEventListener('cluster', (e: MessageEvent) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ignore parse errors */ }
  });
  if (onError) es.addEventListener('error', onError);
  return es;
}

export type { IncidentRow, IncidentStats, PodInfo, NodeInfo, AdminUser, MeResponse, ConfigData, NamespaceHealth };
