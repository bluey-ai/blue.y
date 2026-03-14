/**
 * Telegram Notifier — wraps TelegramClient to implement the Notifier interface.
 * This is the production notifier; Slack/Teams/WhatsApp are added in P1 tickets.
 */

import { TelegramClient } from '../telegram';
import { Notifier, AlertSeverity, SendOptions } from './interface';

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: '🔴',
  high:     '🟡',
  warning:  '⚠️',
  info:     '🔵',
};

export class TelegramNotifier implements Notifier {
  readonly platform = 'telegram';
  readonly enabled: boolean;

  constructor(private client: TelegramClient) {
    this.enabled = !!process.env.TELEGRAM_BOT_TOKEN;
  }

  async send(message: string, options?: SendOptions): Promise<void> {
    if (!this.enabled) return;
    const chatId = options?.target ?? undefined;
    await this.client.send(message, chatId);
  }

  async sendAlert(severity: AlertSeverity, message: string, options?: SendOptions): Promise<void> {
    if (!this.enabled) return;
    const icon = SEVERITY_ICON[severity];
    const header = `${icon} <b>BLUE.Y [${severity.toUpperCase()}]</b>\n\n`;
    await this.send(header + message, options);
  }

  async sendDM(userId: string, message: string): Promise<void> {
    // Telegram: chat ID = user ID for DMs (works when user has started the bot)
    await this.send(message, { target: userId });
  }
}
