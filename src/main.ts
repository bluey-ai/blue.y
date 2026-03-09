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
import { HPAMonitor } from './monitors/hpa';
import { TeamsClient, TeamsTicket, TeamsCards } from './clients/teams';
import { VisionClient } from './clients/vision';
import { QAClient } from './clients/qa';
import { LokiClient } from './clients/loki';
import { CronJob } from 'cron';

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
const teamsClient = new TeamsClient();
const visionClient = new VisionClient();
const qaClient = new QAClient();
const lokiClient = new LokiClient();

// Initialize monitors
const monitors = [
  new PodMonitor(kube, bedrock),
  new NodeMonitor(kube, bedrock),
  new CertMonitor(kube, bedrock),
  new HPAMonitor(kube),
];

// Initialize scheduler (pass kube + loki for auto-diagnose)
const scheduler = new MonitorScheduler(monitors, telegram, bedrock, kube, lokiClient);

// Pending action confirmation (teamsTicketId links back to Teams user for cross-channel flow)
let pendingAction: { action: string; target: string; namespace: string; detail?: string; timestamp: number; teamsTicketId?: string; jiraKey?: string } | null = null;

// Estimated resolution times by action + target pattern
function getETA(action: string, target: string): { seconds: number; label: string } {
  if (action === 'restart') {
    if (target.includes('backend') || target.includes('blo-backend')) return { seconds: 300, label: '3-5 minutes (4 JVMs boot sequentially)' };
    if (target.includes('doris')) return { seconds: 180, label: '2-3 minutes' };
    if (target.includes('blue-ai')) return { seconds: 90, label: '1-2 minutes (ChromaDB reload)' };
    return { seconds: 60, label: '30-60 seconds' };
  }
  if (action === 'scale') return { seconds: 120, label: '1-2 minutes (pod scheduling + startup)' };
  return { seconds: 120, label: '1-2 minutes' };
}

