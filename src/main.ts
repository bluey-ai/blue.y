import express from 'express';
import axios from 'axios';
import { logger } from './utils/logger';
import { config } from './config';
import { MonitorScheduler } from './scheduler';
import { BedrockClient } from './clients/bedrock';
import { TelegramClient } from './clients/telegram';
import { KubeClient } from './clients/kube';
import { PodMonitor } from './monitors/pods';
import { NodeMonitor } from './monitors/nodes';
import { CertMonitor } from './monitors/certs';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'blue.y', uptime: process.uptime() });
});

// Telegram webhook (incoming commands)
app.post('/webhook/telegram', async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message?.text) return res.sendStatus(200);

    const chatId = String(message.chat.id);
    const text = message.text.toLowerCase().trim();

    // Only respond to messages from the configured chat
    if (chatId !== config.telegram.chatId) {
      logger.warn(`Telegram message from unauthorized chat: ${chatId}`);
      return res.sendStatus(200);
    }

    // "sleep" = kill switch
    if (text === '/sleep' || text === 'sleep') {
      logger.info('Kill switch activated via Telegram');
      scheduler.pause();
      await telegram.send('😴 BLUE.Y is now sleeping. Send /wake to resume.');
      return res.sendStatus(200);
    }

    if (text === '/wake' || text === 'wake') {
      logger.info('Wake command received via Telegram');
      scheduler.resume();
      await telegram.send('👁️ BLUE.Y is awake and monitoring.');
      return res.sendStatus(200);
    }

    if (text === '/status' || text === 'status') {
      const status = await scheduler.getStatus();
      await telegram.send(status);
      return res.sendStatus(200);
    }

    if (text === '/check' || text === 'check') {
      await telegram.send('🔍 Running all checks...');
      const results = await scheduler.runAllChecks();
      const summary = results
        .map((r) => `${r.healthy ? '✅' : '❌'} ${r.monitor}: ${r.issues.length} issues`)
        .join('\n');
      await telegram.send(summary || '✅ All checks passed');
      return res.sendStatus(200);
    }

    // For any other message, pass to Bedrock for analysis
    const response = await bedrock.analyze({
      type: 'user_command',
      message: message.text,
    });

    if (response.requiresAction) {
      await telegram.send(`🔍 <b>Analysis:</b>\n${response.analysis}\n\n⚠️ <b>Suggested action:</b>\n<code>${response.suggestedCommand || response.suggestedAction}</code>\n\nReply /yes to execute.`);
    } else {
      await telegram.send(response.analysis);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('Telegram webhook error', err);
    res.sendStatus(500);
  }
});

// Manual trigger endpoint (for testing)
app.post('/check', async (_req, res) => {
  try {
    const results = await scheduler.runAllChecks();
    res.json(results);
  } catch (err) {
    logger.error('Manual check error', err);
    res.status(500).json({ error: 'Check failed' });
  }
});

// Audit log endpoint
app.get('/audit', (_req, res) => {
  res.json(scheduler.getAuditLog());
});

// Initialize clients
const bedrock = new BedrockClient();
const telegram = new TelegramClient();
const kube = new KubeClient();

// Initialize monitors
const monitors = [
  new PodMonitor(kube, bedrock),
  new NodeMonitor(kube, bedrock),
  new CertMonitor(kube, bedrock),
];

// Initialize scheduler
const scheduler = new MonitorScheduler(monitors, telegram, bedrock);

// Handle incoming Telegram commands
async function handleTelegramCommand(text: string, chatId: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

  if (chatId !== config.telegram.chatId) {
    logger.warn(`Telegram message from unauthorized chat: ${chatId}`);
    return;
  }

  if (cmd === '/sleep' || cmd === 'sleep') {
    scheduler.pause();
    await telegram.send('😴 BLUE.Y is now sleeping. Send /wake to resume.');
    return;
  }

  if (cmd === '/wake' || cmd === 'wake') {
    scheduler.resume();
    await telegram.send('👁️ BLUE.Y is awake and monitoring.');
    return;
  }

  if (cmd === '/status' || cmd === 'status') {
    const status = await scheduler.getStatus();
    await telegram.send(status);
    return;
  }

  if (cmd === '/check' || cmd === 'check') {
    await telegram.send('🔍 Running all checks...');
    const results = await scheduler.runAllChecks();
    const summary = results
      .map((r) => `${r.healthy ? '✅' : '❌'} ${r.monitor}: ${r.issues.length} issues`)
      .join('\n');
    await telegram.send(summary || '✅ All checks passed');
    return;
  }

  if (cmd.startsWith('/logs ')) {
    const podName = cmd.replace('/logs ', '').trim();
    for (const ns of config.kube.namespaces) {
      const pods = await kube.getPods(ns);
      const match = pods.find((p: { name: string }) => p.name.includes(podName));
      if (match) {
        const logs = await kube.getPodLogs(ns, match.name, 20);
        await telegram.send(`📋 <b>Logs: ${match.name}</b>\n\n<pre>${logs.substring(0, 3500)}</pre>`);
        return;
      }
    }
    await telegram.send(`❓ Pod matching "${podName}" not found`);
    return;
  }

  if (cmd.startsWith('/nodes') || cmd === 'nodes') {
    const nodes = await kube.getNodes();
    let msg = '🖥️ <b>Nodes</b>\n\n';
    nodes.forEach((n: { name: string; status: string; allocatable: { cpu: string; memory: string } }) => {
      const icon = n.status === 'Ready' ? '✅' : '❌';
      const mem = Math.round(parseInt(n.allocatable.memory) / 1024 / 1024);
      msg += `${icon} <code>${n.name.split('.')[0]}</code>\n   ${n.allocatable.cpu} CPU, ${mem}Gi RAM\n`;
    });
    await telegram.send(msg);
    return;
  }

  // For unknown commands, pass to Bedrock for analysis
  try {
    const response = await bedrock.analyze({
      type: 'user_command',
      message: text,
    });

    if (response.requiresAction) {
      await telegram.send(`🔍 <b>Analysis:</b>\n${response.analysis}\n\n⚠️ <b>Suggested action:</b>\n<code>${response.suggestedCommand || response.suggestedAction}</code>\n\nReply /yes to execute.`);
    } else {
      await telegram.send(response.analysis);
    }
  } catch (err) {
    await telegram.send(`👁️ <b>BLUE.Y Commands</b>\n\n/status — Quick health overview\n/check — Full pod scan\n/nodes — Node resources\n/logs &lt;pod-name&gt; — Tail pod logs\n/sleep — Pause monitoring\n/wake — Resume monitoring`);
  }
}

// Telegram long polling (no webhook URL needed)
async function startPolling(): Promise<void> {
  let lastUpdateId = 0;
  const API = `https://api.telegram.org/bot${config.telegram.botToken}`;

  logger.info('Telegram polling started — listening for commands...');

  while (true) {
    try {
      const res = await axios.get(`${API}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30 },
        timeout: 35000,
      });

      for (const update of res.data.result || []) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);
        logger.info(`[Telegram] ${msg.from?.first_name}: ${msg.text}`);

        try {
          await handleTelegramCommand(msg.text, chatId);
        } catch (err) {
          logger.error('Error handling Telegram command', err);
          await telegram.send(`❌ Error: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code !== 'ECONNABORTED') {
        logger.error('Poll error', err);
      }
    }
  }
}

// Start
app.listen(config.port, () => {
  logger.info(`BLUE.Y started on port ${config.port}`);
  scheduler.start();

  // Start Telegram polling if bot token is configured
  if (config.telegram.botToken) {
    startPolling().catch((err) => logger.error('Polling fatal error', err));
  }
});
