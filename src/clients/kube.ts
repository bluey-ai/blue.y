import * as k8s from '@kubernetes/client-node';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ready: boolean;
  age: string;
  containers: { name: string; state: string; reason?: string; restartCount: number }[];
}

export interface NodeInfo {
  name: string;
  status: string;
  roles: string[];
  allocatable: { cpu: string; memory: string };
  conditions: { type: string; status: string; reason?: string }[];
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
          p.status !== 'Running' && p.status !== 'Succeeded' ||
          !p.ready && p.status === 'Running' ||
          p.restarts > 5,
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
      // Patch the deployment with a restart annotation
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.appsApi as any).patchNamespacedDeployment({
        name: deploymentName,
        namespace,
        body: patch,
      });

      logger.info(`Restarted deployment ${namespace}/${deploymentName}`);
      return true;
    } catch (err) {
      logger.error(`Failed to restart ${namespace}/${deploymentName}`, err);
      return false;
    }
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
