import { Monitor, MonitorResult } from './base';
import { KubeClient } from '../clients/kube';
import { BedrockClient } from '../clients/bedrock';
import { config } from '../config';

const EXPIRY_WARNING_DAYS = 14;
const EXPIRY_CRITICAL_DAYS = 7;

export class CertMonitor implements Monitor {
  name = 'certs';

  constructor(
    private kube: KubeClient,
    private bedrock: BedrockClient,
  ) {}

  async check(): Promise<MonitorResult> {
    const issues: MonitorResult['issues'] = [];

    for (const ns of config.kube.namespaces) {
      const secrets = await this.kube.getTLSSecrets(ns);

      for (const secret of secrets) {
        if (!secret.expiresAt) continue;

        const daysUntilExpiry = Math.floor(
          (secret.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );

        if (daysUntilExpiry <= EXPIRY_CRITICAL_DAYS) {
          issues.push({
            resource: `${ns}/${secret.name}`,
            message: `TLS cert ${secret.name} expires in ${daysUntilExpiry} days!`,
            severity: 'critical',
          });
        } else if (daysUntilExpiry <= EXPIRY_WARNING_DAYS) {
          issues.push({
            resource: `${ns}/${secret.name}`,
            message: `TLS cert ${secret.name} expires in ${daysUntilExpiry} days`,
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
