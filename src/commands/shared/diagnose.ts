/**
 * /diagnose <pod> — AI-powered pod diagnosis (admin only).
 *
 * Gathers describe + logs + events → DeepSeek analysis → Telegram report.
 * Stub — full implementation lives in main.ts handleTelegramCommand.
 * Migrates to this handler in HUBS-6128.
 *
 * Jira: HUBS-6128
 */

import { CommandHandler } from '../../command-router';

export function createDiagnoseHandler(): CommandHandler {
  return async (_ctx) => {
    // Stub: handled by legacy main.ts.
  };
}
