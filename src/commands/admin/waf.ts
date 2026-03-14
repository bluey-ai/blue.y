/**
 * /waf — WAF status and threat summary (admin only).
 *
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * Migrates to this handler in BLY-2 (WAF ticketing).
 *

 */

import { CommandHandler } from '../../command-router';

export function createWafHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
