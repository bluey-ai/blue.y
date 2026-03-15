/**
 * Slack Bot — Socket Mode inbound command handler.
 *
 * Listens for:
 *   - @mentions: @BLUE.Y status
 *   - Slash command: /bluey status  (register in Slack app settings)
 *   - Direct messages to the bot
 *
 * Supports core read-only commands. Administrative commands (restart, scale, etc.)
 * remain Telegram-only until BLY-? (full platform-agnostic command refactor).
 *
 * Required env vars (in addition to SLACK_BOT_TOKEN):
 *   SLACK_APP_TOKEN — xapp-... (Socket Mode app-level token)
 *   SLACK_CHANNEL_ID — default channel for outbound alerts
 *
 * BLY-3
 */

import { App, LogLevel } from '@slack/bolt';
import { SlackNotifier } from './clients/notifiers/slack';
import { KubeClient } from './clients/kube';
import { MonitorScheduler } from './scheduler';
import { LoadMonitor } from './monitors/load';
import { config } from './config';
import { logger } from './utils/logger';

interface SlackBotDeps {
  kube: KubeClient;
  scheduler: MonitorScheduler;
  loadMonitor: LoadMonitor;
  notifier: SlackNotifier;
}

// Convert Telegram HTML → Slack mrkdwn (reused from SlackNotifier)
function htmlToSlack(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gs, '*$1*')
    .replace(/<i>(.*?)<\/i>/gs, '_$1_')
    .replace(/<code>(.*?)<\/code>/gs, '`$1`')
    .replace(/<pre>(.*?)<\/pre>/gs, '```$1```')
    .replace(/<[^>]+>/g, '');
}

const HELP_TEXT = `*BLUE.Y — Slack Commands*

\`status\` — Cluster health overview
\`check\` — Run all monitors now
\`nodes\` — Node CPU/memory
\`load\` — Load monitor summary
\`help\` — This message

For full command set (restart, scale, logs, etc.) use the Telegram bot.`;

export async function startSlackBot(deps: SlackBotDeps): Promise<void> {
  if (!config.slack.enabled || !config.slack.appToken) {
    logger.info('[Slack] Socket Mode not configured — skipping Slack bot (set SLACK_APP_TOKEN + SLACK_BOT_TOKEN)');
    return;
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Dispatch a normalized command text to the right handler
  async function dispatch(text: string, reply: (msg: string) => Promise<void>): Promise<void> {
    const cmd = text.toLowerCase().trim().replace(/^\/bluey\s*/i, '').replace(/^<@[^>]+>\s*/i, '');

    if (cmd === 'status' || cmd === '/status') {
      const summary = await deps.kube.getClusterSummary();
      const schedulerStatus = await deps.scheduler.getStatus();
      await reply(htmlToSlack(`${summary}\n\n${schedulerStatus}`));
      return;
    }

    if (cmd === 'check' || cmd === '/check') {
      await reply('🔍 Running all checks...');
      const results = await deps.scheduler.runAllChecks();
      const summary = results
        .map((r) => `${r.healthy ? '✅' : '❌'} ${r.monitor}: ${r.issues.length} issue(s)`)
        .join('\n');
      await reply(summary || '✅ All checks passed');
      return;
    }

    if (cmd === 'nodes' || cmd === '/nodes') {
      const nodes = await deps.kube.getNodes();
      const lines = nodes.map((n) =>
        `${n.status === 'Ready' ? '🟢' : '🔴'} *${n.name}* — ${n.status} | CPU: ${n.allocatable.cpu} | Mem: ${n.allocatable.memory}`,
      );
      await reply(lines.join('\n') || 'No nodes found.');
      return;
    }

    if (cmd === 'load' || cmd === '/load') {
      const status = await deps.loadMonitor.getStatus();
      await reply(htmlToSlack(status));
      return;
    }

    if (cmd === 'help' || cmd === '/help') {
      await reply(HELP_TEXT);
      return;
    }

    // Unknown command
    await reply(`Unknown command: \`${cmd || '(empty)'}\`\n${HELP_TEXT}`);
  }

  // Handle @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text || '';
    const user = event.user || 'unknown';
    logger.info(`[Slack] @mention from ${user}: ${text}`);
    try {
      await dispatch(text, async (msg) => { await say({ text: msg, mrkdwn: true }); });
    } catch (err) {
      logger.error(`[Slack] Command error: ${err}`);
      await say({ text: `❌ Error: ${(err as Error).message}` });
    }
  });

  // Handle direct messages to the bot
  app.message(async ({ message, say }) => {
    const msg = message as { text?: string; user?: string; channel_type?: string };
    if (msg.channel_type !== 'im') return; // DMs only
    const text = msg.text || '';
    const user = msg.user || 'unknown';
    logger.info(`[Slack] DM from ${user}: ${text}`);
    try {
      await dispatch(text, async (reply) => { await say({ text: reply, mrkdwn: true }); });
    } catch (err) {
      await say({ text: `❌ Error: ${(err as Error).message}` });
    }
  });

  // Handle /bluey slash command (register this in Slack app → Slash Commands)
  app.command('/bluey', async ({ command, ack, respond }) => {
    await ack();
    const user = command.user_id;
    logger.info(`[Slack] /bluey from ${user}: ${command.text}`);
    try {
      await dispatch(command.text, async (msg) => {
        await respond({ text: msg, response_type: 'in_channel', mrkdwn: true });
      });
    } catch (err) {
      await respond({ text: `❌ Error: ${(err as Error).message}`, response_type: 'ephemeral' });
    }
  });

  await app.start();
  logger.info(`[Slack] Socket Mode bot started — listening for @mentions, DMs, and /bluey commands`);
}
