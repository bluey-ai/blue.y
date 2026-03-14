/**
 * /status — Technical cluster status (admin/operator view).
 *
 * Shows pod counts, CPU/memory, deployment names.
 * Delegates to KubeClient.getClusterSummary() (existing implementation in main.ts).
 *
 * This stub satisfies the command registration pattern.

 *

 */

import { CommandHandler } from '../../command-router';
import { KubeClient } from '../../clients/kube';
import { MonitorScheduler } from '../../scheduler';

export function createAdminStatusHandler(kube: KubeClient, scheduler: MonitorScheduler): CommandHandler {
  return async (ctx) => {
    // Delegate to existing implementation (same as main.ts handleTelegramCommand /status)
    const summary = await kube.getClusterSummary();
    const schedulerStatus = await scheduler.getStatus();
    await ctx.reply(`${summary}\n\n${schedulerStatus}`);
  };
}
