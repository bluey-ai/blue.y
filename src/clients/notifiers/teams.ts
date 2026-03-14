/**
 * MS Teams Notifier — STUB
 * Full implementation: BLY-3
 *
 * Uses Microsoft Bot Framework + Adaptive Cards.
 * Requires Azure Bot App ID + Client Secret.
 * Sends proactive messages to configured Teams channel.
 */

import { Notifier, AlertSeverity, SendOptions } from './interface';
import { logger } from '../../utils/logger';

export class TeamsNotifier implements Notifier {
  readonly platform = 'teams';
  readonly enabled = false; // enabled when TEAMS_APP_ID + TEAMS_APP_PASSWORD set

  async send(message: string, _options?: SendOptions): Promise<void> {
    logger.debug('[Teams] send() not yet implemented — BLY-3');
  }

  async sendAlert(severity: AlertSeverity, message: string, _options?: SendOptions): Promise<void> {
    logger.debug(`[Teams] sendAlert(${severity}) not yet implemented — BLY-3`);
  }

  async sendDM(userId: string, message: string): Promise<void> {
    logger.debug(`[Teams] sendDM(${userId}) not yet implemented — BLY-3`);
  }
}
