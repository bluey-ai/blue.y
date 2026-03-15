/**
 * Slack Notifier — sends messages and alerts to a Slack channel.
 * Uses @slack/web-api (HTTP, no Socket Mode needed for outgoing).
 * Socket Mode (incoming commands) is handled separately in SlackBot (main.ts).
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN  — xoxb-... (Bot OAuth token)
 *   SLACK_CHANNEL_ID — channel ID to post to (e.g. C0123456789)
 *
 * HUBS-6133
 */

import { WebClient } from '@slack/web-api';
import { Notifier, AlertSeverity, SendOptions } from './interface';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const SEVERITY_ICON: Record<AlertSeverity, string> = {
  critical: ':red_circle:',
  high:     ':large_yellow_circle:',
  warning:  ':warning:',
  info:     ':information_source:',
};

// Convert Telegram HTML tags to Slack mrkdwn
function htmlToSlack(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, '*$1*')
    .replace(/<i>(.*?)<\/i>/gs, '_$1_')
    .replace(/<code>(.*?)<\/code>/gs, '`$1`')
    .replace(/<pre>(.*?)<\/pre>/gs, '```$1```')
    .replace(/<[^>]+>/g, ''); // strip remaining tags
}

export class SlackNotifier implements Notifier {
  readonly platform = 'slack';
  readonly enabled: boolean;

  private client: WebClient | null = null;

  constructor() {
    this.enabled = !!(config.slack.botToken && config.slack.channelId);
    if (this.enabled) {
      this.client = new WebClient(config.slack.botToken);
    }
  }

  async send(message: string, options?: SendOptions): Promise<void> {
    if (!this.enabled || !this.client) return;
    const channel = options?.target ?? config.slack.channelId;
    const text = options?.plainText ? message : htmlToSlack(message);
    try {
      await this.client.chat.postMessage({ channel, text, mrkdwn: true });
    } catch (err) {
      logger.error(`[Slack] send failed: ${err}`);
    }
  }

  async sendAlert(severity: AlertSeverity, message: string, options?: SendOptions): Promise<void> {
    if (!this.enabled || !this.client) return;
    const icon = SEVERITY_ICON[severity];
    const header = `${icon} *BLUE.Y [${severity.toUpperCase()}]*\n\n`;
    await this.send(header + message, options);
  }

  async sendDM(userId: string, message: string): Promise<void> {
    if (!this.enabled || !this.client) return;
    try {
      // Open DM conversation with user, then send
      const conv = await this.client.conversations.open({ users: userId });
      const channel = conv.channel?.id;
      if (!channel) return;
      await this.client.chat.postMessage({ channel, text: htmlToSlack(message), mrkdwn: true });
    } catch (err) {
      logger.error(`[Slack] sendDM(${userId}) failed: ${err}`);
    }
  }
}
