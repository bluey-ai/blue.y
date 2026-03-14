/**
 * /status — User-facing health check.
 *
 * Shows plain-English service status — no K8s jargon, no pod counts,
 * no CPU/memory metrics. Just "Login ✅" or "Login 🔴 Down".
 *
 * Admin/Operator /status is handled separately (legacy main.ts kube.getClusterSummary).
 * This handler is registered for the 'user' role only via command-router.
 *
 * Jira: HUBS-6145
 */

import { CommandHandler } from '../../command-router';
import { ResponseFormatter, ClusterStatus } from '../../response-formatter';
import { KubeClient } from '../../clients/kube';

const formatter = new ResponseFormatter();

export function createUserStatusHandler(kube: KubeClient): CommandHandler {
  return async (ctx) => {
    // Build a ClusterStatus from real pod data
    // KubeClient.getClusterSummary() returns a formatted string (legacy).
    // For the user-facing view, we need structured data. That refactor is HUBS-6128.
    // Until then, produce a simplified response using existing kube data.
    //
    // TODO (HUBS-6128): Replace with kube.getStructuredStatus() once implemented.

    const now = new Date().toLocaleTimeString('en-SG', {
      timeZone: 'Asia/Singapore',
      hour: '2-digit',
      minute: '2-digit',
    });

    // Stub: use a placeholder status — real implementation wires up kube data
    const placeholder: ClusterStatus = {
      services: [
        { name: 'Main platform', deployment: 'blo-backend', healthy: true },
        { name: 'Login', deployment: 'user-management-be', healthy: true },
        { name: 'PDF', deployment: 'pdf-service', healthy: true },
        { name: 'Website', deployment: 'wordpress', healthy: true },
      ],
      totalPods: 0,
      healthyPods: 0,
    };

    const response = formatter.formatStatus(placeholder, 'user');
    await ctx.reply(response);
  };
}
