import * as k8s from '@kubernetes/client-node';
import { setHeaderOptions } from '@kubernetes/client-node/dist/middleware.js';
import { config } from '../config';
import { logger } from '../utils/logger';

const STRATEGIC_MERGE_PATCH = setHeaderOptions('Content-Type', 'application/strategic-merge-patch+json');

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ready: boolean;
  age: string;
  containers: { name: string; state: string; reason?: string; restartCount: number }[];
  isJobPod: boolean; // true if owned by a Job/CronJob (not a long-running service)
}

export interface NodeInfo {
  name: string;
  status: string;
  roles: string[];
  allocatable: { cpu: string; memory: string };
  conditions: { type: string; status: string; reason?: string }[];
  // Enhanced node metadata
  instanceType: string;           // e.g. m5.2xlarge
  capacityType: 'SPOT' | 'ON_DEMAND' | 'unknown';
  zone: string;                   // e.g. ap-southeast-1a
  nodeGroup: string;              // EKS node group name
  uptime: string;                 // human-readable since boot
  spotTerminating: boolean;       // true if EC2 termination notice detected
}

export interface HPAInfo {
  name: string;
  namespace: string;
  targetRef: string;
  minReplicas: number;
  maxReplicas: number;
  currentReplicas: number;
  desiredReplicas: number;
  metrics: { type: string; name: string; current: number; target: number; unit: string }[];
  conditions: { type: string; status: string; reason?: string; message?: string }[];
}

// BLY-69: Rich pod/node detail panel
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
    cpuRequest: number;   // millicores
    cpuLimit:   number;   // millicores (0 = no limit)
    memRequest: number;   // MiB
    memLimit:   number;   // MiB (0 = no limit)
    cpuUsage?:  number;   // from metrics-server
    memUsage?:  number;   // from metrics-server
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

// BLY-77: Network Explorer types
export interface IngressInfo {
  name: string;
  namespace: string;
  ingressClass: string | null;
  rules: Array<{
    host: string;
    paths: Array<{ path: string; pathType: string; serviceName: string; servicePort: number | string }>;
  }>;
  tls: Array<{ hosts: string[]; secretName: string }>;
  tlsStatus: 'none' | 'valid' | 'expiring' | 'expired' | 'missing-secret';
  annotations: Record<string, string>;
  createdAt: string | null;
  raw: object;
}

export interface ServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  externalIP: string | null;
  ports: Array<{ name?: string; port: number; targetPort: number | string; protocol: string; nodePort?: number }>;
  selector: Record<string, string>;
  endpointsReady: number;
  endpointsTotal: number;
  isDead: boolean;
  isOrphan: boolean;
  createdAt: string | null;
  raw: object;
}

export interface NetworkPolicyInfo {
  name: string;
  namespace: string;
  podSelector: Record<string, string>;
  affectedPods: string[];
  ingressRuleCount: number;
  egressRuleCount: number;
  isDefaultDeny: boolean;
  createdAt: string | null;
  raw: object;
}

export interface RouteHealth {
  ingressName: string;
  namespace: string;
  host: string;
  path: string;
  serviceName: string;
  servicePort: number | string;
  health: 'green' | 'yellow' | 'red';
  breakpoint: 'none' | 'service-missing' | 'no-endpoints' | 'pods-not-ready';
  endpointsReady: number;
  endpointsTotal: number;
  issue?: string;
}

export class KubeClient {
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private networkingApi: k8s.NetworkingV1Api;
  private kc: k8s.KubeConfig;

  constructor() {
    this.kc = new k8s.KubeConfig();

    if (config.kube.inCluster) {
      this.kc.loadFromCluster();
    } else {
      this.kc.loadFromDefault();
    }

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.networkingApi = this.kc.makeApiClient(k8s.NetworkingV1Api);
  }

  async getPods(namespace: string): Promise<PodInfo[]> {
    try {
      const res = await this.coreApi.listNamespacedPod({ namespace });
      return (res.items || []).map((pod) => {
        const containerStatuses = pod.status?.containerStatuses || [];
        // Detect if this pod is owned by a Job/CronJob (not a long-running service)
        const owners = pod.metadata?.ownerReferences || [];
        const isJobPod = owners.some((o) => o.kind === 'Job') ||
          // Also check common CronJob/Job pod name patterns
          /-(cron|backup|watchdog|restart|cleanup|migrate)-/.test(pod.metadata?.name || '') ||
          // Completed/failed pods with no owner (orphan jobs)
          (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed');

        return {
          name: pod.metadata?.name || 'unknown',
          namespace: pod.metadata?.namespace || namespace,
          status: pod.status?.phase || 'Unknown',
          restarts: containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0),
          ready: containerStatuses.every((c) => c.ready),
          age: this.getAge(pod.metadata?.creationTimestamp),
          containers: containerStatuses.map((c) => ({
            name: c.name,
            state: Object.keys(c.state || {})[0] || 'unknown',
            reason: c.state?.waiting?.reason || c.state?.terminated?.reason,
            restartCount: c.restartCount || 0,
          })),
          isJobPod,
        };
      });
    } catch (err) {
      logger.error(`Failed to get pods in ${namespace}`, err);
      return [];
    }
  }

  async getUnhealthyPods(): Promise<PodInfo[]> {
    const allPods: PodInfo[] = [];

    for (const ns of config.kube.namespaces) {
      const pods = await this.getPods(ns);
      const unhealthy = pods.filter(
        (p) =>
          // Skip Job/CronJob pods — they're expected to complete/fail
          !p.isJobPod &&
          // Actual health checks for long-running service pods
          (
            (p.status !== 'Running' && p.status !== 'Succeeded') ||
            (!p.ready && p.status === 'Running') ||
            p.restarts > 5
          ),
      );
      allPods.push(...unhealthy);
    }

    return allPods;
  }

