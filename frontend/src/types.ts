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
  instanceType: string;
  capacityType: 'SPOT' | 'ON_DEMAND' | 'unknown';
  zone: string;
  nodeGroup: string;
  uptime: string;
  spotTerminating: boolean;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  image: string;
  age: string;
  conditions: { type: string; status: string; reason?: string }[];
}

// BLY-68: revision history entry from ReplicaSet
export interface DeploymentRevision {
  revision: number;
  image: string;
  images: string[];
  createdAt: string;
  age: string;
  replicas: number;
  readyReplicas: number;
  isCurrent: boolean;
}

export interface LogLine {
  ts: string;
  text: string;
}

export interface LogAnalysis {
  summary: string;
  issues: string[];
  severity: 'info' | 'warning' | 'critical';
  rootCause?: string;
  recommendation?: string;
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
  role: 'superadmin' | 'admin' | 'viewer';
  version?: string;
}

export interface LicenseInfo {
  plan: string;
  seats: number;
  usedSeats: number;
  expires: string | null;
  customer: string | null;
  hasCustomKey: boolean;
}

export interface ConfigData {
  configMap: Record<string, string>;
  adminUsers: AdminUser[];
  note: string;
}

// BLY-69: Rich pod/node detail
export interface PodDetail {
  pod: {
    name: string;
    namespace: string;
    nodeName: string;
    phase: string;
    qosClass: string;
    ip: string;
    age: string;
    tolerations: { key?: string; operator?: string; effect?: string; value?: string }[];
    nodeSelector: Record<string, string>;
    volumes: { name: string; type: string; claim?: string }[];
  };
  containers: {
    name: string;
    image: string;
    state: string;
    reason?: string;
    ready: boolean;
    restartCount: number;
    cpuRequest: number;
    cpuLimit:   number;
    memRequest: number;
    memLimit:   number;
    cpuUsage?:  number;
    memUsage?:  number;
  }[];
  node: {
    name: string;
    instanceType: string;
    capacityType: string;
    zone: string;
    nodeGroup: string;
    cpuAllocatable: number;
    memAllocatable: number;
    cpuUsage?: number;
    memUsage?: number;
    taints: { key: string; effect: string; value?: string }[];
    labels: Record<string, string>;
  } | null;
}
