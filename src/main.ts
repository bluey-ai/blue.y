import express from 'express';
import axios from 'axios';
import { logger } from './utils/logger';
import { config } from './config';
import { MonitorScheduler } from './scheduler';
import { BedrockClient } from './clients/bedrock';
import { TelegramClient } from './clients/telegram';
import { KubeClient } from './clients/kube';
import { EmailClient } from './clients/email';
import { JiraClient } from './clients/jira';
import { PodMonitor } from './monitors/pods';
import { NodeMonitor } from './monitors/nodes';
import { CertMonitor } from './monitors/certs';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'blue.y', uptime: process.uptime() });
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
const emailClient = new EmailClient();
const jiraClient = new JiraClient();

// Initialize monitors
const monitors = [
  new PodMonitor(kube, bedrock),
  new NodeMonitor(kube, bedrock),
  new CertMonitor(kube, bedrock),
];

// Initialize scheduler (pass kube for auto-diagnose)
const scheduler = new MonitorScheduler(monitors, telegram, bedrock, kube);

// Pending action confirmation
let pendingAction: { action: string; target: string; namespace: string; detail?: string; timestamp: number } | null = null;

// Last incident context (for email/jira commands)
let lastIncident: {
  monitor?: string;
  pod?: string;
  namespace?: string;
  status?: string;
  analysis?: string;
  logs?: string;
  events?: string;
  description?: string;
  timestamp?: string;
} | null = null;

// Wire up auto-diagnose → lastIncident
scheduler.onIncident = (incident) => { lastIncident = incident; };

