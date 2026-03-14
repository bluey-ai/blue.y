/**
 * Notifier interface — every messaging platform implements this.
 * Allows BLUE.Y to send alerts and messages without knowing
 * which platform the caller is on.
 *
 (Slack), BLY-3, BLY-3, BLY-3
 */

export type AlertSeverity = 'critical' | 'high' | 'warning' | 'info';

export interface SendOptions {
  /** If true, send as a private DM rather than the group/channel. */
  dm?: boolean;
  /** Platform-specific target (channel ID, chat ID, etc.). Overrides default. */
  target?: string;
  /** Disable HTML/markdown formatting — plain text only (required for WhatsApp). */
  plainText?: boolean;
}

export interface Notifier {
  readonly platform: string;
  readonly enabled: boolean;

  /**
   * Send a message to the default channel/chat.
   * HTML formatting is used by default (Telegram-style: <b>, <code>, etc.)
   * Set options.plainText = true for WhatsApp.
   */
  send(message: string, options?: SendOptions): Promise<void>;

  /**
   * Send an alert with severity prefix and icon.
   * Routes to the correct channel/severity based on config.
   */
  sendAlert(severity: AlertSeverity, message: string, options?: SendOptions): Promise<void>;

  /**
   * Send a direct message to a specific user by their platform ID.
   * Used for password reset responses, private notifications.
   */
  sendDM(userId: string, message: string): Promise<void>;
}
