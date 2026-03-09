import { Monitor, MonitorResult } from './base';
import { KubeClient } from '../clients/kube';
import { config } from '../config';

const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 85;

export class HPAMonitor implements Monitor {
  name = 'hpa';

  constructor(private kube: KubeClient) {}

  async check(): Promise<MonitorResult> {
    const issues: MonitorResult['issues'] = [];

    for (const ns of config.kube.namespaces) {
      const hpas = await this.kube.getHPAs(ns);

      for (const hpa of hpas) {
        // Check if at max replicas
        if (hpa.currentReplicas >= hpa.maxReplicas) {
          issues.push({
            resource: `${ns}/${hpa.name}`,
            message: `HPA ${hpa.name} is at max replicas (${hpa.currentReplicas}/${hpa.maxReplicas}) — may need manual scaling`,
            severity: 'warning',
          });
        }

        // Check metric thresholds
        for (const metric of hpa.metrics) {
          if (metric.current >= CRITICAL_THRESHOLD) {
            issues.push({
              resource: `${ns}/${hpa.name}`,
              message: `HPA ${hpa.name} ${metric.name} at ${metric.current}% (target: ${metric.target}%) — CRITICAL`,
              severity: 'critical',
            });
          } else if (metric.current >= WARNING_THRESHOLD) {
            issues.push({
              resource: `${ns}/${hpa.name}`,
              message: `HPA ${hpa.name} ${metric.name} at ${metric.current}% (target: ${metric.target}%) — approaching limit`,
              severity: 'warning',
            });
          }
        }

        // Check for ScalingLimited condition
        const limited = hpa.conditions.find((c) => c.type === 'ScalingLimited' && c.status === 'True');
        if (limited) {
          issues.push({
            resource: `${ns}/${hpa.name}`,
            message: `HPA ${hpa.name} scaling limited: ${limited.reason} — ${limited.message?.substring(0, 150)}`,
            severity: 'warning',
          });
        }
      }
    }

    return {
      monitor: this.name,
      healthy: issues.length === 0,
      issues,
      checkedAt: new Date(),
    };
  }
}
