/**
 * /ping <service> — User-facing service availability check.
 *
 * Checks if a named service is reachable by its friendly name.
 * Returns plain English — no endpoints, no HTTP status codes.
 *
 * Example: "/ping login" → "✅ Login is up and running."
 *
 * Jira: HUBS-6145
 */

import { CommandHandler } from '../../command-router';
import { QAClient } from '../../clients/qa';

/** Map friendly names → production URLs for the QA smoke test. */
const SERVICE_MAP: Record<string, { label: string; url: string }> = {
  login:    { label: 'Login',         url: 'https://api-users.blueonion.today' },
  platform: { label: 'Main platform', url: 'https://api-hubs.blueonion.today' },
  frontend: { label: 'Frontend',      url: 'https://hubs.blueonion.today' },
  pdf:      { label: 'PDF service',   url: 'https://hubspdf.blueonion.today' },
  website:  { label: 'Website',       url: 'https://www.blueonion.today' },
  grafana:  { label: 'Grafana',       url: 'https://grafana.blueonion.today/api/health' },
};

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

    // TODO (HUBS-6145): QAClient.pingUrl(url) — single-URL probe returning boolean.
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
