/**
 * /scan <repo> — Security scan of a Bitbucket repo (admin only).
 *
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * Migrates to this handler in HUBS-6131.
 *
 * Jira: HUBS-6131
 */

import { CommandHandler } from '../../command-router';

export function createScanHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
