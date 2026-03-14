/**
 * /logs <pod> — Fetch recent pod logs (operator/admin).
 *
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * This stub satisfies command registration; when BLY-2 is implemented,
 * the logic will move here and main.ts will delegate to this handler.
 *

 */

import { CommandHandler } from '../../command-router';

export function createLogsHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts — this path is not reached in production yet.
    // Command registration via CommandRouter.register('/logs', ...) is deferred to BLY-2.
  };
}
