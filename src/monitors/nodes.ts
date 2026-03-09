import { Monitor, MonitorResult } from './base';
import { KubeClient } from '../clients/kube';
import { BedrockClient } from '../clients/bedrock';

export class NodeMonitor implements Monitor {
  name = 'nodes';

  constructor(
    private kube: KubeClient,
    private bedrock: BedrockClient,
  ) {}

  async check(): Promise<MonitorResult> {
    const nodes = await this.kube.getNodes();
    const issues: MonitorResult['issues'] = [];

    for (const node of nodes) {
      if (node.status !== 'Ready') {
        issues.push({
          resource: node.name,
          message: `Node ${node.name} is ${node.status}. Conditions: ${node.conditions.map((c) => `${c.type}=${c.status}`).join(', ')}`,
          severity: 'critical',
        });
      }

      // Check for pressure conditions
      for (const condition of node.conditions) {
        if (condition.type !== 'Ready' && condition.status === 'True') {
          issues.push({
            resource: node.name,
            message: `Node ${node.name} has ${condition.type} (${condition.reason})`,
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
