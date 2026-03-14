/**
 * WhatsApp Notifier — STUB
 * Full implementation: HUBS-6148
 *
 * Uses Twilio WhatsApp API.
 * Plain text + emojis only (no HTML/markdown).
 * User-role channel only — not for DevOps alerts.
 */

import { Notifier, AlertSeverity, SendOptions } from './interface';
import { logger } from '../../utils/logger';

export class WhatsAppNotifier implements Notifier {
  readonly platform = 'whatsapp';
  readonly enabled = false; // enabled when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN set

  async send(message: string, _options?: SendOptions): Promise<void> {
    logger.debug('[WhatsApp] send() not yet implemented — HUBS-6148');
  }

  async sendAlert(severity: AlertSeverity, message: string, _options?: SendOptions): Promise<void> {
    // WhatsApp is user-channel only — only user-impact alerts go here
    logger.debug(`[WhatsApp] sendAlert(${severity}) not yet implemented — HUBS-6148`);
  }

  async sendDM(userId: string, message: string): Promise<void> {
    // userId = E.164 phone number
    logger.debug(`[WhatsApp] sendDM(${userId}) not yet implemented — HUBS-6148`);
  }
}
