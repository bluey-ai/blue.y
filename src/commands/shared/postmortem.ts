/**
 * /postmortem [id] — AI-generated incident postmortem document (BLY-26).
 *
 * Usage:
 *   /postmortem         → postmortem for the last detected incident
 *   /postmortem 42      → postmortem for incident #42 from the SQLite database
 *
 * Full implementation lives in main.ts handleTelegramCommand.
 * This stub satisfies command registration.
 *

 */

import { CommandHandler } from '../../command-router';

export function createPostmortemHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
