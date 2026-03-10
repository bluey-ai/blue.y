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

export class KubeClient {
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
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
      return (res.items || []).map((node) => ({
        name: node.metadata?.name || 'unknown',
        status: node.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
          ? 'Ready'
          : 'NotReady',
        roles: Object.keys(node.metadata?.labels || {})
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
      }));
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

  async getDeployments(namespace: string): Promise<{ name: string; ready: string; replicas: number; available: number; age: string }[]> {
    try {
      const res = await this.appsApi.listNamespacedDeployment({ namespace });
      return (res.items || []).map((d) => ({
        name: d.metadata?.name || 'unknown',
        ready: `${d.status?.readyReplicas || 0}/${d.status?.replicas || 0}`,
        replicas: d.status?.replicas || 0,
        available: d.status?.availableReplicas || 0,
        age: this.getAge(d.metadata?.creationTimestamp),
      }));
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

  async getClusterSummary(): Promise<string> {
    const lines: string[] = ['<b>Cluster Summary</b>\n'];

    // Nodes
    const nodes = await this.getNodes();
    lines.push(`🖥️ <b>Nodes:</b> ${nodes.length} (${nodes.filter((n) => n.status === 'Ready').length} ready)`);

    // Pods per namespace — separate service pods from job pods
    for (const ns of config.kube.namespaces) {
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
      if (unhealthy.length > 0) {
        line += ` (${unhealthy.length} issues)`;
      }
      if (jobPods.length > 0) {
        const completedJobs = jobPods.filter((p) => p.status === 'Succeeded').length;
        const failedJobs = jobPods.filter((p) => p.status === 'Failed').length;
        line += ` + ${jobPods.length} jobs`;
        if (failedJobs > 0) line += ` (${failedJobs} failed)`;
        else if (completedJobs > 0) line += ` (${completedJobs} done)`;
      }
      lines.push(line);
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
   * Get the BatchV1Api client for CronJob operations.
   */
  getBatchApi(): k8s.BatchV1Api {
    return this.kc.makeApiClient(k8s.BatchV1Api);
  }

  /**
   * Execute a command inside a pod container and return stdout.
   * Uses kubectl exec under the hood for reliability.
   */
  async execInPod(namespace: string, podName: string, command: string[], timeoutMs = 10000): Promise<string> {
    const { execSync } = await import('child_process');
    const cmdStr = command.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(' ');
    const result = execSync(
      `kubectl exec ${podName} -n ${namespace} -c blo-backend -- ${cmdStr}`,
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
