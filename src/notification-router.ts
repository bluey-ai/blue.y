/**
 * NotificationRouter — routes alerts to the right audience based on severity.
 *
 * Severity routing:
 *   critical → all channels + DM all admins and operators
 *   high     → all channels (no DMs)
 *   warning  → admin channel only
 *   info     → logged only, no notification sent
 *
 * This sits above NotifierRouter (which fans out to platforms) and adds
 * audience logic on top. Think of NotifierRouter as the transport layer,
 * NotificationRouter as the routing policy layer.
 *
 * Jira: HUBS-6133
 */

import { NotifierRouter } from './clients/notifiers/router';
import { AlertSeverity } from './clients/notifiers/interface';
import { RBACConfig, UserConfig, Platform } from './rbac';
import { logger } from './utils/logger';

export class NotificationRouter {
  constructor(
    private notifiers: NotifierRouter,
    private rbacCfg: RBACConfig,
  ) {}

  /**
   * Route an alert to the correct audience based on severity.
   */
  async routeAlert(severity: AlertSeverity, message: string): Promise<void> {
    if (severity === 'info') {
      logger.info(`[Alert:info] ${message.substring(0, 200)}`);
      return;
    }

    // Send to the main channel on all enabled platforms
    await this.notifiers.sendAlert(severity, message);

    // Critical alerts: also DM every admin and operator
    if (severity === 'critical') {
      const recipients = [...this.rbacCfg.admins, ...this.rbacCfg.operators];
      await this.dmAll(recipients, `🚨 <b>CRITICAL ALERT</b>\n\n${message}`);
    }
  }

  /**
   * Send a DM to a specific user identified by platform + id.
   * Used for password reset responses, approval notifications, etc.
   */
  async sendDM(platform: Platform, userId: string, message: string): Promise<void> {
    const notifier = this.notifiers.forPlatform(platform);
    if (!notifier?.enabled) {
      logger.warn(`[NotificationRouter] No enabled notifier for platform: ${platform}`);
      return;
    }
    await notifier.sendDM(userId, message);
  }

  /**
   * Broadcast a message to all enabled platforms (no severity prefix).
   * Use for scheduled reports, status broadcasts, etc.
   */
  async broadcast(message: string): Promise<void> {
    await this.notifiers.send(message);
  }

  /** DM a list of users. Silently skips users whose platform is not enabled. */
  private async dmAll(users: UserConfig[], message: string): Promise<void> {
    await Promise.allSettled(
      users.map((u) => this.sendDM(u.platform, u.id, message)),
    );
  }
}