// Post-action health monitor — runs in background after action execution
async function monitorActionOutcome(opts: {
  action: string;
  target: string;
  namespace: string;
  teamsTicketId?: string;
  jiraKey?: string;
  eta: { seconds: number; label: string };
}): Promise<void> {
  const { action, target, namespace, teamsTicketId, jiraKey, eta } = opts;
  const maxChecks = 6;
  const checkInterval = Math.max(Math.ceil(eta.seconds / maxChecks), 15) * 1000; // Check ~6 times within ETA, min 15s
  const startTime = Date.now();
  const timeout = (eta.seconds + 120) * 1000; // ETA + 2 min grace

  logger.info(`[Monitor] Tracking ${action} on ${namespace}/${target}, ETA: ${eta.label}, checking every ${checkInterval / 1000}s`);

  // Wait initial period before first check (give action time to take effect)
  await new Promise((r) => setTimeout(r, Math.min(checkInterval, 30000)));

  for (let i = 0; i < maxChecks + 4; i++) { // Extra checks past ETA
    try {
      const detail = await kube.getDeploymentDetail(namespace, target);
      if (detail && detail.readyReplicas >= detail.replicas && detail.updatedReplicas >= detail.replicas) {
        // Healthy!
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const msg =
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `✅ <b>VERIFIED HEALTHY</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 <code>${target}</code>\n` +
          `🔄 Action: ${action}\n` +
          `📊 Replicas: ${detail.readyReplicas}/${detail.replicas} ready\n` +
          `⏱️ Resolved in: <b>${elapsed}s</b>`;
        await telegram.send(msg);

        if (teamsTicketId) {
          const card = TeamsCards.resolved(target,
            `The fix has been verified — **${target}** is back to normal with all ${detail.replicas} replica(s) running.`,
            elapsed);
          await teamsClient.replyWithCard(teamsTicketId, card);
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Post-action verification: ${namespace}/${target} is HEALTHY after ${action}. ${detail.readyReplicas}/${detail.replicas} replicas ready. Resolved in ${elapsed}s.`);
        }
        return;
      }

      // Not ready yet — check if we've exceeded timeout
      if (Date.now() - startTime > timeout) {
        const readyInfo = detail ? `${detail.readyReplicas}/${detail.replicas} ready` : 'status unknown';
        const msg =
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ <b>RECOVERY TIMEOUT</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 <code>${target}</code>\n` +
          `🔄 Action: ${action}\n` +
          `📊 Status: ${readyInfo}\n\n` +
          `🔍 Manual investigation may be needed`;
        await telegram.send(msg);

        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            `The fix is taking longer than expected. The ops team is monitoring and will follow up. Current status: ${readyInfo}.`);
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Post-action timeout: ${namespace}/${target} not fully recovered after ${action}. ${readyInfo}. Manual investigation may be needed.`);
        }
        return;
      }
    } catch (err) {
      logger.warn(`[Monitor] Health check failed for ${target}: ${err}`);
    }

    await new Promise((r) => setTimeout(r, checkInterval));
  }
}

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
  lokiErrorLogs?: string;
  lokiStats?: string;
  lokiPatterns?: string;
  lokiTrend?: string;
} | null = null;

// Wire up auto-diagnose → lastIncident
scheduler.onIncident = (incident) => { lastIncident = incident; };

// Track last bot response for "email this" context
let lastBotResponse: string | null = null;

// Team email directory — type a name instead of full address
const TEAM_EMAILS: Record<string, string> = {
  zeeshan: 'syed.zeeshan@blueonion.today',
  abdul: 'abdul.khaliq@blueonion.today',
  usama: 'usama.javed@blueonion.today',
  wei: 'weslesy.feng@blueonion.today',
  elsa: 'epau@blueonion.today',
};
const TEAM_ALL = Object.values(TEAM_EMAILS);

// Handle incoming Telegram commands
async function handleTelegramCommand(text: string, chatId: string): Promise<void> {
  // Strip @BotName suffix from commands (Telegram appends it in groups)
  const cmd = text.toLowerCase().trim().replace(/@\w+/g, '');

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
    lastBotResponse = `${summary}\n\n${schedulerStatus}`;
    await telegram.send(lastBotResponse);
    return;
  }

  if (cmd === '/check' || cmd === 'check') {
    await telegram.send('🔍 Running all checks...');
    const results = await scheduler.runAllChecks();
    const summary = results
      .map((r) => `${r.healthy ? '✅' : '❌'} ${r.monitor}: ${r.issues.length} issues`)
      .join('\n');
    lastBotResponse = summary || '✅ All checks passed';
    await telegram.send(lastBotResponse);
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

    // Gather all context (K8s + Loki in parallel)
    const [desc, logs, events, lokiErrors, lokiStats, lokiTrend] = await Promise.all([
      kube.describePod(found.namespace, found.pod.name),
      kube.getPodLogs(found.namespace, found.pod.name, 50),
      kube.getEvents(found.namespace, found.pod.name),
      lokiClient.getErrorLogs(found.namespace, found.pod.name, '1h', 30).catch(() => [] as string[]),
      lokiClient.getLogStats(found.namespace, found.pod.name, '1h').catch(() => null),
      lokiClient.getErrorTrend(found.namespace, found.pod.name).catch(() => 'unknown' as const),
    ]);

    // Get Loki error patterns
    const lokiPatterns = await lokiClient.getErrorPatterns(found.namespace, '1h', 100).catch(() => []);

    // Send raw data first
    await telegram.send(`🔎 <b>Pod Details:</b>\n${desc}`);
    if (logs && logs.length > 10) {
      await telegram.send(`📋 <b>Recent Logs:</b>\n<pre>${logs.substring(0, 3000)}</pre>`);
    }
    if (events && events !== 'No recent events found.') {
      await telegram.send(`📢 <b>Events:</b>\n${events}`);
    }

    // Send Loki log analysis
    if (lokiStats) {
      const statsText = lokiClient.formatStats(lokiStats, lokiTrend);
      await telegram.send(`📊 <b>Log Analysis (Loki):</b>\n<pre>${statsText}</pre>`);
    }
    if (lokiErrors.length > 0) {
      await telegram.send(`🔴 <b>Error Logs (${lokiErrors.length} found):</b>\n<pre>${lokiErrors.slice(0, 10).join('\n').substring(0, 3000)}</pre>`);
    }
    if (lokiPatterns.length > 0) {
      const patternsText = lokiClient.formatPatterns(lokiPatterns);
      await telegram.send(`🔍 <b>Error Patterns:</b>\n<pre>${patternsText.substring(0, 3000)}</pre>`);
    }

    // Build Loki context strings for incident/AI
    const lokiStatsStr = lokiStats ? lokiClient.formatStats(lokiStats, lokiTrend) : '';
    const lokiPatternsStr = lokiPatterns.length > 0 ? lokiClient.formatPatterns(lokiPatterns) : '';
    const lokiErrorsStr = lokiErrors.slice(0, 15).join('\n');

    // Save incident context for email/jira
    lastIncident = {
      pod: found.pod.name,
      namespace: found.namespace,
      status: found.pod.status,
      description: desc,
      logs: logs,
      events: events,
      timestamp: new Date().toISOString(),
      lokiErrorLogs: lokiErrorsStr,
      lokiStats: lokiStatsStr,
      lokiPatterns: lokiPatternsStr,
      lokiTrend: lokiTrend,
    };

    // Now ask AI to analyze everything (including Loki data)
    try {
      const lokiContext = lokiStatsStr
        ? `\n\n=== LOKI LOG ANALYSIS ===\n${lokiStatsStr}\n\nError Trend: ${lokiTrend}\n\nTop Error Patterns:\n${lokiPatternsStr}\n\nRecent Error Logs:\n${lokiErrorsStr.substring(0, 1500)}`
        : '';

      const analysis = await bedrock.analyze({
        type: 'incident',
        message: `Diagnose pod ${found.pod.name} in namespace ${found.namespace}`,
        context: {
          pod: found.pod,
          description: desc,
          recentLogs: logs.substring(0, 2000),
          events: events,
          lokiAnalysis: lokiContext || undefined,
        },
      });
      lastIncident.analysis = analysis.analysis;
      lastBotResponse = analysis.analysis;
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
    top.forEach((p) => {
      const memMi = parseInt(p.memory);
      const bar = memMi > 2000 ? '🔴' : memMi > 500 ? '🟡' : '🟢';
      msg += `${bar} <code>${p.name.substring(0, 40)}</code>\n   CPU: ${p.cpu} | Mem: ${p.memory}\n`;
    });

    // Include HPA summary
    const hpas = await kube.getHPAs(ns);
    if (hpas.length > 0) {
      msg += '\n<b>HPA Autoscalers:</b>\n';
      for (const hpa of hpas) {
        const atMax = hpa.currentReplicas >= hpa.maxReplicas;
        const icon = atMax ? '🔴' : '🟢';
        const metricStr = hpa.metrics.map((m) => `${m.name}: ${m.current}%/${m.target}%`).join(', ');
        msg += `${icon} <code>${hpa.name}</code> — ${hpa.currentReplicas}/${hpa.maxReplicas} replicas${metricStr ? ` | ${metricStr}` : ''}\n`;
      }
    }

    await telegram.send(msg);
    return;
  }

  // --- HPA status ---
  if (cmd === '/hpa' || cmd.startsWith('/hpa ') || cmd.match(/^(show|check|what).*(hpa|autoscal)/i)) {
    const ns = cmd.startsWith('/hpa ') ? cmd.replace('/hpa ', '').trim() : '';
    const namespaces = ns ? [ns] : config.kube.namespaces;
    await telegram.send('📊 Fetching HPA status...');

    let msg = '📊 <b>HPA (Horizontal Pod Autoscaler)</b>\n\n';
    let totalHPAs = 0;

    for (const namespace of namespaces) {
      const hpas = await kube.getHPAs(namespace);
      if (hpas.length === 0) continue;
      totalHPAs += hpas.length;

      msg += `<b>${namespace}:</b>\n`;
      for (const hpa of hpas) {
        const atMax = hpa.currentReplicas >= hpa.maxReplicas;
        const icon = atMax ? '🔴' : '🟢';
        msg += `${icon} <code>${hpa.name}</code>\n`;
        msg += `   Target: ${hpa.targetRef} | Replicas: ${hpa.currentReplicas} (${hpa.minReplicas}-${hpa.maxReplicas})\n`;

        for (const m of hpa.metrics) {
          const bar = m.current >= 85 ? '🔴' : m.current >= 70 ? '🟡' : '🟢';
          msg += `   ${bar} ${m.name}: ${m.current}% / ${m.target}% target\n`;
        }

        if (atMax) {
          msg += `   ⚠️ At max replicas!\n`;
        }
        msg += '\n';
      }
    }

    if (totalHPAs === 0) {
      msg += 'No HPAs found in monitored namespaces.';
    }

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

  // --- QA Smoke Test ---
  if (cmd === '/smoketest' || cmd === '/smoke' || cmd.match(/^(run\s+)?smoke\s*test/i)) {
    await telegram.send('🧪 Running smoke tests on all production URLs...');
    const results = await qaClient.smokeTest();
    await telegram.send(qaClient.formatSmokeTestTelegram(results));

    // If any service is down, trigger AI analysis
    const failing = results.filter((r) => !r.healthy);
    if (failing.length > 0) {
      const failList = failing.map((f) => `${f.name} (${f.url}): ${f.error || `HTTP ${f.status}`}`).join('\n');
      const analysis = await bedrock.analyze({
        type: 'incident',
        message: `Smoke test detected ${failing.length} failing service(s):\n${failList}`,
        context: { smokeTestResults: results },
      });
      await telegram.send(`🧠 <b>AI Analysis:</b>\n${analysis.analysis}`);
      if (analysis.suggestedCommand) {
        await telegram.send(`💡 <b>Suggested:</b> <code>${analysis.suggestedCommand}</code>\n\nReply /yes to execute.`);
        const parts = (analysis.suggestedCommand || '').split(' ');
        pendingAction = { action: parts[0], target: parts[1]?.split('/')[1] || parts[1] || '', namespace: parts[1]?.split('/')[0] || 'prod', timestamp: Date.now() };
      }
    }
    return;
  }

  // --- Security Scan ---
  if (cmd === '/securityscan' || cmd === '/security' || cmd.match(/^(run\s+)?(security|owasp)\s*scan/i)) {
    const targetUrl = cmd.replace(/^\/(securityscan|security)\s*/, '').trim();
    await telegram.send(`🔐 Running security scan${targetUrl ? ` on ${targetUrl}` : ' on all production URLs'}...`);
    const results = await qaClient.securityScan(targetUrl || undefined);
    await telegram.send(qaClient.formatSecurityScanTelegram(results));
    return;
  }

  // --- Daily report (manual trigger) ---
  if (cmd === '/report' || cmd.match(/^(daily\s+)?(health\s+)?report/i)) {
    await generateDailyReport();
    return;
  }

  // --- Pod restart root cause ---
  if (cmd === '/restarts' || cmd.match(/^(show\s+)?(pod\s+)?restarts/i) || cmd.match(/^why\s+(did|was)\s+.*(restart|crash)/i)) {
    await telegram.send('🔍 Analyzing recent pod restarts...');
    const restarts = await kube.getRecentlyRestartedPods();

    if (restarts.length === 0) {
      await telegram.send('✅ No pod restarts in the last 24 hours.');
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n🔄 <b>POD RESTARTS</b> (last 24h)\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const r of restarts.slice(0, 10)) {
      const icon = r.oomKilled ? '💥' : r.lastExitCode !== 0 ? '❌' : '🔄';
      const reason = r.oomKilled ? 'OOM Killed (out of memory)' :
        r.lastRestartReason === 'Error' ? `Error (exit code: ${r.lastExitCode})` :
        r.lastRestartReason;
      const time = r.lastRestartTime !== 'unknown'
        ? new Date(r.lastRestartTime).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' })
        : '?';

      msg += `${icon} <code>${r.name.substring(0, 40)}</code>\n`;
      msg += `   ${r.namespace} | ${r.restarts} restarts | Last: ${time}\n`;
      msg += `   Reason: <b>${reason}</b>\n\n`;
    }

    // AI analysis of restart patterns
    if (restarts.length > 0) {
      const analysis = await bedrock.analyze({
        type: 'pod_issue',
        message: `Analyze these pod restarts from the last 24 hours and identify patterns or root causes:\n${JSON.stringify(restarts.slice(0, 10))}`,
        context: { totalRestarts: restarts.length },
      });
      msg += `🧠 <b>Analysis:</b>\n${analysis.analysis}`;
    }

    await telegram.send(msg);
    return;
  }

  // --- Resource efficiency ---
  if (cmd === '/resources' || cmd === '/efficiency' || cmd.match(/^(show\s+)?(resource|cpu|memory)\s*(usage|efficiency)/i)) {
    const ns = cmd.match(/\s(prod|doris|monitoring|wordpress)\s*$/)?.[1] || 'prod';
    await telegram.send(`📊 Analyzing resource efficiency in <b>${ns}</b>...`);
    const efficiency = await kube.getResourceEfficiency(ns);

    if (efficiency.length === 0) {
      await telegram.send('No resource data available (metrics-server may not be running).');
      return;
    }

    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n📊 <b>RESOURCE EFFICIENCY</b> (${ns})\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Sort by memory efficiency (descending — show over-provisioned first)
    efficiency.sort((a, b) => a.memEfficiency - b.memEfficiency);

    for (const r of efficiency.slice(0, 15)) {
      const cpuIcon = r.cpuEfficiency > 80 ? '🔴' : r.cpuEfficiency > 50 ? '🟡' : r.cpuEfficiency < 10 ? '💤' : '🟢';
      const memIcon = r.memEfficiency > 80 ? '🔴' : r.memEfficiency > 50 ? '🟡' : r.memEfficiency < 10 ? '💤' : '🟢';
      const shortName = r.name.length > 35 ? r.name.substring(0, 35) + '…' : r.name;

      msg += `<code>${shortName}</code>\n`;
      msg += `   ${cpuIcon} CPU: ${r.cpuUsage} / ${r.cpuRequest} (${r.cpuEfficiency}%)\n`;
      msg += `   ${memIcon} Mem: ${r.memUsage} / ${r.memRequest} (${r.memEfficiency}%)\n\n`;
    }

    // Flag issues
    const overProvisioned = efficiency.filter((r) => r.cpuEfficiency < 10 && r.memEfficiency < 10);
    const nearLimit = efficiency.filter((r) => r.cpuEfficiency > 90 || r.memEfficiency > 90);

    if (overProvisioned.length > 0) {
      msg += `💤 <b>${overProvisioned.length} pod(s) heavily over-provisioned</b> (&lt;10% usage)\n`;
    }
    if (nearLimit.length > 0) {
      msg += `🔴 <b>${nearLimit.length} pod(s) near resource limits</b> (&gt;90% usage)\n`;
    }

    await telegram.send(msg);
    return;
  }

  // --- Doris backup health check ---
  if (cmd === '/dorisbackup' || cmd.match(/^(check\s+)?doris\s*backup/i)) {
    await telegram.send('🗄️ Checking Doris backup health...');

    // Check Doris pods health
    const dorisPods = await kube.getPods('doris');
    const bePods = dorisPods.filter((p) => p.name.includes('be'));
    const fePods = dorisPods.filter((p) => p.name.includes('fe'));

    // Check for the backup CronJob
    const events = await kube.getEvents('doris');
    const backupEvents = events.split('\n').filter((e) =>
      e.toLowerCase().includes('backup') ||
      e.toLowerCase().includes('cronjob') ||
      e.toLowerCase().includes('job')
    );

    // Check recent restarts (backup runs at 2AM, issues at ~9AM)
    const restarts = await kube.getRecentlyRestartedPods();
    const dorisRestarts = restarts.filter((r) => r.namespace === 'doris');

    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n🗄️ <b>DORIS BACKUP HEALTH</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `<b>Doris Pods:</b>\n`;
    for (const p of [...fePods, ...bePods]) {
      const icon = p.status === 'Running' && p.ready ? '✅' : '❌';
      msg += `${icon} <code>${p.name}</code> — ${p.status}, ${p.restarts} restarts\n`;
    }

    msg += `\n<b>Recent Doris Restarts:</b>\n`;
    if (dorisRestarts.length > 0) {
      for (const r of dorisRestarts) {
        const icon = r.oomKilled ? '💥' : '🔄';
        msg += `${icon} <code>${r.name}</code> — ${r.lastRestartReason} at ${r.lastRestartTime !== 'unknown' ? new Date(r.lastRestartTime).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore' }) : '?'}\n`;
      }
    } else {
      msg += `✅ No recent restarts\n`;
    }

    if (backupEvents.length > 0) {
      msg += `\n<b>Backup-Related Events:</b>\n`;
      msg += backupEvents.slice(0, 5).join('\n');
    }

    // Check BE pod memory (if >60GB, fragmentation risk after backup)
    const dorisMetrics = await kube.getTopPods('doris');
    const beMetrics = dorisMetrics.filter((m) => m.name.includes('be'));
    if (beMetrics.length > 0) {
      msg += `\n\n<b>BE Memory Usage:</b>\n`;
      for (const m of beMetrics) {
        const memMi = parseInt(m.memory);
        const memGi = (memMi / 1024).toFixed(1);
        const icon = memMi > 60000 ? '🔴 HIGH' : memMi > 40000 ? '🟡 MODERATE' : '🟢 OK';
        msg += `${icon} — <code>${m.name}</code>: ${memGi}Gi (${m.memory})\n`;
        if (memMi > 60000) {
          msg += `   ⚠️ High memory — possible post-backup fragmentation\n`;
        }
      }
    }

    await telegram.send(msg);
    return;
  }

  // --- Loki error analysis ---
  if (cmd === '/loki' || cmd.startsWith('/loki ') || cmd.match(/^(log\s+)?errors?\s*(for|in)?\s/i)) {
    const nsArg = cmd.replace(/^\/(loki|errors?)\s*/, '').replace(/^(log\s+)?errors?\s*(for|in)?\s*/i, '').trim() || 'prod';
    await telegram.send(`📊 Querying Loki logs for <b>${nsArg}</b>...`);

    const [stats, patterns, trend] = await Promise.all([
      lokiClient.getLogStats(nsArg, '.*', '1h').catch(() => null),
      lokiClient.getErrorPatterns(nsArg, '1h', 200).catch(() => []),
      lokiClient.getErrorTrend(nsArg, '.*').catch(() => 'unknown' as const),
    ]);

    let msg = `━━━━━━━━━━━━━━━━━━━━━━\n📊 <b>LOKI LOG ANALYSIS</b> (${nsArg})\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (stats) {
      msg += `<pre>${lokiClient.formatStats(stats, trend)}</pre>\n\n`;
    } else {
      msg += `⚠️ Could not fetch log stats (Loki may be unreachable)\n\n`;
    }

    if (patterns.length > 0) {
      msg += `🔍 <b>Top Error Patterns:</b>\n<pre>${lokiClient.formatPatterns(patterns).substring(0, 3000)}</pre>`;
    } else {
      msg += `✅ No error patterns found in the last hour.`;
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
  // Match: /email command, or "email/send/forward/share" + email address or team name
  const hasEmailAddress = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const hasTeamName = cmd.match(/\b(email|send|forward|share)\b/i) &&
    (cmd.match(/\b(team|all|everyone)\b/i) || Object.keys(TEAM_EMAILS).some((name) => cmd.includes(name)));
  if (cmd.startsWith('/email ') || (hasEmailAddress && cmd.match(/\b(email|send|forward|share)\b/i)) || hasTeamName) {
    const emailArgs = cmd.startsWith('/email ') ? cmd.replace('/email ', '').trim() : text;

    // Resolve recipients: "team" → all, names → lookup, or raw email addresses
    let recipients: string[] = [];

    if (emailArgs.match(/\bteam\b|\ball\b|\beveryone\b/i)) {
      recipients = TEAM_ALL;
    } else {
      // First grab any full email addresses
      const rawEmails = text.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
      recipients.push(...rawEmails);

      // Then resolve names from team directory
      const words = emailArgs.toLowerCase().split(/[\s,]+/);
      for (const word of words) {
        if (TEAM_EMAILS[word] && !recipients.includes(TEAM_EMAILS[word])) {
          recipients.push(TEAM_EMAILS[word]);
        }
      }
    }

    if (recipients.length === 0) {
      const nameList = Object.keys(TEAM_EMAILS).join(', ');
      await telegram.send(`Usage: /email &lt;name|email|team&gt;\n\nTeam: ${nameList}\n\nExamples:\n<code>/email zeeshan</code>\n<code>/email team</code>\n<code>/email zeeshan abdul</code>`);
      return;
    }

    if (!lastIncident) {
      lastIncident = {
        monitor: 'BLUE.Y Report',
        status: 'Info',
        analysis: lastBotResponse || 'No recent analysis available.',
        description: lastBotResponse ? undefined : text,
        timestamp: new Date().toISOString(),
      };
    }

    await telegram.send(`📧 Sending to ${recipients.join(', ')}...`);
    const { subject, body } = emailClient.formatIncidentEmail(lastIncident);
    const ok = await emailClient.sendIncidentReport(recipients, subject, body);
    await telegram.send(ok
      ? `✅ Sent to ${recipients.join(', ')}`
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
    if (!pendingAction || Date.now() - pendingAction.timestamp > 300000) {
      await telegram.send('❌ No pending action or it expired (5 min timeout).');
      pendingAction = null;
      return;
    }

    const { action, target, namespace, detail, teamsTicketId, jiraKey } = pendingAction;
    pendingAction = null;

    if (action === 'restart') {
      const eta = getETA('restart', target);
      await telegram.send(
        `⚡ <b>EXECUTING ACTION</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔄 <b>Action:</b> Restart\n` +
        `📦 <b>Target:</b> <code>${target}</code>\n` +
        `🏷️ <b>Namespace:</b> ${namespace}\n` +
        `⏱️ <b>ETA:</b> ${eta.label}`,
      );
      const ok = await kube.restartDeployment(namespace, target);
      if (ok) {
        await telegram.send(`✅ Restart initiated — monitoring <code>${target}</code> for recovery...`);
        if (teamsTicketId) {
          const card = TeamsCards.actionProgress('restart', target, eta.label);
          await teamsClient.replyWithCard(teamsTicketId, card);
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Action approved by ops: restart ${namespace}/${target} — initiated. ETA: ${eta.label}. Monitoring recovery...`);
        }
        // Fire-and-forget background health monitor
        monitorActionOutcome({ action: 'restart', target, namespace, teamsTicketId, jiraKey, eta }).catch(
          (err) => logger.error(`[Monitor] Background monitor failed: ${err}`));
      } else {
        await telegram.send(`❌ Failed to restart <code>${target}</code>.`);
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            'The ops team attempted to fix the issue but the restart command failed. They\'re investigating further.');
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Action approved by ops: restart ${namespace}/${target} — FAILED. Manual investigation needed.`);
        }
      }
    } else if (action === 'scale') {
      const replicas = parseInt(detail || '1');
      const eta = getETA('scale', target);
      await telegram.send(
        `⚡ <b>EXECUTING ACTION</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📐 <b>Action:</b> Scale to ${replicas}\n` +
        `📦 <b>Target:</b> <code>${target}</code>\n` +
        `🏷️ <b>Namespace:</b> ${namespace}\n` +
        `⏱️ <b>ETA:</b> ${eta.label}`,
      );
      const ok = await kube.scaleDeployment(namespace, target, replicas);
      if (ok) {
        await telegram.send(`✅ Scale initiated — monitoring <code>${target}</code> for recovery...`);
        if (teamsTicketId) {
          const card = TeamsCards.actionProgress('scale', `${target} → ${replicas} replicas`, eta.label);
          await teamsClient.replyWithCard(teamsTicketId, card);
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Action approved by ops: scale ${namespace}/${target} to ${replicas} — initiated. ETA: ${eta.label}. Monitoring...`);
        }
        monitorActionOutcome({ action: 'scale', target, namespace, teamsTicketId, jiraKey, eta }).catch(
          (err) => logger.error(`[Monitor] Background monitor failed: ${err}`));
      } else {
        await telegram.send(`❌ Failed to scale <code>${target}</code>.`);
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            'The ops team attempted to scale the service but it failed. They\'re investigating further.');
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey,
            `[BLUE.Y] Action approved by ops: scale ${namespace}/${target} to ${replicas} — FAILED. Manual investigation needed.`);
        }
      }
    } else if (action === 'diagnose') {
      // Run full diagnostic on the target pod
      await telegram.send(`🔬 Running full diagnostic on <code>${target}</code>...`);
      if (teamsTicketId) {
        await teamsClient.updateTicket(teamsTicketId, 'in_progress',
          'The ops team has approved a diagnostic. Running full analysis now...');
      }
      const found = await kube.findPod(target);
      if (found) {
        const [desc, descPlain, logs, events, lokiErrors, lokiStats2, lokiTrend2] = await Promise.all([
          kube.describePod(found.namespace, found.pod.name, 'html'),
          kube.describePod(found.namespace, found.pod.name, 'plain'),
          kube.getPodLogs(found.namespace, found.pod.name, 50),
          kube.getEvents(found.namespace, found.pod.name),
          lokiClient.getErrorLogs(found.namespace, found.pod.name, '1h', 30).catch(() => [] as string[]),
          lokiClient.getLogStats(found.namespace, found.pod.name, '1h').catch(() => null),
          lokiClient.getErrorTrend(found.namespace, found.pod.name).catch(() => 'unknown' as const),
        ]);
        await telegram.send(`🔎 <b>Pod Details:</b>\n${desc}`);
        if (logs && logs.length > 10) {
          await telegram.send(`📋 <b>Recent Logs:</b>\n<pre>${logs.substring(0, 3000)}</pre>`);
        }
        if (events && events !== 'No recent events found.') {
          await telegram.send(`📢 <b>Events:</b>\n${events}`);
        }
        // Loki data
        const lokiStatsStr2 = lokiStats2 ? lokiClient.formatStats(lokiStats2, lokiTrend2) : '';
        if (lokiStatsStr2) {
          await telegram.send(`📊 <b>Log Analysis (Loki):</b>\n<pre>${lokiStatsStr2}</pre>`);
        }
        const lokiContext2 = lokiStatsStr2
          ? `\n\n=== LOKI LOG ANALYSIS ===\n${lokiStatsStr2}\n\nRecent Error Logs:\n${lokiErrors.slice(0, 10).join('\n').substring(0, 1500)}`
          : '';
        // AI analysis
        let analysisText = '';
        try {
          const analysis = await bedrock.analyze({
            type: 'incident',
            message: `Diagnose pod ${found.pod.name} in namespace ${found.namespace}`,
            context: { pod: found.pod, description: descPlain, recentLogs: logs.substring(0, 2000), events, lokiAnalysis: lokiContext2 || undefined },
          });
          analysisText = analysis.analysis || '';
          await telegram.send(`🧠 <b>AI Analysis:</b>\n\n${analysisText}`);
        } catch (aiErr) {
          logger.error(`[Diagnose] AI analysis failed for ${target}`, aiErr);
          analysisText = `AI analysis unavailable.\n\n${descPlain}\n\nRecent logs: ${logs.substring(0, 500)}`;
          await telegram.send(`⚠️ AI analysis failed. Raw data shown above.`);
        }

        // Strip any HTML from analysis text for Teams/Jira (plain text contexts)
        const plainAnalysis = analysisText.replace(/<[^>]+>/g, '');

        // Always send back to Teams — even if AI failed, send the raw summary
        if (teamsTicketId) {
          try {
            const diagCard = TeamsCards.diagnosticResults(
              found.pod.name, found.namespace,
              plainAnalysis || `Pod is running.\n\n${descPlain.substring(0, 500)}`,
              teamsTicketId,
            );
            await teamsClient.replyWithCard(teamsTicketId, diagCard);
            logger.info(`[Teams] Sent diagnostic card to ticket ${teamsTicketId}`);
          } catch (teamsErr) {
            logger.error(`[Teams] Failed to send diagnostic to ticket ${teamsTicketId}`, teamsErr);
          }
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey, `[BLUE.Y] Diagnostic completed for ${found.namespace}/${found.pod.name}.\n\n${analysisText}`);
        }
        await telegram.send(`💡 Use <code>/email user@blueonion.today</code> or <code>/jira</code> to share this report.`);
      } else {
        await telegram.send(`❓ Pod matching "${target}" not found. Try /diagnose manually.`);
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            'The ops team is investigating your issue manually. They\'ll follow up with you directly.');
        }
      }
    } else if (action === 'create_jira') {
      // Create Jira ticket for a declined action
      if (!config.jira.apiToken) {
        await telegram.send('❌ Jira not configured. Set JIRA_EMAIL and JIRA_API_TOKEN.');
        return;
      }

      await telegram.send('🎫 Creating Jira ticket...');

      // Get the Teams ticket for context
      const teamsTicket = teamsTicketId ? teamsClient.getTicket(teamsTicketId) : null;
      const issueText = teamsTicket?.userMessage || target || 'issue';

      // Dedup: check for existing ticket with similar keywords
      const keywords = issueText.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).slice(0, 5).join(' ');
      const existing = await jiraClient.findDuplicate(keywords);

      if (existing) {
        // Duplicate found — add comment instead of creating new ticket
        await jiraClient.addComment(existing.key,
          `[BLUE.Y] Follow-up report (action declined by ops):\n\n"${issueText}"\n\nDiagnosis: ${teamsTicket?.diagnosis || lastBotResponse || 'N/A'}`);
        await telegram.send(`🔄 Existing ticket found: <a href="${existing.url}">${existing.key}</a> — added comment instead of creating duplicate.`);

        if (teamsTicketId) {
          const card = TeamsCards.diagnosis(
            teamsTicket?.diagnosis || 'Your issue is being tracked.',
            'escalated', teamsTicketId,
            { jiraUrl: existing.url, jiraKey: existing.key },
          );
          await teamsClient.replyWithCard(teamsTicketId, card);
        }
      } else {
        // No duplicate — create new ticket
        const summary = teamsTicket
          ? `[Teams] ${teamsTicket.userName}: ${teamsTicket.userMessage.substring(0, 80)}`
          : `[BLUE.Y] ${target || 'Issue'} — needs investigation`;
        const description = teamsTicket
          ? `Reported by: ${teamsTicket.userName} (via Microsoft Teams)\n\nOriginal message: "${teamsTicket.userMessage}"\n\nDiagnosis: ${teamsTicket.diagnosis || lastBotResponse || 'Pending investigation'}\n\nSuggested action was declined by ops (${detail || 'unknown action'}).`
          : `Reported via BLUE.Y monitoring.\n\nTarget: ${namespace}/${target}\n\nSuggested action (${detail}) was declined by ops.`;

        const jiraTicket = await jiraClient.createIncidentTicket({
          summary,
          description,
          analysis: teamsTicket?.diagnosis || lastBotResponse || '',
        });

        if (jiraTicket) {
          await telegram.send(`✅ Jira ticket created: <a href="${jiraTicket.url}">${jiraTicket.key}</a>`);

          if (teamsTicketId) {
            const card = TeamsCards.diagnosis(
              teamsTicket?.diagnosis || 'Your issue has been logged and the ops team will investigate.',
              'escalated', teamsTicketId,
              { jiraUrl: jiraTicket.url, jiraKey: jiraTicket.key },
            );
            await teamsClient.replyWithCard(teamsTicketId, card);
          }
        } else {
          await telegram.send('❌ Failed to create Jira ticket. Check credentials.');
          if (teamsTicketId) {
            await teamsClient.updateTicket(teamsTicketId, 'escalated',
              'The ops team is tracking your issue and will follow up directly.');
          }
        }
      }
    } else {
      await telegram.send(`⚠️ Unknown action: ${action}. Try running the command manually.`);
    }
    return;
  }

  if (cmd === '/no' || cmd === 'no' || cmd === 'n') {
    if (pendingAction) {
      const { teamsTicketId, jiraKey, action, target, namespace } = pendingAction;
      const declinedAction = pendingAction;
      pendingAction = null;

      // If Jira ticket already exists from the Teams report flow, update it
      if (jiraKey) {
        await jiraClient.addComment(jiraKey,
          '[BLUE.Y] Suggested action declined by ops. Issue escalated for manual handling.');
        await telegram.send(
          `👌 Action cancelled.\n\n` +
          `🎫 Jira ticket <b>${jiraKey}</b> has been updated with the declined action.`,
        );

        // Notify Teams user with Jira ticket details
        if (teamsTicketId) {
          const jiraUrl = `${config.jira.baseUrl}/browse/${jiraKey}`;
          const card = TeamsCards.diagnosis(
            'The ops team has reviewed your issue and decided on a different approach. ' +
            'A Jira ticket has been created to track this — the team will follow up with you.',
            'escalated', teamsTicketId, { jiraUrl, jiraKey },
          );
          await teamsClient.replyWithCard(teamsTicketId, card);
          const t = teamsClient.getTicket(teamsTicketId);
          if (t) t.status = 'escalated';
        }
      } else if (config.jira.apiToken) {
        // No Jira ticket yet — create one automatically
        const teamsTicket = teamsTicketId ? teamsClient.getTicket(teamsTicketId) : null;
        const issueText = teamsTicket?.userMessage || target || 'issue';

        // Dedup check
        const keywords = issueText.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).slice(0, 5).join(' ');
        const existing = await jiraClient.findDuplicate(keywords);

        if (existing) {
          await jiraClient.addComment(existing.key,
            `[BLUE.Y] Action declined by ops. Issue escalated for manual handling.\n\nOriginal: "${issueText}"`);
          await telegram.send(
            `👌 Action cancelled.\n\n` +
            `🎫 Existing Jira ticket: <a href="${existing.url}">${existing.key}</a> — updated.`,
          );
          if (teamsTicketId) {
            const card = TeamsCards.diagnosis(
              'The ops team is handling your issue. A Jira ticket is tracking this.',
              'escalated', teamsTicketId, { jiraUrl: existing.url, jiraKey: existing.key });
            await teamsClient.replyWithCard(teamsTicketId, card);
          }
        } else {
          const summary = teamsTicket
            ? `[Teams] ${teamsTicket.userName}: ${issueText.substring(0, 80)}`
            : `[BLUE.Y] ${target || 'Issue'} — needs investigation`;
          const jiraTicket = await jiraClient.createIncidentTicket({
            summary,
            description: `Action (${declinedAction.action}) was declined by ops. Escalated for manual handling.\n\nOriginal: "${issueText}"`,
            analysis: teamsTicket?.diagnosis || lastBotResponse || '',
          });
          if (jiraTicket) {
            await telegram.send(
              `👌 Action cancelled.\n\n` +
              `🎫 Jira ticket created: <a href="${jiraTicket.url}">${jiraTicket.key}</a>`,
            );
            if (teamsTicketId) {
              const card = TeamsCards.diagnosis(
                'The ops team is handling your issue. A Jira ticket has been created to track it.',
                'escalated', teamsTicketId, { jiraUrl: jiraTicket.url, jiraKey: jiraTicket.key });
              await teamsClient.replyWithCard(teamsTicketId, card);
            }
          } else {
            await telegram.send('👌 Action cancelled.\n\n⚠️ Failed to create Jira ticket.');
          }
        }
      } else {
        await telegram.send('👌 Action cancelled.');
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            'The ops team is handling your issue and will follow up directly.');
        }
      }
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
      `/hpa [ns] — HPA autoscaler status\n` +
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
      `<b>QA & Security:</b>\n` +
      `/smoketest — Test all production URLs\n` +
      `/securityscan — OWASP security header scan\n` +
      `/restarts — Pod restart root cause analysis\n` +
      `/efficiency — Resource usage vs requests\n` +
      `/dorisbackup — Doris backup health check\n` +
      `/loki [ns] — Loki log error analysis\n\n` +
      `<b>Reports:</b>\n` +
      `/report — Daily health report (manual trigger)\n` +
      `/email &lt;name|team&gt; — Email report (zeeshan, abdul, usama, wei, elsa, team)\n` +
      `/jira — Create Jira ticket\n` +
      `/incidents — Incident timeline\n\n` +
      `<b>System:</b>\n` +
      `/sleep — Pause monitoring\n` +
      `/wake — Resume monitoring\n\n` +
      `💡 Auto-diagnose is ON — I'll automatically investigate unhealthy pods.\n` +
      `📸 Teams users can attach screenshots — I'll analyze them with AI vision.\n` +
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

    lastBotResponse = response.analysis;
    await telegram.send(response.analysis);

    if (response.requiresAction && response.suggestedCommand) {
      // Parse the suggested action
      const actionParts = (response.suggestedCommand || '').split(' ');
      const actionName = actionParts[0]?.toLowerCase();
      if (actionName === 'restart' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'restart', target: dep, namespace: ns, timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> Restart <code>${dep}</code> in ${ns}\n\nReply /yes to execute or /no to cancel.`);
      } else if (actionName === 'scale' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        const replicas = actionParts[2] || '1';
        pendingAction = { action: 'scale', target: dep, namespace: ns, detail: replicas, timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> Scale <code>${dep}</code> to ${replicas}\n\nReply /yes to execute or /no to cancel.`);
      } else if (actionName === 'diagnose' && actionParts[1]) {
        const [ns, pod] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'diagnose', target: pod, namespace: ns, timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> Diagnose <code>${pod}</code> in ${ns}\n\nReply /yes to execute or /no to cancel.`);
      } else {
        // Unknown action — still store it so /yes doesn't say "no pending"
        pendingAction = { action: actionName || 'unknown', target: actionParts[1] || '', namespace: 'prod', timestamp: Date.now() };
        await telegram.send(`\n💡 <b>Suggested:</b> ${response.suggestedAction || response.suggestedCommand}\n\nReply /yes to execute or /no to cancel.`);
      }
    }
  } catch (err) {
    logger.error('Bedrock analysis failed', err);
    await telegram.send(
      `⚠️ AI unavailable right now. Here are the commands:\n\n` +
      `/status /check /nodes /smoketest /securityscan /restarts /efficiency /report /help`,
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
        { command: 'hpa', description: 'HPA autoscaler status' },
        { command: 'doris', description: 'Doris cluster health' },
        { command: 'deployments', description: 'List deployments' },
        { command: 'smoketest', description: 'Test all production URLs' },
        { command: 'securityscan', description: 'OWASP security scan' },
        { command: 'restarts', description: 'Pod restart root cause' },
        { command: 'efficiency', description: 'Resource usage analysis' },
        { command: 'report', description: 'Daily health report' },
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

// --- Microsoft Teams webhook endpoint ---
if (teamsClient.isEnabled()) {
  app.post('/api/messages', async (req, res) => {
    try {
      await teamsClient.getAdapter()!.process(req, res, async (context) => {
        await teamsClient.handleMessage(context);
      });
    } catch (err) {
      logger.error('[Teams] Webhook error', err);
      res.status(500).send();
    }
  });
  logger.info('Teams bot webhook registered at /api/messages');
}

// --- Teams user report handler (cross-channel flow) ---
teamsClient.setOnUserReport(async (ticket: TeamsTicket) => {
  const { id, userName, userMessage } = ticket;
  // Sanitize text for Telegram HTML — strip tags, escape special chars
  const safeTg = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Status check — just return cluster summary
  if (userMessage === 'status_check') {
    const summary = await kube.getClusterSummary();
    const plainSummary = summary.replace(/<b>/g, '**').replace(/<\/b>/g, '**').replace(/<[^>]+>/g, '');
    await teamsClient.updateTicket(id, 'resolved', plainSummary);
    return;
  }

  // Smoke test — run HTTP health checks on all prod URLs
  if (userMessage === 'smoke_test') {
    const results = await qaClient.smokeTest();
    const teamsMsg = qaClient.formatSmokeTestTeams(results);
    await teamsClient.updateTicket(id, 'resolved', teamsMsg);

    // Also notify ops on Telegram
    await telegram.send(qaClient.formatSmokeTestTelegram(results));
    return;
  }

  // Security scan — OWASP header checks
  if (userMessage === 'security_scan') {
    const results = await qaClient.securityScan();
    const teamsMsg = qaClient.formatSecurityScanTeams(results);
    await teamsClient.updateTicket(id, 'resolved', teamsMsg);

    // Also notify ops on Telegram
    await telegram.send(qaClient.formatSecurityScanTelegram(results));
    return;
  }

  // Diagnose the reported issue using AI
  await teamsClient.updateTicket(id, 'diagnosing');

  try {
    // Analyze attached images (screenshots) if any
    let imageContext = '';
    if (ticket.attachments && ticket.attachments.length > 0 && visionClient.isEnabled()) {
      logger.info(`[Teams] Analyzing ${ticket.attachments.length} image(s) for ticket ${id}`);
      const analyses = [];
      for (const att of ticket.attachments) {
        const result = await visionClient.analyzeImageUrl(att.contentUrl);
        // Only include successful analyses (not download failures or errors)
        if (result.extractedText || (result.description && !result.description.startsWith('Could not download') && !result.description.startsWith('Vision analysis failed'))) {
          analyses.push(result);
        }
      }
      if (analyses.length > 0) {
        imageContext = '\n\n=== SCREENSHOT ANALYSIS ===\n';
        for (let i = 0; i < analyses.length; i++) {
          const a = analyses[i];
          imageContext += `Image ${i + 1}:\n`;
          imageContext += `- Description: ${a.description}\n`;
          if (a.extractedText) imageContext += `- Extracted text: ${a.extractedText}\n`;
          if (a.errorScreenshot) imageContext += `- ERROR DETECTED: ${a.detectedIssue || 'yes'}\n`;
        }
        ticket.imageAnalysis = analyses.map((a) => a.detectedIssue || a.description).join('; ');
      } else {
        // Vision was enabled but all image analyses failed (download error, API error, etc.)
        imageContext = '\n\n⚠️ IMPORTANT: The user attached screenshot(s) but image analysis FAILED (could not download or process the images). You CANNOT see the images. Do NOT guess what the images show. Ask the user to describe the issue in text instead.';
      }
    } else if (ticket.attachments && ticket.attachments.length > 0 && !visionClient.isEnabled()) {
      imageContext = '\n\n⚠️ IMPORTANT: The user attached screenshot(s) but vision analysis is NOT available. You CANNOT see the images. Do NOT guess or hallucinate what the images show. Instead, tell the user you cannot analyze their screenshot yet and ask them to describe the issue in text. Be honest that image analysis is not currently configured.';
    }

    // Gather cluster context + Loki data in parallel
    const [clusterSummary, unhealthy, lokiProdStats, lokiProdPatterns] = await Promise.all([
      kube.getClusterSummary(),
      kube.getUnhealthyPods(),
      lokiClient.getLogStats('prod', '.*', '1h').catch(() => null),
      lokiClient.getErrorPatterns('prod', '1h', 100).catch(() => []),
    ]);

    // Build Loki context for AI
    let lokiContext = '';
    if (lokiProdStats) {
      const lokiTrend = await lokiClient.getErrorTrend('prod', '.*').catch(() => 'unknown' as const);
      lokiContext = `\n\n=== LOKI LOG ANALYSIS (prod, last 1h) ===\n${lokiClient.formatStats(lokiProdStats, lokiTrend)}`;
      if (lokiProdPatterns.length > 0) {
        lokiContext += `\n\nTop Error Patterns:\n${lokiClient.formatPatterns(lokiProdPatterns).substring(0, 1000)}`;
      }
    }

    // Get conversation history for this user (gives AI context of previous messages)
    const conversationContext = teamsClient.getConversationContext(userName);

    // Ask AI to analyze the user's report against cluster state + logs
    const analysis = await bedrock.analyze({
      type: 'user_report',
      message: `A user reported via Teams: "${userMessage}". Diagnose this issue.
        If you can identify a specific pod or service that's affected, say so.
        If an action (restart, scale) would fix it, suggest it clearly.
        Keep your response concise and user-friendly.${imageContext}${lokiContext}
        ${conversationContext ? `\nIMPORTANT — This user has prior conversation context. Read it carefully. If the user is referring to a previous issue or asking a follow-up (e.g. "resubmit", "what about", "same issue", "try again"), use the history to understand what they mean. Do NOT treat follow-ups as new issues.\n\n${conversationContext}` : ''}`,
      context: {
        clusterSummary,
        unhealthyPods: unhealthy.map((p) => ({
          name: p.name, namespace: p.namespace, status: p.status,
          restarts: p.restarts, containers: p.containers,
        })),
        timestamp: new Date().toISOString(),
      },
    });

    ticket.diagnosis = analysis.analysis;

    // --- Create Jira ticket (with dedup) ---
    let jiraKey = '';
    let jiraUrl = '';
    if (config.jira.apiToken) {
      // Extract key words for dedup search (first 5 significant words)
      const keywords = userMessage.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).slice(0, 5).join(' ');
      const existing = await jiraClient.findDuplicate(keywords);

      if (existing) {
        // Duplicate found — add comment instead of creating new ticket
        jiraKey = existing.key;
        jiraUrl = existing.url;
        await jiraClient.addComment(existing.key,
          `[BLUE.Y] New report from ${userName} (Teams):\n\n"${userMessage}"\n\nDiagnosis: ${analysis.analysis}`);
        logger.info(`[Teams] Jira duplicate found: ${existing.key}, added comment`);
      } else {
        // Create new ticket (include Loki data if available)
        const lokiStatsStr = lokiProdStats ? lokiClient.formatStats(lokiProdStats, await lokiClient.getErrorTrend('prod', '.*').catch(() => 'unknown' as const)) : '';
        const lokiPatternsStr = lokiProdPatterns.length > 0 ? lokiClient.formatPatterns(lokiProdPatterns) : '';
        const jiraTicket = await jiraClient.createIncidentTicket({
          summary: `[Teams] ${userName}: ${userMessage.substring(0, 80)}`,
          description: `Reported by: ${userName} (via Microsoft Teams)\n\nOriginal message: "${userMessage}"`,
          analysis: analysis.analysis,
          severity: analysis.requiresAction ? 'critical' : undefined,
          lokiStats: lokiStatsStr,
          lokiPatterns: lokiPatternsStr,
          lokiTrend: lokiProdStats ? await lokiClient.getErrorTrend('prod', '.*').catch(() => 'unknown') : undefined,
        });
        if (jiraTicket) {
          jiraKey = jiraTicket.key;
          jiraUrl = jiraTicket.url;
          logger.info(`[Teams] Jira ticket created: ${jiraTicket.key}`);
        }
      }
    }

    const jiraInfo = jiraKey ? `\n\nJira: [${jiraKey}](${jiraUrl})` : '';
    const jiraTgInfo = jiraKey ? `\n🎫 <a href="${jiraUrl}">${jiraKey}</a>` : '';

    // Record BLUE.Y's diagnosis in conversation history
    teamsClient.addToHistory(userName, 'assistant', `Diagnosis: ${analysis.analysis}${analysis.suggestedAction ? ` | Suggested: ${analysis.suggestedAction}` : ''}`, id, ticket.status);

    // Check if AI suggests an action that needs ops approval
    if (analysis.requiresAction && analysis.suggestedCommand) {
      ticket.suggestedAction = analysis.suggestedAction || analysis.suggestedCommand;
      const diagCard = TeamsCards.diagnosis(analysis.analysis, 'awaiting_approval', id, {
        screenshotAnalysis: ticket.imageAnalysis || undefined,
        suggestedAction: analysis.suggestedAction || analysis.suggestedCommand,
        jiraUrl: jiraUrl || undefined,
        jiraKey: jiraKey || undefined,
      });
      await teamsClient.replyWithCard(id, diagCard);
      ticket.status = 'awaiting_approval';
      teamsClient.addToHistory(userName, 'assistant', `[awaiting_approval] Diagnosis sent`, id, 'awaiting_approval');

      // Alert ops on Telegram for approval
      const severityIcon = analysis.severity === 'critical' ? '🔴' : analysis.severity === 'warning' ? '🟡' : '🟢';
      const severityLabel = analysis.severity?.toUpperCase() || 'INFO';
      await telegram.send(
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📩 <b>TEAMS REPORT</b> ${severityIcon} ${severityLabel}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 <b>From:</b> ${safeTg(userName)}\n` +
        `💬 <b>Issue:</b> ${safeTg(userMessage)}\n` +
        `${ticket.imageAnalysis ? `📸 <b>Screenshot:</b> ${safeTg(ticket.imageAnalysis)}\n` : ''}` +
        `\n🧠 <b>Diagnosis:</b>\n${safeTg(analysis.analysis)}\n\n` +
        `🔧 <b>Suggested Fix:</b> <code>${safeTg(analysis.suggestedAction || 'none')}</code>\n` +
        `${jiraTgInfo ? `${jiraTgInfo}\n` : ''}` +
        `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ Reply /yes to approve or /no to decline\n` +
        `🆔 <code>${id}</code>`,
      );

      // Parse the suggested action for pending approval
      const actionParts = (analysis.suggestedCommand || '').split(' ');
      const actionName = actionParts[0]?.toLowerCase();
      if (actionName === 'restart' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'restart', target: dep, namespace: ns, timestamp: Date.now(), teamsTicketId: id, jiraKey };
      } else if (actionName === 'scale' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        const replicas = actionParts[2] || '2';
        pendingAction = { action: 'scale', target: dep, namespace: ns, detail: replicas, timestamp: Date.now(), teamsTicketId: id, jiraKey };
      } else if (actionName === 'diagnose' && actionParts[1]) {
        const [ns, pod] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'diagnose', target: pod, namespace: ns, timestamp: Date.now(), teamsTicketId: id, jiraKey };
      } else {
        // Fallback: store any suggested action so /yes doesn't say "no pending action"
        pendingAction = { action: actionName || 'unknown', target: actionParts[1] || '', namespace: 'prod', timestamp: Date.now(), teamsTicketId: id, jiraKey };
      }
    } else {
      // No action needed — just inform the user and ops
      const resolvedCard = TeamsCards.diagnosis(analysis.analysis, 'resolved', id, {
        screenshotAnalysis: ticket.imageAnalysis || undefined,
        jiraUrl: jiraUrl || undefined,
        jiraKey: jiraKey || undefined,
      });
      await teamsClient.replyWithCard(id, resolvedCard);
      ticket.status = 'resolved';
      teamsClient.addToHistory(userName, 'assistant', `[resolved] ${analysis.analysis.substring(0, 200)}`, id, 'resolved');

      // Notify ops on Telegram (FYI, no action needed)
      await telegram.send(
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📩 <b>TEAMS REPORT</b> 🟢 RESOLVED\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 <b>From:</b> ${safeTg(userName)}\n` +
        `💬 <b>Issue:</b> ${safeTg(userMessage)}\n\n` +
        `🧠 <b>Diagnosis:</b>\n${safeTg(analysis.analysis.substring(0, 300))}\n\n` +
        `✅ No action required — auto-resolved${jiraTgInfo}`,
      );

      // Close Jira with resolution comment
      if (jiraKey) {
        await jiraClient.addComment(jiraKey, `[BLUE.Y] Auto-resolved — no action required.\n\nDiagnosis: ${analysis.analysis}`);
      }
    }
  } catch (err) {
    logger.error(`[Teams] Failed to diagnose ticket ${id}`, err);

    // Escalate to ops on failure
    await teamsClient.updateTicket(id, 'escalated',
      `I couldn't automatically diagnose this issue. ` +
      `I've escalated it to the ops team — they'll look into it and get back to you.`,
    );

    await telegram.send(
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📩 <b>TEAMS REPORT</b> 🔴 ESCALATED\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <b>From:</b> ${safeTg(userName)}\n` +
      `💬 <b>Issue:</b> ${safeTg(userMessage)}\n\n` +
      `⚠️ Auto-diagnosis failed — please investigate manually`,
    );
  }
});

// --- Daily Health Report ---
async function generateDailyReport(): Promise<void> {
  logger.info('[Report] Generating daily health report...');
  const now = new Date().toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });

  try {
    // Gather all data in parallel (including Loki)
    const [clusterSummary, smokeResults, restarts, incidents, lokiProdReport, lokiDorisReport] = await Promise.all([
      kube.getClusterSummary(),
      qaClient.smokeTest(),
      kube.getRecentlyRestartedPods(),
      Promise.resolve(scheduler.getIncidentLog()),
      lokiClient.getLogStats('prod', '.*', '24h').catch(() => null),
      lokiClient.getLogStats('doris', '.*', '24h').catch(() => null),
    ]);

    const healthyServices = smokeResults.filter((r) => r.healthy).length;
    const totalServices = smokeResults.length;
    const allHealthy = healthyServices === totalServices;
    const oomRestarts = restarts.filter((r) => r.oomKilled);

    // --- Telegram report ---
    let tgMsg = `━━━━━━━━━━━━━━━━━━━━━━\n`;
    tgMsg += `📋 <b>DAILY HEALTH REPORT</b>\n`;
    tgMsg += `📅 ${now}\n`;
    tgMsg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Cluster health
    tgMsg += clusterSummary + '\n\n';

    // Service health
    tgMsg += `🧪 <b>Service Health:</b> ${allHealthy ? '✅ All pass' : `⚠️ ${totalServices - healthyServices} failing`}\n`;
    for (const r of smokeResults) {
      const icon = r.healthy ? '✅' : '❌';
      const speed = r.responseTime < 500 ? '' : r.responseTime < 2000 ? ' 🟡' : ' 🐢';
      tgMsg += `${icon} ${r.name} — ${r.status || 'TIMEOUT'} (${r.responseTime}ms)${speed}\n`;
    }

    // Restarts
    tgMsg += `\n🔄 <b>Pod Restarts (24h):</b> ${restarts.length}`;
    if (oomRestarts.length > 0) {
      tgMsg += ` (${oomRestarts.length} OOM)`;
    }
    tgMsg += '\n';
    for (const r of restarts.slice(0, 5)) {
      const icon = r.oomKilled ? '💥' : '🔄';
      tgMsg += `${icon} <code>${r.name.substring(0, 35)}</code> — ${r.lastRestartReason} (${r.restarts}x)\n`;
    }

    // Incidents
    if (incidents.length > 0) {
      tgMsg += `\n🚨 <b>Incidents (since last restart):</b> ${incidents.length}\n`;
      for (const inc of incidents.slice(-3)) {
        tgMsg += `• ${inc.namespace}/${inc.pod} — ${inc.status}\n`;
      }
    }

    // Loki log summary
    if (lokiProdReport || lokiDorisReport) {
      tgMsg += `\n📊 <b>Log Health (24h):</b>\n`;
      if (lokiProdReport) {
        const errIcon = lokiProdReport.errorRate > 5 ? '🔴' : lokiProdReport.errorRate > 1 ? '🟡' : '🟢';
        tgMsg += `${errIcon} prod — ${lokiProdReport.totalLines.toLocaleString()} lines, ${lokiProdReport.errorLines} errors (${lokiProdReport.errorRate.toFixed(1)}%), ${lokiProdReport.warnLines} warns\n`;
      }
      if (lokiDorisReport) {
        const errIcon = lokiDorisReport.errorRate > 5 ? '🔴' : lokiDorisReport.errorRate > 1 ? '🟡' : '🟢';
        tgMsg += `${errIcon} doris — ${lokiDorisReport.totalLines.toLocaleString()} lines, ${lokiDorisReport.errorLines} errors (${lokiDorisReport.errorRate.toFixed(1)}%), ${lokiDorisReport.warnLines} warns\n`;
      }
    }

    // SSL expiry warnings
    const sslWarnings = smokeResults.filter((r) => r.sslDaysLeft !== undefined && r.sslDaysLeft < 30);
    if (sslWarnings.length > 0) {
      tgMsg += `\n🔒 <b>SSL Expiry Warnings:</b>\n`;
      for (const r of sslWarnings) {
        tgMsg += `⚠️ ${r.name} — ${r.sslDaysLeft} days left\n`;
      }
    }

    tgMsg += `\n━━━━━━━━━━━━━━━━━━━━━━`;
    await telegram.send(tgMsg);

    // --- Teams report (for users) ---
    if (teamsClient.isEnabled()) {
      let teamsMsg = `**Daily Health Report — ${now}**\n\n`;
      teamsMsg += `**Services:** ${healthyServices}/${totalServices} healthy\n`;
      for (const r of smokeResults) {
        teamsMsg += `${r.healthy ? '✅' : '❌'} ${r.name}\n`;
      }
      if (restarts.length > 0) {
        teamsMsg += `\n**Pod Restarts (24h):** ${restarts.length}`;
        if (oomRestarts.length > 0) teamsMsg += ` (${oomRestarts.length} memory issues)`;
        teamsMsg += '\n';
      }
      // Note: Teams daily report is only sent via Telegram for ops.
      // Uncomment below to also send to Teams channel:
      // await teamsClient.replyToTicket(..., teamsMsg);
    }

    logger.info('[Report] Daily health report sent');
  } catch (err) {
    logger.error('[Report] Failed to generate daily report', err);
    await telegram.send('❌ Daily health report failed. Check logs.');
  }
}

// Start
app.listen(config.port, () => {
  logger.info(`BLUE.Y started on port ${config.port}`);
  scheduler.start();

  // Schedule daily health report
  CronJob.from({
    cronTime: config.schedules.dailyReport,
    onTick: generateDailyReport,
    start: true,
    timeZone: 'Asia/Singapore',
  });
  logger.info(`Daily health report scheduled: ${config.schedules.dailyReport} (SGT)`);

  // Start Telegram polling if bot token is configured
  if (config.telegram.botToken) {
    startPolling().catch((err) => logger.error('Polling fatal error', err));
  }
});
