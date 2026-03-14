/**
 * Slack Notifier — STUB
 * Full implementation: HUBS-6146
 *
 * Uses @slack/bolt with Socket Mode (no public URL needed).
 * Sends alerts to #ops-alerts channel, DMs to individuals.
 */

import { Notifier, AlertSeverity, SendOptions } from './interface';
import { logger } from '../../utils/logger';

export class SlackNotifier implements Notifier {
  readonly platform = 'slack';
  readonly enabled = false; // enabled when SLACK_BOT_TOKEN + SLACK_APP_TOKEN set

  async send(message: string, _options?: SendOptions): Promise<void> {
    logger.debug('[Slack] send() not yet implemented — HUBS-6146');
  }

  async sendAlert(severity: AlertSeverity, message: string, _options?: SendOptions): Promise<void> {
    logger.debug(`[Slack] sendAlert(${severity}) not yet implemented — HUBS-6146`);
  }

  async sendDM(userId: string, message: string): Promise<void> {
    logger.debug(`[Slack] sendDM(${userId}) not yet implemented — HUBS-6146`);
  }
}
