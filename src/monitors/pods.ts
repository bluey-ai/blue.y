import { Monitor, MonitorResult } from './base';
import { KubeClient, PodInfo } from '../clients/kube';
import { BedrockClient } from '../clients/bedrock';
import { logger } from '../utils/logger';

// Pods that crash frequently due to known reasons (don't alert)
const KNOWN_CRASHLOOP_PODS = [
  'doris-prod-be',  // Known OOM after nightly backup, auto-restarted by CronJob
];

export class PodMonitor implements Monitor {
  name = 'pods';

  constructor(
    private kube: KubeClient,
    private bedrock: BedrockClient,
  ) {}

  async check(): Promise<MonitorResult> {
    // getUnhealthyPods already filters out Job/CronJob pods
    const unhealthy = await this.kube.getUnhealthyPods();

    // Filter out known noisy pods
    const actionable = unhealthy.filter(
      (p) => !KNOWN_CRASHLOOP_PODS.some((known) => p.name.startsWith(known)),
    );

    if (actionable.length === 0) {
      return {
        monitor: this.name,
        healthy: true,
        issues: [],
        checkedAt: new Date(),
      };
    }

    const issues = await Promise.all(
      actionable.map(async (pod) => {
        const severity = this.classifySeverity(pod);
        let message = `${pod.namespace}/${pod.name}: ${pod.status}, restarts=${pod.restarts}`;

        // For critical issues, get logs and ask Bedrock for analysis
        if (severity === 'critical') {
          try {
            const logs = await this.kube.getPodLogs(pod.namespace, pod.name, 30);
            const analysis = await this.bedrock.analyze({
              type: 'pod_issue',
              message: `Pod ${pod.namespace}/${pod.name} is ${pod.status} with ${pod.restarts} restarts.\n\nRecent logs:\n${logs}`,
              context: { pod },
            });
            // Only use AI analysis if it's not an error message
            if (!analysis.analysis.startsWith('Error analyzing')) {
              message = analysis.analysis;
            }
          } catch (err) {
            logger.warn(`Skipping Bedrock analysis for ${pod.name}: ${err}`);
          }
        }

        return { resource: `${pod.namespace}/${pod.name}`, message, severity };
      }),
    );

    return {
      monitor: this.name,
      healthy: false,
      issues,
      checkedAt: new Date(),
    };
  }

  private classifySeverity(pod: PodInfo): 'info' | 'warning' | 'critical' {
    // CrashLoopBackOff or Error = critical
    if (pod.containers.some((c) => c.reason === 'CrashLoopBackOff' || c.reason === 'Error')) {
      return 'critical';
    }
    // Many restarts = warning
    if (pod.restarts > 10) return 'warning';
    // Not ready but running = info
    if (!pod.ready && pod.status === 'Running') return 'info';
    // Pending = warning
    if (pod.status === 'Pending') return 'warning';
    return 'info';
  }
}
