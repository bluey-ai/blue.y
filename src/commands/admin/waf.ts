/**
 * /waf — WAF status and threat summary (admin only).
 *
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * Migrates to this handler in HUBS-6131 (WAF ticketing).
 *
 * Jira: HUBS-6131
 */

import { CommandHandler } from '../../command-router';

export function createWafHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
