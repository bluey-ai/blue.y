/**
 * /reset password — Self-service password reset for end users.
 *
 * Handles both command form ("/reset password aws") and natural language
 * ("reset my aws password"). The NLP detection lives in main.ts handleTelegramDM;
 * this handler covers the explicit /reset command for all platforms.
 *
 * Flow:
 *   1. User types: /reset password [service]
 *   2. If service unclear → ask which one
 *   3. Notify admin channel for approval
 *   4. Confirm to user that request is pending
 *

 */

import { CommandHandler } from '../../command-router';
import { NotificationRouter } from '../../notification-router';
import { ResponseFormatter } from '../../response-formatter';

const SERVICE_LABELS: Record<string, string> = {
  aws:       'AWS Console (IAM)',
  office365: 'Microsoft 365 (Office)',
  database:  'Database (RDS)',
  grafana:   'Grafana',
};

function detectService(args: string[]): string | null {
  const text = args.join(' ').toLowerCase();
  if (/aws|console|iam/.test(text)) return 'aws';
  if (/office|o365|m365|microsoft|outlook|teams|365/.test(text)) return 'office365';
  if (/database|db|rds|mysql|postgres/.test(text)) return 'database';
  if (/grafana/.test(text)) return 'grafana';
  return null;
}

export function createResetPasswordHandler(notificationRouter: NotificationRouter): CommandHandler {
  return async (ctx) => {
    // Strip leading "password" keyword if present: "/reset password aws" → args = ["password","aws"]
    const effectiveArgs = ctx.args[0]?.toLowerCase() === 'password' ? ctx.args.slice(1) : ctx.args;
    const service = detectService(effectiveArgs);

    if (!service) {
      await ctx.reply(
        `I can reset your password, but please specify which service:\n\n` +
        `• /reset password aws\n` +
        `• /reset password office365\n` +
        `• /reset password database\n` +
        `• /reset password grafana`,
      );
      return;
    }

    const label = SERVICE_LABELS[service];
    const userName = ctx.caller.displayName;

    // Notify admin channel
    await notificationRouter.broadcast(
      `🔐 <b>PASSWORD RESET REQUEST</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${userName}\n` +
      `🏷️ <b>Service:</b> ${label}\n` +
      `📱 <b>Platform:</b> ${ctx.caller.platform}\n` +
      `⏰ <b>Time:</b> ${new Date().toISOString()}\n\n` +
      `Reply /yes to approve or /no to deny.`,
    );

    // Confirm to user (plain text — may be WhatsApp)
    await ctx.reply(
      `Got it, ${userName}! Your password reset request for ${label} has been sent to the admin for approval.\n\n` +
      `I'll notify you once it's approved. This usually takes a few minutes.`,
    );
  };
}
