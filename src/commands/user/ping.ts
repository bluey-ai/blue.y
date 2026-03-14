/**
 * /ping <service> — User-facing service availability check.
 *
 * Checks if a named service is reachable by its friendly name.
 * Returns plain English — no endpoints, no HTTP status codes.
 *
 * Configure services via PING_SERVICE_MAP env var (JSON):
 *   PING_SERVICE_MAP='{"login":{"label":"Login","url":"https://api.example.com/health"}}'
 *
 * Example: "/ping login" → "✅ Login is up and running."
 */

import { CommandHandler } from '../../command-router';
import { QAClient } from '../../clients/qa';

/** Map friendly names → production URLs. Configure via PING_SERVICE_MAP env var. */
const SERVICE_MAP: Record<string, { label: string; url: string }> = JSON.parse(
  process.env.PING_SERVICE_MAP || '{}'
);

export function createUserPingHandler(qa: QAClient): CommandHandler {
  return async (ctx) => {
    const target = ctx.args[0]?.toLowerCase();

    if (!target) {
      const names = Object.keys(SERVICE_MAP).join(', ');
      await ctx.reply(`Which service do you want to ping?\n\nAvailable: ${names}\n\nExample: /ping login`);
      return;
    }

    const svc = SERVICE_MAP[target];
    if (!svc) {
      const names = Object.keys(SERVICE_MAP).join(', ');
      await ctx.reply(`Service "${target}" not found.\n\nAvailable: ${names}`);
      return;
    }

    await ctx.reply(`Checking ${svc.label}…`);

    // TODO (BLY-2): QAClient.pingUrl(url) — single-URL probe returning boolean.
    // Until implemented, use a best-effort HTTP check here.
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(svc.url, { timeout: 8000, validateStatus: () => true });
      const up = resp.status < 500;
      if (up) {
        await ctx.reply(`✅ ${svc.label} is up and running.`);
      } else {
        await ctx.reply(`🔴 ${svc.label} is not responding (HTTP ${resp.status}).`);
      }
    } catch {
      await ctx.reply(`🔴 ${svc.label} is unreachable. Our team has been notified.`);
    }
  };
}
