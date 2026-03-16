export interface IncidentRow {
  id: number;
  ts: string;
  severity: 'warning' | 'critical';
  namespace: string;
  pod: string;
  monitor: string;
  title: string;
  message: string;
  ai_diagnosis: string | null;
}

export interface IncidentStats {
  total: number;
  critical: number;
  warning: number;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ready: boolean;
  age: string;
  containers: { name: string; state: string; reason?: string; restartCount: number }[];
  isJobPod: boolean;
}

export interface NodeInfo {
  name: string;
  status: string;
  roles: string[];
  allocatable: { cpu: string; memory: string };
  conditions: { type: string; status: string; reason?: string }[];
}

export interface NamespaceHealth {
  namespace: string;
  pods: PodInfo[];
  healthy: number;
  unhealthy: number;
}

export interface StreamEvent {
  ts: string;
  nodes: NodeInfo[];
  namespaces: NamespaceHealth[];
}

export interface AdminUser {
  id: string;
  platform: 'telegram' | 'slack' | 'teams' | 'whatsapp';
  userId: string;
  displayName: string;
}

export interface MeResponse {
  sub: string;
  platform: string;
  name: string;
}

export interface ConfigData {
  configMap: Record<string, string>;
  adminUsers: AdminUser[];
  note: string;
}