// Handle incoming Telegram commands
async function handleTelegramCommand(text: string, chatId: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

  if (chatId !== config.telegram.chatId) {
    logger.warn(`Telegram message from unauthorized chat: ${chatId}`);
    return;
  }

  // --- Core commands ---
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
    const summary = await kube.getClusterSummary();
    const schedulerStatus = await scheduler.getStatus();
    await telegram.send(`${summary}\n\n${schedulerStatus}`);
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

  // --- Pod commands ---
  if (cmd.startsWith('/logs ')) {
    const podName = cmd.replace('/logs ', '').trim();
    const found = await kube.findPod(podName);
    if (found) {
      const logs = await kube.getPodLogs(found.namespace, found.pod.name, 30);
      await telegram.send(`📋 <b>Logs: ${found.pod.name}</b> (${found.namespace})\n\n<pre>${logs.substring(0, 3500)}</pre>`);
    } else {
      await telegram.send(`❓ Pod matching "${podName}" not found`);
    }
    return;
  }

  if (cmd.startsWith('/describe ')) {
    const podName = cmd.replace('/describe ', '').trim();
    const found = await kube.findPod(podName);
    if (found) {
      const desc = await kube.describePod(found.namespace, found.pod.name);
      await telegram.send(`🔎 <b>Describe:</b>\n\n${desc}`);
    } else {
      await telegram.send(`❓ Pod matching "${podName}" not found`);
    }
    return;
  }

  if (cmd.startsWith('/events')) {
    const parts = cmd.replace('/events', '').trim().split(' ');
    const nsOrPod = parts[0] || 'prod';
    // Check if it's a namespace or pod name
    const isNamespace = config.kube.namespaces.includes(nsOrPod);
    if (isNamespace) {
      const events = await kube.getEvents(nsOrPod, parts[1]);
      await telegram.send(`📢 <b>Events: ${nsOrPod}</b>${parts[1] ? ` (${parts[1]})` : ''}\n\n${events}`);
    } else {
      // Treat as pod name, search across namespaces
      const found = await kube.findPod(nsOrPod);
      if (found) {
        const events = await kube.getEvents(found.namespace, found.pod.name);
        await telegram.send(`📢 <b>Events for ${found.pod.name}</b>\n\n${events}`);
      } else {
        await telegram.send(`❓ "${nsOrPod}" not found as namespace or pod`);
      }
    }
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

  // --- Deployments ---
  if (cmd.startsWith('/deployments') || cmd.startsWith('/deps')) {
    const ns = cmd.split(' ')[1] || 'prod';
    const deps = await kube.getDeployments(ns);
    let msg = `📦 <b>Deployments: ${ns}</b>\n\n`;
    deps.forEach((d) => {
      const icon = d.ready === `${d.replicas}/${d.replicas}` ? '✅' : '❌';
      msg += `${icon} <code>${d.name}</code> — ${d.ready} (${d.age})\n`;
    });
    await telegram.send(msg);
    return;
  }

  // --- Diagnose (full diagnostic) ---
  if (cmd.startsWith('/diagnose ')) {
    const podName = cmd.replace('/diagnose ', '').trim();
    const found = await kube.findPod(podName);
    if (!found) {
      await telegram.send(`❓ Pod matching "${podName}" not found`);
      return;
    }

    await telegram.send(`🔬 Diagnosing <code>${found.pod.name}</code>...`);

    // Gather all context
    const [desc, logs, events] = await Promise.all([
      kube.describePod(found.namespace, found.pod.name),
      kube.getPodLogs(found.namespace, found.pod.name, 50),
      kube.getEvents(found.namespace, found.pod.name),
    ]);

    // Send raw data first
    await telegram.send(`🔎 <b>Pod Details:</b>\n${desc}`);
    if (logs && logs.length > 10) {
      await telegram.send(`📋 <b>Recent Logs:</b>\n<pre>${logs.substring(0, 3000)}</pre>`);
    }
    if (events && events !== 'No recent events found.') {
      await telegram.send(`📢 <b>Events:</b>\n${events}`);
    }

    // Save incident context for email/jira
    lastIncident = {
      pod: found.pod.name,
      namespace: found.namespace,
      status: found.pod.status,
      description: desc,
      logs: logs,
      events: events,
      timestamp: new Date().toISOString(),
    };

    // Now ask AI to analyze everything
    try {
      const analysis = await bedrock.analyze({
        type: 'incident',
        message: `Diagnose pod ${found.pod.name} in namespace ${found.namespace}`,
        context: {
          pod: found.pod,
          description: desc,
          recentLogs: logs.substring(0, 2000),
          events: events,
        },
      });
      lastIncident.analysis = analysis.analysis;
      await telegram.send(`🧠 <b>AI Analysis:</b>\n\n${analysis.analysis}`);
      await telegram.send(`💡 Use <code>/email user@blueonion.today</code> or <code>/jira</code> to share this report.`);
      if (analysis.suggestedAction) {
        await telegram.send(`💡 <b>Suggested:</b> ${analysis.suggestedAction}\n\nReply /yes to execute.`);
        pendingAction = {
          action: analysis.suggestedCommand || analysis.suggestedAction || '',
          target: found.pod.name,
          namespace: found.namespace,
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      await telegram.send(`⚠️ AI analysis unavailable: ${(err as Error).message}`);
    }
    return;
  }

  // --- Action commands ---
  if (cmd.startsWith('/restart ')) {
    const name = cmd.replace('/restart ', '').trim();
    const found = await kube.findDeployment(name);
    if (!found) {
      await telegram.send(`❓ Deployment matching "${name}" not found`);
      return;
    }
    pendingAction = { action: 'restart', target: found.deployment, namespace: found.namespace, timestamp: Date.now() };
    await telegram.send(`⚠️ Restart <code>${found.deployment}</code> in <b>${found.namespace}</b>?\n\nReply /yes to confirm or /no to cancel.`);
    return;
  }

  if (cmd.startsWith('/scale ')) {
    const parts = cmd.replace('/scale ', '').trim().split(' ');
    const name = parts[0];
    const replicas = parseInt(parts[1]);
    if (!name || isNaN(replicas) || replicas < 0 || replicas > 10) {
      await telegram.send('Usage: /scale &lt;deployment&gt; &lt;replicas 0-10&gt;');
      return;
    }
    const found = await kube.findDeployment(name);
    if (!found) {
      await telegram.send(`❓ Deployment matching "${name}" not found`);
      return;
    }
    pendingAction = { action: 'scale', target: found.deployment, namespace: found.namespace, detail: String(replicas), timestamp: Date.now() };
    await telegram.send(`⚠️ Scale <code>${found.deployment}</code> in <b>${found.namespace}</b> to ${replicas} replicas?\n\nReply /yes to confirm or /no to cancel.`);
    return;
  }

  // --- Rollout / deployment status ---
  if (cmd.startsWith('/rollout ') || cmd.match(/^(did|has|is)\s+.*(deploy|rollout|build)/i)) {
    const nameMatch = cmd.startsWith('/rollout ') ? cmd.replace('/rollout ', '').trim() : cmd.replace(/^(did|has|is)\s+/i, '').replace(/\s*(deploy|rollout|build|finish|complete|pass|done).*/i, '').trim();
    const found = await kube.findDeployment(nameMatch);
    if (!found) {
      await telegram.send(`❓ Deployment matching "${nameMatch}" not found`);
      return;
    }
    const detail = await kube.getDeploymentDetail(found.namespace, found.deployment);
    if (!detail) {
      await telegram.send(`❌ Could not get rollout status for ${found.deployment}`);
      return;
    }
    const isReady = detail.readyReplicas === detail.replicas && detail.updatedReplicas === detail.replicas;
    const icon = isReady ? '✅' : '🔄';
    const progressing = detail.conditions.find((c) => c.type === 'Progressing');
    let msg = `${icon} <b>Rollout: ${detail.name}</b> (${found.namespace})\n\n`;
    msg += `<b>Replicas:</b> ${detail.readyReplicas}/${detail.replicas} ready, ${detail.updatedReplicas} updated\n`;
    msg += `<b>Image:</b> <code>${detail.image.split('/').pop()}</code>\n`;
    msg += `<b>Status:</b> ${isReady ? 'Complete' : 'In Progress'}\n`;
    if (progressing) msg += `<b>Progress:</b> ${progressing.reason} — ${progressing.message?.substring(0, 200)}\n`;
    await telegram.send(msg);
    return;
  }

  // --- Resource usage ---
  if (cmd === '/resources' || cmd.startsWith('/resources ') || cmd.match(/^(which|what|show).*(memory|cpu|resource|usage)/i)) {
    const ns = cmd.startsWith('/resources ') ? cmd.replace('/resources ', '').trim() : 'prod';
    await telegram.send(`📊 Fetching resource usage for <b>${ns}</b>...`);
    const metrics = await kube.getTopPods(ns);
    if (metrics.length === 0) {
      await telegram.send(`❌ No metrics available for ${ns}. Metrics Server may not be installed.`);
      return;
    }
    const top = metrics.slice(0, 15);
    let msg = `📊 <b>Top Pods by Memory: ${ns}</b>\n\n`;
    top.forEach((p, i) => {
      const memMi = parseInt(p.memory);
      const bar = memMi > 2000 ? '🔴' : memMi > 500 ? '🟡' : '🟢';
      msg += `${bar} <code>${p.name.substring(0, 40)}</code>\n   CPU: ${p.cpu} | Mem: ${p.memory}\n`;
    });
    await telegram.send(msg);
    return;
  }

  // --- Log search ---
  if (cmd.startsWith('/logsearch ')) {
    const parts = cmd.replace('/logsearch ', '').trim().split(' ');
    if (parts.length < 2) {
      await telegram.send('Usage: /logsearch &lt;pod&gt; &lt;pattern&gt;');
      return;
    }
    const podName = parts[0];
    const pattern = parts.slice(1).join(' ');
    const found = await kube.findPod(podName);
    if (!found) {
      await telegram.send(`❓ Pod matching "${podName}" not found`);
      return;
    }
    await telegram.send(`🔍 Searching logs of <code>${found.pod.name}</code> for "${pattern}"...`);
    const logs = await kube.getPodLogs(found.namespace, found.pod.name, 500);
    const matches = logs.split('\n').filter((line) => line.toLowerCase().includes(pattern.toLowerCase()));
    if (matches.length === 0) {
      await telegram.send(`No matches for "${pattern}" in last 500 lines.`);
    } else {
      const result = matches.slice(-20).join('\n');
      await telegram.send(`🔍 Found ${matches.length} matches (showing last 20):\n\n<pre>${result.substring(0, 3500)}</pre>`);
    }
    return;
  }

  // --- Doris health ---
  if (cmd === '/doris' || cmd.match(/^(doris|how.*doris)/i)) {
    await telegram.send('🔍 Checking Doris health...');
    const dorisPods = await kube.getPods('doris');
    const fePods = dorisPods.filter((p) => p.name.includes('fe'));
    const bePods = dorisPods.filter((p) => p.name.includes('be'));

    let msg = '🗄️ <b>Doris Health</b>\n\n';

    msg += '<b>Frontend (FE):</b>\n';
    fePods.forEach((p) => {
      const icon = p.status === 'Running' && p.ready ? '✅' : '❌';
      msg += `${icon} <code>${p.name}</code> — ${p.status}, restarts: ${p.restarts}, age: ${p.age}\n`;
    });

    msg += '\n<b>Backend (BE):</b>\n';
    bePods.forEach((p) => {
      const icon = p.status === 'Running' && p.ready ? '✅' : '❌';
      msg += `${icon} <code>${p.name}</code> — ${p.status}, restarts: ${p.restarts}, age: ${p.age}\n`;
    });

    // Check resource usage
    const dorisMetrics = await kube.getTopPods('doris');
    if (dorisMetrics.length > 0) {
      msg += '\n<b>Resource Usage:</b>\n';
      dorisMetrics.forEach((m) => {
        const memMi = parseInt(m.memory);
        const bar = memMi > 60000 ? '🔴' : memMi > 40000 ? '🟡' : '🟢';
        msg += `${bar} <code>${m.name.substring(0, 35)}</code> — CPU: ${m.cpu}, Mem: ${m.memory}\n`;
      });
    }

    const unhealthyDoris = dorisPods.filter((p) => p.status !== 'Running' || !p.ready || p.restarts > 3);
    if (unhealthyDoris.length > 0) {
      msg += '\n⚠️ <b>Issues detected!</b> Use <code>/diagnose doris-prod-be</code> to investigate.';
    } else {
      msg += '\n✅ All Doris pods healthy.';
    }

    await telegram.send(msg);
    return;
  }

  // --- Incident timeline ---
  if (cmd === '/incidents' || cmd.match(/^show\s+(me\s+)?incidents/i)) {
    const incidents = scheduler.getIncidentLog();
    if (incidents.length === 0) {
      await telegram.send('✅ No incidents recorded since last restart.');
      return;
    }
    let msg = `📋 <b>Incident Timeline</b> (${incidents.length} total)\n\n`;
    incidents.slice(-10).forEach((inc) => {
      const ts = inc.timestamp ? new Date(inc.timestamp).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }) : '?';
      msg += `• <b>${ts}</b>\n  ${inc.namespace}/${inc.pod} — ${inc.status}\n  ${inc.analysis?.substring(0, 100) || 'No analysis'}${inc.analysis && inc.analysis.length > 100 ? '...' : ''}\n\n`;
    });
    await telegram.send(msg);
    return;
  }

  // --- Email incident report ---
  // Match: any message containing "email" + an email address
  const hasEmailAddress = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (cmd.startsWith('/email ') || (hasEmailAddress && cmd.match(/\b(email|send|forward|share)\b/i))) {
    // Extract email address(es) from command
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
    if (!emailMatch || emailMatch.length === 0) {
      await telegram.send('Usage: /email user@blueonion.today [user2@blueonion.today ...]');
      return;
    }
    if (!lastIncident) {
      // No prior /diagnose — create a minimal incident from the message context
      lastIncident = {
        monitor: 'Manual Report',
        status: 'Alert',
        description: text,
        timestamp: new Date().toISOString(),
      };
    }

    await telegram.send(`📧 Sending incident report to ${emailMatch.join(', ')}...`);
    const { subject, body } = emailClient.formatIncidentEmail(lastIncident);
    const ok = await emailClient.sendIncidentReport(emailMatch, subject, body);
    await telegram.send(ok
      ? `✅ Incident report sent to ${emailMatch.join(', ')}`
      : `❌ Failed to send email. Check SES permissions.`);
    return;
  }

  // --- Create Jira ticket ---
  if (cmd === '/jira' || text.match(/(create|make|open|raise)\s+(a\s+)?jira\s+(ticket|issue)/i) || text.match(/jira\s+(ticket|issue)/i)) {
    if (!lastIncident) {
      await telegram.send('❌ No recent incident to create ticket for. Run /diagnose first.');
      return;
    }
    if (!config.jira.apiToken) {
      await telegram.send('❌ Jira not configured. Set JIRA_EMAIL and JIRA_API_TOKEN env vars.');
      return;
    }

    await telegram.send('🎫 Creating Jira ticket...');
    const summary = `[BLUE.Y] ${lastIncident.pod || 'Cluster'} — ${lastIncident.status || 'Incident'}`;
    const ticket = await jiraClient.createIncidentTicket({
      summary,
      ...lastIncident,
    });

    if (ticket) {
      await telegram.send(`✅ Jira ticket created: <a href="${ticket.url}">${ticket.key}</a>`);
    } else {
      await telegram.send('❌ Failed to create Jira ticket. Check credentials.');
    }
    return;
  }

  // --- Confirmation flow ---
  if (cmd === '/yes' || cmd === 'yes' || cmd === 'y') {
    if (!pendingAction || Date.now() - pendingAction.timestamp > 120000) {
      await telegram.send('❌ No pending action or it expired (2 min timeout).');
      pendingAction = null;
      return;
    }

    const { action, target, namespace, detail } = pendingAction;
    pendingAction = null;

    if (action === 'restart') {
      await telegram.send(`🔄 Restarting <code>${target}</code>...`);
      const ok = await kube.restartDeployment(namespace, target);
      await telegram.send(ok
        ? `✅ Restarted <code>${target}</code> in <b>${namespace}</b>. Rolling update in progress.`
        : `❌ Failed to restart <code>${target}</code>.`);
    } else if (action === 'scale') {
      const replicas = parseInt(detail || '1');
      await telegram.send(`📐 Scaling <code>${target}</code> to ${replicas}...`);
      const ok = await kube.scaleDeployment(namespace, target, replicas);
      await telegram.send(ok
        ? `✅ Scaled <code>${target}</code> to ${replicas} replicas.`
        : `❌ Failed to scale <code>${target}</code>.`);
    } else {
      await telegram.send(`⚠️ Unknown action: ${action}`);
    }
    return;
  }

  if (cmd === '/no' || cmd === 'no' || cmd === 'n') {
    if (pendingAction) {
      pendingAction = null;
      await telegram.send('👌 Action cancelled.');
    }
    return;
  }

  // --- Help ---
  if (cmd === '/help' || cmd === 'help') {
    await telegram.send(
      `👁️ <b>BLUE.Y Commands</b>\n\n` +
      `<b>Monitoring:</b>\n` +
      `/status — Cluster health overview\n` +
      `/check — Run all monitors now\n` +
      `/nodes — Node resources\n` +
      `/resources [ns] — Pod CPU/memory usage\n` +
      `/doris — Doris cluster health\n\n` +
      `<b>Pods & Deployments:</b>\n` +
      `/logs &lt;pod&gt; — Tail pod logs\n` +
      `/logsearch &lt;pod&gt; &lt;pattern&gt; — Search logs\n` +
      `/describe &lt;pod&gt; — Pod details\n` +
      `/events [ns] [pod] — Recent events\n` +
      `/deployments [ns] — List deployments\n` +
      `/rollout &lt;deployment&gt; — Rollout status\n` +
      `/diagnose &lt;pod&gt; — Full AI diagnostic\n\n` +
      `<b>Actions:</b>\n` +
      `/restart &lt;deployment&gt; — Rolling restart\n` +
      `/scale &lt;deployment&gt; &lt;N&gt; — Scale replicas\n\n` +
      `<b>Reports:</b>\n` +
      `/email &lt;address&gt; — Email incident report\n` +
      `/jira — Create Jira ticket\n` +
      `/incidents — Incident timeline\n\n` +
      `<b>System:</b>\n` +
      `/sleep — Pause monitoring\n` +
      `/wake — Resume monitoring\n\n` +
      `💡 Auto-diagnose is ON — I'll automatically investigate unhealthy pods.\n` +
      `Or just ask me anything in plain English!`,
    );
    return;
  }

  // --- Natural language → Bedrock with cluster context ---
  try {
    await telegram.send('🧠 Thinking...');

    // Gather live cluster context for Bedrock
    const clusterSummary = await kube.getClusterSummary();
    const unhealthy = await kube.getUnhealthyPods();

    const response = await bedrock.analyze({
      type: 'user_command',
      message: text,
      context: {
        clusterSummary,
        unhealthyPods: unhealthy.map((p) => ({ name: p.name, namespace: p.namespace, status: p.status, restarts: p.restarts, containers: p.containers })),
        timestamp: new Date().toISOString(),
      },
    });

    await telegram.send(response.analysis);

    if (response.requiresAction && response.suggestedCommand) {
      // Parse the suggested action
      const actionParts = (response.suggestedCommand || '').split(' ');
      if (actionParts[0] === 'restart' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'restart', target: dep, namespace: ns, timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> Restart <code>${dep}</code> in ${ns}\n\nReply /yes to execute or /no to cancel.`);
      } else if (actionParts[0] === 'scale' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        const replicas = actionParts[2] || '1';
        pendingAction = { action: 'scale', target: dep, namespace: ns, detail: replicas, timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> Scale <code>${dep}</code> to ${replicas}\n\nReply /yes to execute or /no to cancel.`);
      }
    }
  } catch (err) {
    logger.error('Bedrock analysis failed', err);
    await telegram.send(
      `⚠️ AI unavailable right now. Here are the commands:\n\n` +
      `/status /check /nodes /logs /describe /events /diagnose /restart /scale /help`,
    );
  }
}

