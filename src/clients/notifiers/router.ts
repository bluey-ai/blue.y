/**
 * NotifierRouter — sends messages to ALL configured platforms in parallel.
 *
 * Usage:
 *   const router = new NotifierRouter([telegramNotifier, slackNotifier]);
 *   await router.send('Hello from BLUE.Y');
 *   await router.sendAlert('critical', 'Pod crashed!');
 *
 * Alert severity routing:
 *   critical → all platforms, DM all admins + operators
 *   high     → channel only (no DMs)
 *   warning  → admin channel only
 *   info     → no notification (log only)
 */

import { Notifier, AlertSeverity, SendOptions } from './interface';
import { logger } from '../../utils/logger';

export class NotifierRouter implements Notifier {
  readonly platform = 'router';
  readonly enabled: boolean;

  constructor(private notifiers: Notifier[]) {
    this.enabled = notifiers.some((n) => n.enabled);
  }

  async send(message: string, options?: SendOptions): Promise<void> {
    await this.fanOut((n) => n.send(message, options));
  }

  async sendAlert(severity: AlertSeverity, message: string, options?: SendOptions): Promise<void> {
    if (severity === 'info') {
      logger.info(`[NotifierRouter] info-level alert (not sent): ${message.substring(0, 100)}`);
      return;
    }
    await this.fanOut((n) => n.sendAlert(severity, message, options));
  }

  async sendDM(userId: string, message: string): Promise<void> {
    // DMs are platform-specific — send to the platform that matches userId format
    // For now delegate to all (each notifier ignores unknown user ID formats)
    await this.fanOut((n) => n.sendDM(userId, message));
  }

  /** Send to a specific platform only. */
  async sendToPlatform(platform: string, message: string, options?: SendOptions): Promise<void> {
    const notifier = this.notifiers.find((n) => n.platform === platform && n.enabled);
    if (!notifier) {
      logger.warn(`[NotifierRouter] Platform '${platform}' not configured or not enabled`);
      return;
    }
    await notifier.send(message, options);
  }

  /** Get the notifier for a specific platform. */
  forPlatform(platform: string): Notifier | undefined {
    return this.notifiers.find((n) => n.platform === platform && n.enabled);
  }

  private async fanOut(fn: (n: Notifier) => Promise<void>): Promise<void> {
    const enabled = this.notifiers.filter((n) => n.enabled);
    await Promise.allSettled(
      enabled.map((n) =>
        fn(n).catch((err) => logger.error(`[NotifierRouter] ${n.platform} error: ${err}`)),
      ),
    );
  }
}