  async getPodLogs(namespace: string, podName: string, tailLines = 50): Promise<string> {
    try {
      const res = await this.coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
        tailLines,
      });
      return res || '';
    } catch (err) {
      logger.error(`Failed to get logs for ${namespace}/${podName}`, err);
      return `Error fetching logs: ${err instanceof Error ? err.message : 'Unknown'}`;
    }
  }

  async getNodes(): Promise<NodeInfo[]> {
    try {
      const res = await this.coreApi.listNode();
      return (res.items || []).map((node) => {
        const labels = node.metadata?.labels || {};
        const taints = node.spec?.taints || [];

        // Detect spot termination notice taint
        const spotTerminating = taints.some((t) =>
          t.key === 'aws.amazon.com/spot-instance-termination-notice' ||
          t.key === 'node.kubernetes.io/unreachable' && t.effect === 'NoExecute',
        );

        return {
          name: node.metadata?.name || 'unknown',
          status: node.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
            ? 'Ready'
            : 'NotReady',
          roles: Object.keys(labels)
            .filter((l) => l.startsWith('node-role.kubernetes.io/'))
            .map((l) => l.replace('node-role.kubernetes.io/', '')),
          allocatable: {
            cpu: node.status?.allocatable?.cpu || '0',
            memory: node.status?.allocatable?.memory || '0',
          },
          conditions: (node.status?.conditions || []).map((c) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
          })),
          instanceType: labels['node.kubernetes.io/instance-type']
            || labels['beta.kubernetes.io/instance-type'] || 'unknown',
          capacityType: (labels['eks.amazonaws.com/capacityType'] === 'SPOT'
            ? 'SPOT'
            : labels['eks.amazonaws.com/capacityType'] === 'ON_DEMAND'
              ? 'ON_DEMAND'
              : 'unknown') as 'SPOT' | 'ON_DEMAND' | 'unknown',
          zone: labels['topology.kubernetes.io/zone']
            || labels['failure-domain.beta.kubernetes.io/zone'] || 'unknown',
          nodeGroup: labels['eks.amazonaws.com/nodegroup'] || 'unknown',
          uptime: this.getAge(node.metadata?.creationTimestamp),
          spotTerminating,
        };
      });
    } catch (err) {
      logger.error('Failed to get nodes', err);
      return [];
    }
  }

  async restartDeployment(namespace: string, deploymentName: string): Promise<boolean> {
    try {
      // Patch the deployment with a restart annotation (same as kubectl rollout restart)
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                'blue.y/restarted-by': 'blue.y-auto',
              },
            },
          },
        },
      };

      await this.appsApi.patchNamespacedDeployment(
        { name: deploymentName, namespace, body: patch },
        STRATEGIC_MERGE_PATCH,
      );

      logger.info(`Restarted deployment ${namespace}/${deploymentName}`);
      return true;
    } catch (err) {
      logger.error(`Failed to restart ${namespace}/${deploymentName}`, err);
      return false;
    }
  }

  async describePod(namespace: string, podName: string, format: 'html' | 'plain' = 'html'): Promise<string> {
    try {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace });
      const status = pod.status;
      const spec = pod.spec;
      const meta = pod.metadata;

      if (format === 'plain') {
        const lines: string[] = [
          `Pod: ${meta?.name}`,
          `Namespace: ${meta?.namespace}`,
          `Node: ${spec?.nodeName || 'unscheduled'}`,
          `Status: ${status?.phase}`,
          `IP: ${status?.podIP || 'none'}`,
          `Age: ${this.getAge(meta?.creationTimestamp)}`,
          '',
        ];
        (status?.containerStatuses || []).forEach((c) => {
          const state = Object.keys(c.state || {})[0] || 'unknown';
          const reason = c.state?.waiting?.reason || c.state?.terminated?.reason || '';
          lines.push(`Container: ${c.name}`);
          lines.push(`  State: ${state}${reason ? ` (${reason})` : ''}`);
          lines.push(`  Ready: ${c.ready ? 'Yes' : 'No'}`);
          lines.push(`  Restarts: ${c.restartCount}`);
          lines.push(`  Image: ${c.image}`);
        });
        return lines.join('\n');
      }

      // HTML format (for Telegram)
      const lines: string[] = [
        `<b>Pod:</b> ${meta?.name}`,
        `<b>Namespace:</b> ${meta?.namespace}`,
        `<b>Node:</b> ${spec?.nodeName || 'unscheduled'}`,
        `<b>Status:</b> ${status?.phase}`,
        `<b>IP:</b> ${status?.podIP || 'none'}`,
        `<b>Age:</b> ${this.getAge(meta?.creationTimestamp)}`,
        '',
      ];

      (status?.containerStatuses || []).forEach((c) => {
        const state = Object.keys(c.state || {})[0] || 'unknown';
        const reason = c.state?.waiting?.reason || c.state?.terminated?.reason || '';
        lines.push(`<b>Container:</b> ${c.name}`);
        lines.push(`  State: ${state}${reason ? ` (${reason})` : ''}`);
        lines.push(`  Ready: ${c.ready ? 'Yes' : 'No'}`);
        lines.push(`  Restarts: ${c.restartCount}`);
        lines.push(`  Image: <code>${c.image}</code>`);
      });

      return lines.join('\n');
    } catch (err) {
      return `Error describing pod: ${(err as Error).message}`;
    }
  }

  async getEvents(namespace: string, podName?: string): Promise<string> {
    try {
      const res = await this.coreApi.listNamespacedEvent({ namespace });
      let events = res.items || [];

      if (podName) {
        events = events.filter((e) => e.involvedObject?.name?.includes(podName));
      }

      // Sort by last timestamp, take last 15
      events.sort((a, b) => {
        const ta = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
        const tb = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
        return tb - ta;
      });
      events = events.slice(0, 15);

      if (events.length === 0) return 'No recent events found.';

      return events.map((e) => {
        const icon = e.type === 'Warning' ? '⚠️' : 'ℹ️';
        const ago = this.getAge(e.lastTimestamp || e.eventTime ? new Date(e.lastTimestamp || e.eventTime || '') : undefined);
        return `${icon} ${ago} — ${e.reason}: ${e.message?.substring(0, 200)}`;
      }).join('\n');
    } catch (err) {
      return `Error fetching events: ${(err as Error).message}`;
    }
  }

  async getDeployments(namespace: string): Promise<{
    name: string; namespace: string; replicas: number; readyReplicas: number;
    availableReplicas: number; image: string; age: string;
    conditions: { type: string; status: string; reason?: string }[];
  }[]> {
    try {
      const res = await this.appsApi.listNamespacedDeployment({ namespace });
      return (res.items || []).map((d) => {
        const containers = d.spec?.template?.spec?.containers || [];
        return {
          name: d.metadata?.name || 'unknown',
          namespace,
          replicas: d.spec?.replicas ?? d.status?.replicas ?? 0,
          readyReplicas: d.status?.readyReplicas || 0,
          availableReplicas: d.status?.availableReplicas || 0,
          image: containers[0]?.image || 'unknown',
          age: this.getAge(d.metadata?.creationTimestamp),
          conditions: (d.status?.conditions || []).map(c => ({
            type: c.type, status: c.status, reason: c.reason,
          })),
        };
      });
    } catch (err) {
      logger.error(`Failed to get deployments in ${namespace}`, err);
      return [];
    }
  }

  async scaleDeployment(namespace: string, deploymentName: string, replicas: number): Promise<boolean> {
    try {
      await this.appsApi.patchNamespacedDeployment(
        { name: deploymentName, namespace, body: { spec: { replicas } } },
        STRATEGIC_MERGE_PATCH,
      );
      logger.info(`Scaled ${namespace}/${deploymentName} to ${replicas} replicas`);
      return true;
    } catch (err) {
      logger.error(`Failed to scale ${namespace}/${deploymentName}`, err);
      return false;
    }
  }

  // BLY-68: Deployment rollback — list ReplicaSet revision history
  async getDeploymentHistory(namespace: string, deploymentName: string): Promise<{
    revision: number; image: string; images: string[];
    createdAt: string; age: string; replicas: number; readyReplicas: number; isCurrent: boolean;
  }[]> {
    try {
      const [dep, rsList] = await Promise.all([
        this.appsApi.readNamespacedDeployment({ name: deploymentName, namespace }),
        this.appsApi.listNamespacedReplicaSet({ namespace }),
      ]);
      const currentRevision = parseInt(
        dep.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0', 10,
      );
      return (rsList.items || [])
        .filter(rs => (rs.metadata?.ownerReferences || []).some(
          ref => ref.kind === 'Deployment' && ref.name === deploymentName,
        ))
        .map(rs => {
          const rev = parseInt(
            rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0', 10,
          );
          const containers = rs.spec?.template?.spec?.containers || [];
          const images = containers.map(c => c.image || 'unknown');
          return {
            revision: rev,
            image: images[0] || 'unknown',
            images,
            createdAt: rs.metadata?.creationTimestamp?.toISOString() ?? '',
            age: this.getAge(rs.metadata?.creationTimestamp),
            replicas: rs.spec?.replicas ?? 0,
            readyReplicas: rs.status?.readyReplicas ?? 0,
            isCurrent: rev === currentRevision,
          };
        })
        .filter(r => r.revision > 0)
        .sort((a, b) => b.revision - a.revision);
    } catch (err) {
      logger.error(`Failed to get deployment history for ${namespace}/${deploymentName}`, err);
      return [];
    }
  }

  // BLY-68: Roll back to a specific ReplicaSet revision
  async rollbackDeployment(namespace: string, deploymentName: string, revision: number): Promise<boolean> {
    try {
      const rsList = await this.appsApi.listNamespacedReplicaSet({ namespace });
      const target = (rsList.items || []).find(rs =>
        (rs.metadata?.ownerReferences || []).some(
          ref => ref.kind === 'Deployment' && ref.name === deploymentName,
        ) &&
        parseInt(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0', 10) === revision,
      );
      if (!target) throw new Error(`Revision ${revision} not found for deployment ${deploymentName}`);
      await this.appsApi.patchNamespacedDeployment(
        { name: deploymentName, namespace, body: { spec: { template: target.spec?.template } } },
        STRATEGIC_MERGE_PATCH,
      );
      logger.info(`Rolled back ${namespace}/${deploymentName} to revision ${revision}`);
      return true;
    } catch (err) {
      logger.error(`Failed to rollback ${namespace}/${deploymentName} to revision ${revision}`, err);
      return false;
    }
  }

  async getDeploymentDetail(namespace: string, deploymentName: string): Promise<{
    name: string;
    replicas: number;
    readyReplicas: number;
    updatedReplicas: number;
    availableReplicas: number;
    image: string;
    lastUpdated: string;
    conditions: { type: string; status: string; reason?: string; message?: string }[];
  } | null> {
    try {
      const dep = await this.appsApi.readNamespacedDeployment({ name: deploymentName, namespace });
      const containers = dep.spec?.template?.spec?.containers || [];
      const conditions = dep.status?.conditions || [];
      return {
        name: dep.metadata?.name || deploymentName,
        replicas: dep.status?.replicas || 0,
        readyReplicas: dep.status?.readyReplicas || 0,
        updatedReplicas: dep.status?.updatedReplicas || 0,
        availableReplicas: dep.status?.availableReplicas || 0,
        image: containers[0]?.image || 'unknown',
        lastUpdated: this.getAge(dep.metadata?.creationTimestamp),
        conditions: conditions.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      };
    } catch (err) {
      logger.error(`Failed to get deployment detail ${namespace}/${deploymentName}`, err);
      return null;
    }
  }

  async getTopNodes(): Promise<{ name: string; cpu: string; memory: string }[]> {
    try {
      const metricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const res = await metricsApi.listClusterCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: 'nodes',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (res as any).items || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return items.map((item: any) => {
        const cpu = item.usage?.cpu || '0';
        const mem = item.usage?.memory || '0';
        const cpuMilli = cpu.endsWith('n') ? Math.round(parseInt(cpu) / 1_000_000)
          : cpu.endsWith('m') ? parseInt(cpu)
          : parseInt(cpu) * 1000;
        const memMi = mem.endsWith('Ki') ? Math.round(parseInt(mem) / 1024)
          : mem.endsWith('Mi') ? parseInt(mem)
          : mem.endsWith('Gi') ? parseInt(mem) * 1024
          : Math.round(parseInt(mem) / (1024 * 1024));
        return { name: item.metadata?.name || 'unknown', cpu: `${cpuMilli}m`, memory: `${memMi}Mi` };
      });
    } catch (err) {
      logger.error('Failed to get node metrics', err);
      return [];
    }
  }

  async getTopPods(namespace: string): Promise<{ name: string; cpu: string; memory: string }[]> {
    try {
      // Use metrics API
      const metricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const res = await metricsApi.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace,
        plural: 'pods',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (res as any).items || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return items.map((item: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const containers = item.containers || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalCpu = containers.reduce((sum: number, c: any) => {
          const cpu = c.usage?.cpu || '0';
          // Convert nanoCPU to millicores
          if (cpu.endsWith('n')) return sum + parseInt(cpu) / 1_000_000;
          if (cpu.endsWith('m')) return sum + parseInt(cpu);
          return sum + parseInt(cpu) * 1000;
        }, 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalMem = containers.reduce((sum: number, c: any) => {
          const mem = c.usage?.memory || '0';
          if (mem.endsWith('Ki')) return sum + parseInt(mem) / 1024;
          if (mem.endsWith('Mi')) return sum + parseInt(mem);
          if (mem.endsWith('Gi')) return sum + parseInt(mem) * 1024;
          return sum + parseInt(mem) / (1024 * 1024);
        }, 0);
        return {
          name: item.metadata?.name || 'unknown',
          cpu: `${Math.round(totalCpu)}m`,
          memory: `${Math.round(totalMem)}Mi`,
        };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }).sort((a: any, b: any) => parseInt(b.memory) - parseInt(a.memory));
    } catch (err) {
      logger.error(`Failed to get pod metrics for ${namespace}`, err);
      return [];
    }
  }

  async getHPAs(namespace: string): Promise<HPAInfo[]> {
    try {
      const autoscalingApi = this.kc.makeApiClient(k8s.AutoscalingV2Api);
      const res = await autoscalingApi.listNamespacedHorizontalPodAutoscaler({ namespace });
      return (res.items || []).map((hpa) => {
        const metrics: HPAInfo['metrics'] = [];

        // Parse current metrics from status
        (hpa.status?.currentMetrics || []).forEach((cm) => {
          if (cm.type === 'Resource' && cm.resource) {
            const current = cm.resource.current?.averageUtilization || 0;
            // Find matching target spec
            const targetSpec = (hpa.spec?.metrics || []).find(
              (m) => m.type === 'Resource' && m.resource?.name === cm.resource!.name,
            );
            const target = targetSpec?.resource?.target?.averageUtilization || 0;
            metrics.push({
              type: 'Resource',
              name: cm.resource.name,
              current,
              target,
              unit: '%',
            });
          }
        });

        // If no current metrics yet, at least show target specs
        if (metrics.length === 0) {
          (hpa.spec?.metrics || []).forEach((m) => {
            if (m.type === 'Resource' && m.resource) {
              metrics.push({
                type: 'Resource',
                name: m.resource.name,
                current: 0,
                target: m.resource.target?.averageUtilization || 0,
                unit: '%',
              });
            }
          });
        }

        return {
          name: hpa.metadata?.name || 'unknown',
          namespace: hpa.metadata?.namespace || namespace,
          targetRef: `${hpa.spec?.scaleTargetRef?.kind}/${hpa.spec?.scaleTargetRef?.name}`,
          minReplicas: hpa.spec?.minReplicas || 1,
          maxReplicas: hpa.spec?.maxReplicas || 1,
          currentReplicas: hpa.status?.currentReplicas || 0,
          desiredReplicas: hpa.status?.desiredReplicas || 0,
          metrics,
          conditions: (hpa.status?.conditions || []).map((c) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
          })),
        };
      });
    } catch (err) {
      logger.error(`Failed to get HPAs in ${namespace}`, err);
      return [];
    }
  }

  // BLY-69: Rich pod/node detail — node resources, container resources, scheduling, volumes
  async getPodDetail(namespace: string, podName: string): Promise<PodDetail | null> {
    try {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace });
      const spec = pod.spec!;
      const status = pod.status!;
      const meta = pod.metadata!;
      const nodeName = spec.nodeName || '';

      // Inline parsers (same logic as getTopNodes/getTopPods)
      const cpuToMilli = (s: string): number => {
        if (!s || s === '0') return 0;
        if (s.endsWith('n')) return Math.round(parseInt(s) / 1_000_000);
        if (s.endsWith('m')) return parseInt(s);
        return parseInt(s) * 1000;
      };
      const memToMi = (s: string): number => {
        if (!s || s === '0') return 0;
        if (s.endsWith('Ki')) return Math.round(parseInt(s) / 1024);
        if (s.endsWith('Mi')) return parseInt(s);
        if (s.endsWith('Gi')) return parseInt(s) * 1024;
        if (s.endsWith('Ti')) return parseInt(s) * 1024 * 1024;
        return Math.round(parseInt(s) / (1024 * 1024));
      };

      // Pod container metrics (optional — graceful degradation)
      const containerUsage: Record<string, { cpuMilli: number; memMi: number }> = {};
      try {
        const metricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
        const res = await metricsApi.listNamespacedCustomObject({
          group: 'metrics.k8s.io', version: 'v1beta1', namespace, plural: 'pods',
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const podMetric = ((res as any).items || []).find((p: any) => p.metadata?.name === podName);
        if (podMetric) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (podMetric.containers || []).forEach((c: any) => {
            containerUsage[c.name] = {
              cpuMilli: cpuToMilli(c.usage?.cpu || '0'),
              memMi:    memToMi(c.usage?.memory || '0'),
            };
          });
        }
      } catch { /* metrics-server unavailable */ }

      // Container specs
      const containerStatuses = status.containerStatuses || [];
      const containers: PodDetail['containers'] = (spec.containers || []).map(c => {
        const cs = containerStatuses.find(s => s.name === c.name);
        const usage = containerUsage[c.name];
        return {
          name: c.name,
          image: c.image || 'unknown',
          state: Object.keys(cs?.state || {})[0] || 'unknown',
          reason: cs?.state?.waiting?.reason || cs?.state?.terminated?.reason,
          ready: cs?.ready ?? false,
          restartCount: cs?.restartCount ?? 0,
          cpuRequest: cpuToMilli(c.resources?.requests?.cpu   || '0'),
          cpuLimit:   cpuToMilli(c.resources?.limits?.cpu     || '0'),
          memRequest: memToMi(c.resources?.requests?.memory   || '0'),
          memLimit:   memToMi(c.resources?.limits?.memory     || '0'),
          cpuUsage: usage?.cpuMilli,
          memUsage: usage?.memMi,
        };
      });

      // Node info (optional)
      let node: PodDetail['node'] = null;
      if (nodeName) {
        try {
          const nodeObj = await this.coreApi.readNode({ name: nodeName });
          const nodeLabels = nodeObj.metadata?.labels || {};
          const taints = (nodeObj.spec?.taints || []).map(t => ({
            key: t.key || '', effect: t.effect || '', value: t.value,
          }));
          const cpuAllocatable = cpuToMilli(nodeObj.status?.allocatable?.cpu    || '0');
          const memAllocatable = memToMi(nodeObj.status?.allocatable?.memory    || '0');

          let cpuUsage: number | undefined;
          let memUsage: number | undefined;
          try {
            const metricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
            const res = await metricsApi.listClusterCustomObject({
              group: 'metrics.k8s.io', version: 'v1beta1', plural: 'nodes',
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const nm = ((res as any).items || []).find((n: any) => n.metadata?.name === nodeName);
            if (nm) {
              cpuUsage = cpuToMilli(nm.usage?.cpu    || '0');
              memUsage = memToMi(nm.usage?.memory    || '0');
            }
          } catch { /* ignore */ }

          const labelKeys = [
            'node.kubernetes.io/instance-type',
            'eks.amazonaws.com/capacityType',
            'eks.amazonaws.com/nodegroup',
            'topology.kubernetes.io/zone',
            'kubernetes.io/hostname',
            'kubernetes.io/arch',
          ];
          const labels: Record<string, string> = {};
          labelKeys.forEach(k => { if (nodeLabels[k]) labels[k] = nodeLabels[k]; });

          node = {
            name: nodeName,
            instanceType: nodeLabels['node.kubernetes.io/instance-type'] || 'unknown',
            capacityType: nodeLabels['eks.amazonaws.com/capacityType']   || 'unknown',
            zone:      nodeLabels['topology.kubernetes.io/zone']          || 'unknown',
            nodeGroup: nodeLabels['eks.amazonaws.com/nodegroup']          || 'unknown',
            cpuAllocatable, memAllocatable, cpuUsage, memUsage,
            taints, labels,
          };
        } catch (e) {
          logger.warn(`[getPodDetail] Could not fetch node ${nodeName}: ${e}`);
        }
      }

      // Volumes
      const volumes: PodDetail['pod']['volumes'] = (spec.volumes || []).map(v => {
        let type = 'other';
        let claim: string | undefined;
        if (v.persistentVolumeClaim) { type = 'pvc';       claim = v.persistentVolumeClaim.claimName; }
        else if (v.configMap)         type = 'configMap';
        else if (v.secret)            type = 'secret';
        else if (v.emptyDir)          type = 'emptyDir';
        else if (v.hostPath)          type = 'hostPath';
        return { name: v.name, type, claim };
      });

      return {
        pod: {
          name: meta.name || podName, namespace, nodeName,
          phase: status.phase || 'Unknown',
          qosClass: status.qosClass || 'Unknown',
          ip: status.podIP || '',
          age: this.getAge(meta.creationTimestamp),
          tolerations: (spec.tolerations || []).map(t => ({
            key: t.key, operator: t.operator, effect: t.effect, value: t.value,
          })),
          nodeSelector: spec.nodeSelector || {},
          volumes,
        },
        containers,
        node,
      };
    } catch (err) {
      logger.error(`Failed to get pod detail for ${namespace}/${podName}`, err);
      return null;
    }
  }

  async findPod(podName: string): Promise<{ pod: PodInfo; namespace: string } | null> {
    for (const ns of config.kube.namespaces) {
      const pods = await this.getPods(ns);
      const match = pods.find((p) => p.name.includes(podName));
      if (match) return { pod: match, namespace: ns };
    }
    return null;
  }

  async findDeployment(name: string): Promise<{ deployment: string; namespace: string } | null> {
    for (const ns of config.kube.namespaces) {
      const deps = await this.getDeployments(ns);
      const match = deps.find((d) => d.name.includes(name));
      if (match) return { deployment: match.name, namespace: ns };
    }
    return null;
  }

  /**
   * Auto-discover production URLs from Ingress resources across all user namespaces.
   * Used as a fallback when PRODUCTION_URLS is not configured.
   * Returns one entry per unique host (path is ignored — we test the root).
   */
  async getIngressUrls(): Promise<{ name: string; url: string; expect: number }[]> {
    try {
      const namespaces = await this.getUserNamespaces();
      const seen = new Set<string>();
      const results: { name: string; url: string; expect: number }[] = [];

      for (const ns of namespaces) {
        try {
          const res = await this.networkingApi.listNamespacedIngress({ namespace: ns });
          for (const ingress of res.items || []) {
            const ingressName = ingress.metadata?.name || 'unknown';
            for (const rule of ingress.spec?.rules || []) {
              const host = rule.host;
              if (!host || seen.has(host)) continue;
              seen.add(host);
              results.push({
                name: `${ingressName} (${ns})`,
                url: `https://${host}`,
                expect: 200,
              });
            }
          }
        } catch { /* namespace may not have networking access */ }
      }
      return results;
    } catch (err) {
      logger.warn(`Failed to auto-discover ingress URLs: ${err}`);
      return [];
    }
  }

  // BLY-77: Network Explorer — list ingresses with TLS health
  async listIngresses(namespace: string): Promise<IngressInfo[]> {
    try {
      const res = await this.networkingApi.listNamespacedIngress({ namespace });
      const items = res.items || [];

      const secretRes = await this.coreApi
        .listNamespacedSecret({ namespace, fieldSelector: 'type=kubernetes.io/tls' })
        .catch(() => ({ items: [] as k8s.V1Secret[] }));
      const tlsSecrets = new Map<string, Date | null>();
      for (const secret of secretRes.items || []) {
        const sName = secret.metadata?.name || '';
        const expiry = secret.metadata?.annotations?.['cert-manager.io/certificate-expiry'];
        tlsSecrets.set(sName, expiry ? new Date(expiry) : null);
      }

      const now = new Date();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;

      return items.map((ingress): IngressInfo => {
        const tls = (ingress.spec?.tls || []).map((t) => ({
          hosts: t.hosts || [],
          secretName: t.secretName || '',
        }));

        let tlsStatus: IngressInfo['tlsStatus'] = 'none';
        if (tls.length > 0) {
          const sName = tls[0].secretName;
          if (!sName || !tlsSecrets.has(sName)) {
            tlsStatus = 'missing-secret';
          } else {
            const expiresAt = tlsSecrets.get(sName) ?? null;
            if (expiresAt === null) {
              tlsStatus = 'valid';
            } else if (expiresAt < now) {
              tlsStatus = 'expired';
            } else if (expiresAt.getTime() - now.getTime() < thirtyDays) {
              tlsStatus = 'expiring';
            } else {
              tlsStatus = 'valid';
            }
          }
        }

        const rules = (ingress.spec?.rules || []).map((rule) => ({
          host: rule.host || '*',
          paths: (rule.http?.paths || []).map((p) => ({
            path: p.path || '/',
            pathType: (p.pathType as string) || 'Prefix',
            serviceName: p.backend?.service?.name || '',
            servicePort: (p.backend?.service?.port as any)?.number ?? (p.backend?.service?.port as any)?.name ?? 0,
          })),
        }));

        return {
          name: ingress.metadata?.name || '',
          namespace: ingress.metadata?.namespace || namespace,
          ingressClass:
            (ingress.spec as any)?.ingressClassName ??
            ingress.metadata?.annotations?.['kubernetes.io/ingress.class'] ??
            null,
          rules,
          tls,
          tlsStatus,
          annotations: (ingress.metadata?.annotations as Record<string, string>) || {},
          createdAt: (ingress.metadata?.creationTimestamp as any)?.toISOString?.() ?? null,
          raw: ingress,
        };
      });
    } catch (err) {
      logger.error(`[kube] Failed to list ingresses in ${namespace}:`, err);
      return [];
    }
  }

  // BLY-77: List services with endpoint health + dead/orphan detection
  async listServicesWithHealth(namespace: string): Promise<ServiceInfo[]> {
    try {
      const [svcRes, allIngresses] = await Promise.all([
        this.coreApi.listNamespacedService({ namespace }),
        this.listIngresses(namespace).catch(() => [] as IngressInfo[]),
      ]);

      const ingressRefs = new Set<string>();
      for (const ing of allIngresses) {
        for (const rule of ing.rules) {
          for (const path of rule.paths) {
            if (path.serviceName) ingressRefs.add(path.serviceName);
          }
        }
      }

      return await Promise.all(
        (svcRes.items || []).map(async (svc): Promise<ServiceInfo> => {
          const name = svc.metadata?.name || '';
          const type = svc.spec?.type || 'ClusterIP';
          const selector = (svc.spec?.selector as Record<string, string>) || {};
          const hasSelector = Object.keys(selector).length > 0;

          let endpointsReady = 0;
          let endpointsTotal = 0;

          if (hasSelector && type !== 'ExternalName') {
            try {
              const ep = await this.coreApi.readNamespacedEndpoints({ namespace, name });
              for (const subset of (ep as any).subsets || []) {
                endpointsReady += (subset.addresses || []).length;
                endpointsTotal += (subset.addresses || []).length + (subset.notReadyAddresses || []).length;
              }
            } catch { /* no endpoints resource yet */ }
          }

          const lbIngress = svc.status?.loadBalancer?.ingress || [];
          const externalIP =
            lbIngress.length > 0
              ? (lbIngress[0] as any).ip || (lbIngress[0] as any).hostname || null
              : (svc.spec?.externalIPs?.[0] ?? null);

          const ports = (svc.spec?.ports || []).map((p) => {
            const tp = p.targetPort as any;
            return {
              name: p.name,
              port: p.port,
              targetPort: (tp?.intVal ?? tp?.strVal ?? tp) || p.port,
              protocol: p.protocol || 'TCP',
              nodePort: p.nodePort,
            };
          });

          return {
            name,
            namespace: svc.metadata?.namespace || namespace,
            type,
            clusterIP: svc.spec?.clusterIP || '',
            externalIP,
            ports,
            selector,
            endpointsReady,
            endpointsTotal,
            isDead: hasSelector && endpointsTotal === 0,
            isOrphan: !ingressRefs.has(name),
            createdAt: (svc.metadata?.creationTimestamp as any)?.toISOString?.() ?? null,
            raw: svc,
          };
        }),
      );
    } catch (err) {
      logger.error(`[kube] Failed to list services in ${namespace}:`, err);
      return [];
    }
  }

  // BLY-77: List network policies with affected pod count
  async listNetworkPolicies(namespace: string): Promise<NetworkPolicyInfo[]> {
    try {
      const [npRes, podRes] = await Promise.all([
        this.networkingApi.listNamespacedNetworkPolicy({ namespace }),
        this.coreApi.listNamespacedPod({ namespace }).catch(() => ({ items: [] as k8s.V1Pod[] })),
      ]);

      const runningPods = (podRes.items || []).filter((p) => p.status?.phase === 'Running');

      return (npRes.items || []).map((np): NetworkPolicyInfo => {
        const podSelector = (np.spec?.podSelector?.matchLabels as Record<string, string>) || {};

        const affectedPods = runningPods
          .filter((pod) => {
            const podLabels = (pod.metadata?.labels as Record<string, string>) || {};
            return Object.entries(podSelector).every(([k, v]) => podLabels[k] === v);
          })
          .map((pod) => pod.metadata?.name || '')
          .filter(Boolean);

        const ingressRules = np.spec?.ingress || [];
        const egressRules = np.spec?.egress || [];
        const isDefaultDeny =
          Object.keys(podSelector).length === 0 &&
          ingressRules.length === 0 &&
          egressRules.length === 0;

        return {
          name: np.metadata?.name || '',
          namespace: np.metadata?.namespace || namespace,
          podSelector,
          affectedPods,
          ingressRuleCount: ingressRules.length,
          egressRuleCount: egressRules.length,
          isDefaultDeny,
          createdAt: (np.metadata?.creationTimestamp as any)?.toISOString?.() ?? null,
          raw: np,
        };
      });
    } catch (err) {
      logger.error(`[kube] Failed to list network policies in ${namespace}:`, err);
      return [];
    }
  }

  // BLY-77: Walk full Ingress→Service→Endpoints chain for health dashboard
  async routeHealthWalk(namespace: string): Promise<RouteHealth[]> {
    try {
      const ingresses = await this.listIngresses(namespace);
      const results: RouteHealth[] = [];

      for (const ingress of ingresses) {
        for (const rule of ingress.rules) {
          for (const path of rule.paths) {
            if (!path.serviceName) continue;

            const result: RouteHealth = {
              ingressName: ingress.name,
              namespace,
              host: rule.host,
              path: path.path,
              serviceName: path.serviceName,
              servicePort: path.servicePort,
              health: 'green',
              breakpoint: 'none',
              endpointsReady: 0,
              endpointsTotal: 0,
            };

            try {
              const svc = await this.coreApi.readNamespacedService({ namespace, name: path.serviceName });
              const selector = (svc.spec?.selector as Record<string, string>) || {};

              if (Object.keys(selector).length === 0) {
                result.health = 'green'; // headless / external — no endpoints to check
              } else {
                try {
                  const ep = await this.coreApi.readNamespacedEndpoints({ namespace, name: path.serviceName });
                  let ready = 0;
                  let total = 0;
                  for (const subset of (ep as any).subsets || []) {
                    ready += (subset.addresses || []).length;
                    total += (subset.addresses || []).length + (subset.notReadyAddresses || []).length;
                  }
                  result.endpointsReady = ready;
                  result.endpointsTotal = total;

                  if (total === 0) {
                    result.health = 'red';
                    result.breakpoint = 'no-endpoints';
                    result.issue = `Service "${path.serviceName}" has no endpoints — selector may not match any pods`;
                  } else if (ready === 0) {
                    result.health = 'red';
                    result.breakpoint = 'pods-not-ready';
                    result.issue = `Service "${path.serviceName}" has ${total} endpoint(s) but none are ready`;
                  } else if (ready < total) {
                    result.health = 'yellow';
                    result.breakpoint = 'pods-not-ready';
                    result.issue = `Service "${path.serviceName}": ${ready}/${total} endpoints ready`;
                  }
                } catch {
                  result.health = 'red';
                  result.breakpoint = 'no-endpoints';
                  result.issue = `Could not read endpoints for service "${path.serviceName}"`;
                }
              }
            } catch {
              result.health = 'red';
              result.breakpoint = 'service-missing';
              result.issue = `Service "${path.serviceName}" not found in namespace ${namespace}`;
            }

            results.push(result);
          }
        }
      }
      return results;
    } catch (err) {
      logger.error(`[kube] Route health walk failed in ${namespace}:`, err);
      return [];
    }
  }

  // BLY-77: Write operations (require blue-y-network-write ClusterRole verbs)
  async createIngress(namespace: string, body: k8s.V1Ingress): Promise<k8s.V1Ingress> {
    return this.networkingApi.createNamespacedIngress({ namespace, body });
  }

  async updateIngress(namespace: string, name: string, body: k8s.V1Ingress): Promise<k8s.V1Ingress> {
    return this.networkingApi.replaceNamespacedIngress({ namespace, name, body });
  }

  async deleteIngress(namespace: string, name: string): Promise<void> {
    await this.networkingApi.deleteNamespacedIngress({ namespace, name });
  }

  async createService(namespace: string, body: k8s.V1Service): Promise<k8s.V1Service> {
    return this.coreApi.createNamespacedService({ namespace, body });
  }

  async updateService(namespace: string, name: string, body: k8s.V1Service): Promise<k8s.V1Service> {
    return this.coreApi.replaceNamespacedService({ namespace, name, body });
  }

  async deleteService(namespace: string, name: string): Promise<void> {
    await this.coreApi.deleteNamespacedService({ namespace, name });
  }

  // Namespaces that are internal to Kubernetes — excluded from /status, shown by /system-status
  static readonly SYSTEM_NAMESPACES = new Set([
    'kube-system', 'kube-public', 'kube-node-lease',
  ]);

  async getUserNamespaces(): Promise<string[]> {
    try {
      const res = await this.coreApi.listNamespace();
      return (res.items || [])
        .map((ns) => ns.metadata?.name || '')
        .filter((name) => name && !KubeClient.SYSTEM_NAMESPACES.has(name))
        .sort();
    } catch (err) {
      logger.warn(`Failed to list namespaces dynamically, falling back to config: ${err}`);
      return config.kube.namespaces;
    }
  }

  private async buildNsSummaryLines(namespaces: string[]): Promise<string[]> {
    const lines: string[] = [];
    for (const ns of namespaces) {
      const pods = await this.getPods(ns);
      const servicePods = pods.filter((p) => !p.isJobPod);
      const jobPods = pods.filter((p) => p.isJobPod);
      const running = servicePods.filter((p) => p.status === 'Running' && p.ready).length;
      const unhealthy = servicePods.filter((p) =>
        (p.status !== 'Running' && p.status !== 'Succeeded') ||
        (!p.ready && p.status === 'Running') ||
        p.restarts > 5,
      );
      const icon = unhealthy.length > 0 ? '❌' : '✅';
      let line = `${icon} <b>${ns}:</b> ${running}/${servicePods.length} healthy`;
      if (unhealthy.length > 0) line += ` (${unhealthy.length} issues)`;
      if (jobPods.length > 0) {
        const failedJobs = jobPods.filter((p) => p.status === 'Failed').length;
        const completedJobs = jobPods.filter((p) => p.status === 'Succeeded').length;
        line += ` + ${jobPods.length} jobs`;
        if (failedJobs > 0) line += ` (${failedJobs} failed)`;
        else if (completedJobs > 0) line += ` (${completedJobs} done)`;
      }
      lines.push(line);
    }
    return lines;
  }

  async getClusterSummary(): Promise<string> {
    const lines: string[] = ['<b>Cluster Summary</b>\n'];
    const nodes = await this.getNodes();
    lines.push(`🖥️ <b>Nodes:</b> ${nodes.length} (${nodes.filter((n) => n.status === 'Ready').length} ready)`);
    const namespaces = await this.getUserNamespaces();
    const nsLines = await this.buildNsSummaryLines(namespaces);
    lines.push(...nsLines);
    return lines.join('\n');
  }

  async getSystemSummary(): Promise<string> {
    const lines: string[] = ['<b>System Namespace Status</b>\n'];
    const systemNs = [...KubeClient.SYSTEM_NAMESPACES];
    const nsLines = await this.buildNsSummaryLines(systemNs);
    lines.push(...nsLines);
    // List notable pods by name so the operator can see ALB controller, coredns, etc.
    for (const ns of systemNs) {
      const pods = await this.getPods(ns);
      if (pods.length === 0) continue;
      lines.push(`\n<b>${ns} pods:</b>`);
      for (const pod of pods) {
        const icon = pod.status === 'Running' && pod.ready ? '✅' : '⚠️';
        lines.push(`  ${icon} ${pod.name} — ${pod.status} (restarts: ${pod.restarts})`);
      }
    }
    return lines.join('\n');
  }

  async getTLSSecrets(namespace: string): Promise<{ name: string; expiresAt: Date | null }[]> {
    try {
      const res = await this.coreApi.listNamespacedSecret({ namespace, fieldSelector: 'type=kubernetes.io/tls' });
      return (res.items || []).map((secret) => {
        let expiresAt: Date | null = null;
        const certData = secret.data?.['tls.crt'];
        if (certData) {
          // Parse cert expiry from base64-encoded PEM
          // In production, use a proper X.509 parser
          const annotation = secret.metadata?.annotations?.['cert-manager.io/certificate-expiry'];
          if (annotation) {
            expiresAt = new Date(annotation);
          }
        }
        return { name: secret.metadata?.name || 'unknown', expiresAt };
      });
    } catch (err) {
      logger.error(`Failed to get TLS secrets in ${namespace}`, err);
      return [];
    }
  }

  // Get pods that have recently restarted, with root cause analysis
  async getRecentlyRestartedPods(): Promise<{
    name: string;
    namespace: string;
    restarts: number;
    lastRestartReason: string;
    lastExitCode: number;
    lastRestartTime: string;
    oomKilled: boolean;
  }[]> {
    const results: {
      name: string; namespace: string; restarts: number;
      lastRestartReason: string; lastExitCode: number;
      lastRestartTime: string; oomKilled: boolean;
    }[] = [];

    for (const ns of config.kube.namespaces) {
      try {
        const res = await this.coreApi.listNamespacedPod({ namespace: ns });
        for (const pod of (res.items || [])) {
          for (const cs of (pod.status?.containerStatuses || [])) {
            if ((cs.restartCount || 0) > 0 && cs.lastState?.terminated) {
              const term = cs.lastState.terminated;
              const oomKilled = term.reason === 'OOMKilled';
              const restartTime = term.finishedAt ? new Date(term.finishedAt).toISOString() : 'unknown';

              // Only include pods restarted in last 24 hours
              if (term.finishedAt) {
                const hoursSinceRestart = (Date.now() - new Date(term.finishedAt).getTime()) / (1000 * 60 * 60);
                if (hoursSinceRestart > 24) continue;
              }

              results.push({
                name: pod.metadata?.name || 'unknown',
                namespace: ns,
                restarts: cs.restartCount || 0,
                lastRestartReason: term.reason || 'Unknown',
                lastExitCode: term.exitCode ?? -1,
                lastRestartTime: restartTime,
                oomKilled,
              });
            }
          }
        }
      } catch (err) {
        logger.error(`Failed to get restart info for ${ns}`, err);
      }
    }

    return results.sort((a, b) => b.restarts - a.restarts);
  }

  // Get resource usage vs requests/limits for efficiency analysis
  async getResourceEfficiency(namespace: string): Promise<{
    name: string;
    cpuRequest: string;
    cpuLimit: string;
    cpuUsage: string;
    memRequest: string;
    memLimit: string;
    memUsage: string;
    cpuEfficiency: number;
    memEfficiency: number;
  }[]> {
    try {
      const metrics = await this.getTopPods(namespace);
      const res = await this.coreApi.listNamespacedPod({ namespace });
      const results = [];

      for (const pod of (res.items || [])) {
        if (pod.status?.phase !== 'Running') continue;

        const podName = pod.metadata?.name || '';
        const metric = metrics.find((m) => m.name === podName);
        if (!metric) continue;

        let cpuReq = 0, cpuLim = 0, memReq = 0, memLim = 0;
        for (const c of (pod.spec?.containers || [])) {
          cpuReq += this.parseCpu(c.resources?.requests?.cpu);
          cpuLim += this.parseCpu(c.resources?.limits?.cpu);
          memReq += this.parseMem(c.resources?.requests?.memory);
          memLim += this.parseMem(c.resources?.limits?.memory);
        }

        const cpuUsage = this.parseCpu(metric.cpu);
        const memUsage = this.parseMem(metric.memory);

        results.push({
          name: podName,
          cpuRequest: `${cpuReq}m`,
          cpuLimit: `${cpuLim}m`,
          cpuUsage: metric.cpu,
          memRequest: `${memReq}Mi`,
          memLimit: `${memLim}Mi`,
          memUsage: metric.memory,
          cpuEfficiency: cpuReq > 0 ? Math.round((cpuUsage / cpuReq) * 100) : 0,
          memEfficiency: memReq > 0 ? Math.round((memUsage / memReq) * 100) : 0,
        });
      }

      return results;
    } catch (err) {
      logger.error(`Failed to get resource efficiency for ${namespace}`, err);
      return [];
    }
  }

  private parseCpu(cpu?: string): number {
    if (!cpu) return 0;
    if (cpu.endsWith('m')) return parseInt(cpu);
    if (cpu.endsWith('n')) return Math.round(parseInt(cpu) / 1_000_000);
    return Math.round(parseFloat(cpu) * 1000);
  }

  private parseMem(mem?: string): number {
    if (!mem) return 0;
    if (mem.endsWith('Ki')) return Math.round(parseInt(mem) / 1024);
    if (mem.endsWith('Mi')) return parseInt(mem);
    if (mem.endsWith('Gi')) return parseInt(mem) * 1024;
    return Math.round(parseInt(mem) / (1024 * 1024));
  }

  /**
   * Returns a map of node-name → { nodeGroup label, allocatableCpuMilli }
   * Reads the actual eks.amazonaws.com/nodegroup label from each node's metadata.
   */
  async getNodeGroupMap(): Promise<Map<string, { nodeGroup: string; allocatableCpuMilli: number }>> {
    try {
      const res = await this.coreApi.listNode();
      const map = new Map<string, { nodeGroup: string; allocatableCpuMilli: number }>();
      for (const node of (res.items || [])) {
        const name = node.metadata?.name || '';
        if (!name) continue;
        const labels = node.metadata?.labels || {};
        const nodeGroup = labels['eks.amazonaws.com/nodegroup'] || 'unknown';
        const cpuStr = node.status?.allocatable?.cpu || '0';
        const allocatableCpuMilli = cpuStr.endsWith('m')
          ? parseInt(cpuStr)
          : Math.round(parseFloat(cpuStr) * 1000);
        map.set(name, { nodeGroup, allocatableCpuMilli });
      }
      return map;
    } catch (err) {
      logger.error('Failed to get node group map', err);
      return new Map();
    }
  }

  /**
   * Stream pod logs as a writable stream (for admin SSE endpoint).
   * Returns the IncomingMessage so the caller can call .destroy() on disconnect.
   */
  async streamPodLogs(
    namespace: string,
    podName: string,
    container: string,
    writableStream: import('stream').Writable,
    opts: { tailLines?: number; follow?: boolean; timestamps?: boolean },
  ): Promise<{ abort: () => void } | null> {
    try {
      const log = new k8s.Log(this.kc);
      const handle = await log.log(
        namespace,
        podName,
        container || '',
        writableStream,
        (err) => { if (err) logger.debug(`Log stream ended: ${err?.message}`); },
        { follow: opts.follow ?? true, tailLines: opts.tailLines ?? 200, timestamps: opts.timestamps ?? false },
      );
      return handle as unknown as { abort: () => void };
    } catch (err) {
      logger.error(`Failed to stream logs ${namespace}/${podName}`, err);
      return null;
    }
  }

  /**
   * Get the BatchV1Api client for CronJob operations.
   */
  getBatchApi(): k8s.BatchV1Api {
    return this.kc.makeApiClient(k8s.BatchV1Api);
  }

  /**
   * Execute a command inside a pod container and return stdout.
   * Uses kubectl exec under the hood for reliability.
   */
  async execInPod(namespace: string, podName: string, command: string[], timeoutMs = 10000, container?: string): Promise<string> {
    const { execSync } = await import('child_process');
    const cmdStr = command.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(' ');
    const containerFlag = container ? `-c ${container}` : '';
    const result = execSync(
      `kubectl exec ${podName} -n ${namespace} ${containerFlag} -- ${cmdStr}`,
      { timeout: timeoutMs, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result;
  }

  private getAge(creationTimestamp?: Date): string {
    if (!creationTimestamp) return 'unknown';
    const diff = Date.now() - new Date(creationTimestamp).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d${hours}h`;
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
  }
}