// Telegram long polling (no webhook URL needed)
async function startPolling(): Promise<void> {
  let lastUpdateId = 0;
  const API = `https://api.telegram.org/bot${config.telegram.botToken}`;

  // Clear any stale webhook first
  try {
    await axios.post(`${API}/deleteWebhook`);
    logger.info('Cleared any stale Telegram webhook');
  } catch { /* ignore */ }

  // Register bot commands menu (clickable list in Telegram)
  try {
    await axios.post(`${API}/setMyCommands`, {
      commands: [
        { command: 'status', description: 'Cluster health overview' },
        { command: 'check', description: 'Run all monitors now' },
        { command: 'nodes', description: 'Node resources' },
        { command: 'resources', description: 'Pod CPU/memory usage' },
        { command: 'doris', description: 'Doris cluster health' },
        { command: 'deployments', description: 'List deployments' },
        { command: 'incidents', description: 'Incident timeline' },
        { command: 'help', description: 'Show all commands' },
        { command: 'sleep', description: 'Pause monitoring' },
        { command: 'wake', description: 'Resume monitoring' },
      ],
    });
    logger.info('Telegram bot commands menu registered');
  } catch { /* ignore */ }

  // Small delay to let any previous poller's connection expire
  await new Promise((r) => setTimeout(r, 3000));

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
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        // 409 = another poller active — wait longer before retrying
        logger.warn('Telegram 409 conflict — another poller active, waiting 10s...');
        await new Promise((r) => setTimeout(r, 10000));
      } else if ((err as { code?: string }).code !== 'ECONNABORTED') {
        logger.error('Poll error', err);
        await new Promise((r) => setTimeout(r, 2000));
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
