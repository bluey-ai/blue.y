import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramClient {
  private botToken: string;
  private chatId: string;

  constructor() {
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
  }

  async send(message: string, chatId?: string, opts?: Record<string, unknown>): Promise<boolean> {
    const targetChat = chatId || this.chatId;

    if (!this.botToken || !targetChat) {
      logger.warn('Telegram not configured — skipping message send');
      logger.info(`[Telegram mock] Chat: ${targetChat}, Message: ${message.substring(0, 100)}...`);
      return false;
    }

    try {
      // Telegram limit is 4096 chars
      const truncated = message.length > 4000
        ? message.substring(0, 3997) + '...'
        : message;

      await axios.post(
        `${TELEGRAM_API}/bot${this.botToken}/sendMessage`,
        {
          chat_id: targetChat,
          text: truncated,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...opts,
        },
        { timeout: 10000 },
      );

      logger.info(`Telegram message sent to ${targetChat}`);
      return true;
    } catch (err) {
      logger.error(`Telegram send failed to ${targetChat}`, err);
      return false;
    }
  }

  async sendAlert(severity: 'info' | 'warning' | 'critical', message: string): Promise<void> {
    const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
    const header = `${emoji} <b>BLUE.Y [${severity.toUpperCase()}]</b>`;
    const fullMessage = `${header}\n\n${message}\n\n⏰ ${new Date().toISOString()}`;

    await this.send(fullMessage);
  }
}
