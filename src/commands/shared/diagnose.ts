/**
 * /diagnose <pod> — AI-powered pod diagnosis (admin only).
 *
 * Gathers describe + logs + events → DeepSeek analysis → Telegram report.
 * Stub — full implementation lives in main.ts handleTelegramCommand.

 *

 */

import { CommandHandler } from '../../command-router';

export function createDiagnoseHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
