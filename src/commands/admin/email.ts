/**
 * /email — Send email report via SES (admin only).
 *
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * Migrates to this handler in HUBS-6128.
 *
 * Jira: HUBS-6128
 */

import { CommandHandler } from '../../command-router';

export function createEmailHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
