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
import { DatabaseClient } from './clients/database';
import { DbAgentPipeline } from './clients/db-agents';
import { BitbucketClient } from './clients/bitbucket';
import { AwsMonitorClient } from './clients/aws-monitor';
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
const dbClient = config.database.enabled ? new DatabaseClient() : null;
const dbPipeline = dbClient ? new DbAgentPipeline(dbClient) : null;
const bbClient = config.bitbucket.enabled ? new BitbucketClient() : null;
const awsMonitor = new AwsMonitorClient();

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
let pendingAction: { action: string; target: string; namespace: string; detail?: string; timestamp: number; teamsTicketId?: string; jiraKey?: string; dmChatId?: string; dmUserName?: string } | null = null;

// Allowed services for password reset
const PASSWORD_RESET_SERVICES = ['aws', 'office365', 'microsoft365', 'o365', 'm365', 'database', 'db', 'rds', 'grafana'] as const;

// Extract meaningful keywords for Jira dedup (strips filler words)
const FILLER_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their', 'hi', 'hello', 'hey', 'please', 'thanks', 'again', 'also', 'still', 'already', 'issue', 'problem', 'help', 'need', 'want', 'like', 'get', 'got', 'getting']);
function extractKeywords(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER_WORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .join(' ');
}

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

// Handle DMs to BLUE.Y (password reset requests, etc.)
async function handleTelegramDM(text: string, chatId: string, userName: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

  // Password reset detection
  const resetMatch = cmd.match(/(?:reset|forgot|change|update|new)\s+(?:my\s+)?(?:password|pwd|pass|credentials?|login)\s*(?:for|on|of|in)?\s*(.*)/i)
    || cmd.match(/(aws|office\s*365|microsoft\s*365|o365|m365|database|db|rds|grafana)\s+(?:password|pwd|pass|credentials?|login)\s*(?:reset|forgot|change|new)?/i)
    || cmd.match(/(?:i\s+)?(?:forgot|lost|can'?t\s+(?:login|log\s*in|access|remember))\s*(?:to|my|the)?\s*(?:password|pwd|pass|credentials?)?\s*(?:for|on|of|in)?\s*(.*)/i);

  if (resetMatch) {
    const serviceRaw = (resetMatch[1] || '').trim().toLowerCase();

    // Detect service
    let service = 'unknown';
    if (/aws|console|iam/i.test(serviceRaw) || /aws|console|iam/i.test(cmd)) service = 'aws';
    else if (/office|o365|m365|microsoft|outlook|teams|365/i.test(serviceRaw) || /office|o365|m365|microsoft|outlook|teams|365/i.test(cmd)) service = 'office365';
    else if (/database|db|rds|mysql|postgres/i.test(serviceRaw) || /database|db|rds|mysql/i.test(cmd)) service = 'database';
    else if (/grafana/i.test(serviceRaw) || /grafana/i.test(cmd)) service = 'grafana';

    if (service === 'unknown') {
      await telegram.send(
        `👋 Hi ${userName}!\n\n` +
        `I can help reset your password, but please specify which service:\n\n` +
        `• <b>AWS Console</b> — "reset my password for AWS"\n` +
        `• <b>Microsoft 365</b> — "forgot my Office 365 password"\n` +
        `• <b>Database</b> — "reset my database password"\n` +
        `• <b>Grafana</b> — "forgot my Grafana login"\n\n` +
        `Just tell me which one and I'll request admin approval.`,
        chatId,
      );
      return;
    }

    const serviceLabels: Record<string, string> = {
      aws: 'AWS Console (IAM)',
      office365: 'Microsoft 365 (Office)',
      database: 'Database (RDS)',
      grafana: 'Grafana',
    };

    // Notify admin channel for approval (no raw message — could contain sensitive info)
    await telegram.send(
      `🔐 <b>PASSWORD RESET REQUEST</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${userName}\n` +
      `🏷️ <b>Service:</b> ${serviceLabels[service] || service}\n` +
      `⏰ <b>Time:</b> ${new Date().toISOString()}\n\n` +
      `⚠️ Reply <code>/yes</code> to approve or <code>/no</code> to deny.`,
    );

    // Store as pending action
    pendingAction = {
      action: 'password_reset',
      target: service,
      namespace: userName,
      detail: chatId,
      timestamp: Date.now(),
      dmChatId: chatId,
      dmUserName: userName,
    };

    // Confirm to user
    await telegram.send(
      `✅ Got it, ${userName}! Your password reset request for <b>${serviceLabels[service]}</b> has been sent to the admin for approval.\n\n` +
      `⏳ I'll notify you once it's approved and processed. This usually takes a few minutes.`,
      chatId,
    );

    logger.info(`[DM] Password reset request from ${userName} (${chatId}) for ${service}`);
    return;
  }

  // Cheatsheet in DM
  if (cmd === '/cheatsheet' || cmd === '/cheat' || cmd === '/commands') {
    await telegram.send(
      `📖 <b>BLUE.Y Command Reference</b>\n\n` +
      `All commands below work in the <b>team channel only</b>.\n` +
      `In DMs, only password resets are available.\n\n` +
      `🔍 /status /check /nodes /resources /hpa /doris\n` +
      `📦 /logs /describe /events /deployments /diagnose\n` +
      `⚡ /restart /scale (+ /yes /no)\n` +
      `🛡️ /smoketest /securityscan /restarts /loki\n` +
      `📧 /report /email /incidents\n` +
      `🎫 /jira /report-issue /tickets\n` +
      `🗄️ /db /databases /tables /query\n` +
      `🔧 /build /builds /pipelines\n` +
      `☁️ /rds /jobs /costs /backups /backend /cronjobs /diff\n` +
      `⚙️ /sleep /wake /help /cheatsheet\n\n` +
      `💡 Use <code>/cheatsheet</code> in the team channel for the full detailed reference with examples.`,
      chatId,
    );
    return;
  }

  // Help / greeting in DM
  if (cmd === '/start' || cmd === '/help' || cmd === 'hi' || cmd === 'hello' || cmd === 'hey') {
    await telegram.send(
      `👋 Hi ${userName}! I'm <b>BLUE.Y</b>, your AI ops assistant.\n\n` +
      `In DMs, I can only help with:\n\n` +
      `🔐 <b>Password Reset</b>\n` +
      `• "Reset my AWS password"\n` +
      `• "I forgot my Office 365 password"\n` +
      `• "I can't login to Grafana"\n` +
      `• "Need new database credentials"\n\n` +
      `📖 <code>/cheatsheet</code> — View command list\n\n` +
      `All other commands work in the <b>team channel</b> only.\n` +
      `All password requests require admin approval for security.`,
      chatId,
    );
    return;
  }

  // Everything else in DM → redirect to channel
  await telegram.send(
    `Hi ${userName}! DMs are only for <b>password resets</b>.\n\n` +
    `For monitoring, deployments, and all other commands, please use the <b>team channel</b>.\n\n` +
    `🔐 Need a password reset? Try:\n` +
    `• "Reset my password for AWS"\n` +
    `• "Forgot my Office 365 password"\n\n` +
    `📖 <code>/cheatsheet</code> — View all commands`,
    chatId,
  );
}

// Handle incoming Telegram commands (group channel)
async function handleTelegramCommand(text: string, chatId: string): Promise<void> {
  // Strip @BotName suffix from commands (Telegram appends it in groups)
  const cmd = text.toLowerCase().trim().replace(/@\w+/g, '');

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

  // --- Jira ticket queries ---
  if (cmd === '/tickets' || cmd === '/ticket' || cmd.startsWith('/tickets ') || cmd.startsWith('/ticket ')) {
    if (!config.jira.apiToken) {
      await telegram.send('❌ Jira not configured. Set JIRA_EMAIL and JIRA_API_TOKEN env vars.');
      return;
    }

    const ticketArgs = text.replace(/^\/tickets?\s*/i, '').trim();

    // /tickets summary — project overview
    if (!ticketArgs || ticketArgs === 'summary' || ticketArgs === 'overview') {
      await telegram.send('📊 Fetching project summary...');
      const summary = await jiraClient.getProjectSummary();

      let msg = `📊 <b>${config.jira.projectKey} — Open Tickets: ${summary.total}</b>\n\n`;
      msg += '<b>By Status:</b>\n';
      for (const [status, count] of Object.entries(summary.byStatus).sort((a, b) => b[1] - a[1])) {
        msg += `  • ${status}: <b>${count}</b>\n`;
      }
      msg += '\n<b>By Assignee:</b>\n';
      for (const [assignee, count] of Object.entries(summary.byAssignee).sort((a, b) => b[1] - a[1])) {
        msg += `  • ${assignee}: <b>${count}</b>\n`;
      }
      await telegram.send(msg);
      return;
    }

    // /tickets <person name> — tickets for a specific person
    await telegram.send(`🔍 Searching tickets for "${ticketArgs}"...`);
    const { issues, total } = await jiraClient.getTicketsForPerson(ticketArgs);
    await telegram.send(JiraClient.formatTicketsForTelegram(issues, `Tickets for "${ticketArgs}"`, total));
    return;
  }

  // Natural language Jira queries
  const jiraQueryMatch = text.match(/(?:how many|show|list|what|get)\s+(?:jira\s+)?(?:tickets?|issues?|tasks?)\s+(?:are\s+)?(?:assigned\s+(?:to|for)|(?:pending|open|remaining)\s+(?:for|to)|(?:for|of))\s+(.+?)(?:\?|$)/i)
    || text.match(/(?:tickets?|issues?|tasks?)\s+(?:assigned\s+(?:to|for)|(?:pending|open|remaining)\s+(?:for|to)|(?:for|of))\s+(.+?)(?:\?|$)/i)
    || text.match(/(.+?)(?:'s|s')\s+(?:jira\s+)?(?:tickets?|issues?|tasks?)/i);

  if (jiraQueryMatch && config.jira.apiToken) {
    // Strip trailing filter phrases that aren't part of the person's name
    const personName = jiraQueryMatch[1]
      .replace(/[?!.]/g, '')
      .replace(/\s+(?:and\s+)?(?:(?:are|that\s+are|which\s+are|still)\s+)?(?:open|pending|remaining|closed|done|resolved|in\s*progress|unresolved|active|assigned|not\s+done)\s*$/i, '')
      .replace(/\s+(?:and|that|which)\s*$/i, '')
      .trim();
    if (personName.length < 2 || personName.length > 50) {
      await telegram.send('❌ Please provide a valid name.');
      return;
    }

    await telegram.send(`🔍 Searching tickets for "${personName}"...`);
    const { issues, total } = await jiraClient.getTicketsForPerson(personName);
    await telegram.send(JiraClient.formatTicketsForTelegram(issues, `Tickets for "${personName}"`, total));
    return;
  }

  // --- Report issue → Jira (from business teams or ops) ---
  // Matches: /report-issue <description> assign to <name>
  // Or natural language: "create a jira ticket: user can't login, assign to Abdul"
  // Or: "report this to jira and assign to Usama: BAS portal showing error"
  // Or: "log a bug: PDF export broken, assign Abdul Khaliq"
  const reportIssueCmd = cmd.startsWith('/report-issue') || cmd.startsWith('/reportissue') || cmd.startsWith('/log-issue') || cmd.startsWith('/logissue');
  const reportIssueLang = text.match(/(?:create|make|open|raise|log|report|file)\s+(?:a\s+)?(?:jira\s+)?(?:ticket|issue|bug|task)\s*(?:for|about|:)?\s*(.+)/i);

  if ((reportIssueCmd || reportIssueLang) && config.jira.apiToken) {
    let issueText = '';
    if (reportIssueCmd) {
      issueText = text.replace(/^\/(report-?issue|log-?issue)\s*/i, '').trim();
    } else if (reportIssueLang) {
      issueText = reportIssueLang[1].trim();
    }

    if (!issueText) {
      await telegram.send(
        '📝 <b>Report an issue to Jira</b>\n\n' +
        'Usage:\n' +
        '<code>/report-issue BAS portal login error for UOB users, assign to Abdul Khaliq</code>\n\n' +
        'Or natural language:\n' +
        '"create a jira ticket: PDF export broken, assign to Usama"\n' +
        '"log a bug: user can\'t register on BAS, assign Abdul"',
      );
      return;
    }

    // Parse assignee from the text: "assign to <name>" or "assign <name>"
    const assignMatch = issueText.match(/,?\s*assign(?:ed)?\s+(?:to\s+)?(.+?)$/i);
    let assigneeName: string | null = null;
    let description = issueText;

    if (assignMatch) {
      assigneeName = assignMatch[1].replace(/[.!?]+$/, '').trim();
      description = issueText.substring(0, assignMatch.index).replace(/,?\s*$/, '').trim();
    }

    // Parse priority hints
    let priority: string | undefined;
    if (/\b(urgent|critical|p1|blocker)\b/i.test(description)) priority = 'High';
    else if (/\b(important|p2)\b/i.test(description)) priority = 'Medium';

    // Determine issue type from keywords
    let issueType = 'Task';
    if (/\b(bug|broken|error|crash|fail|not working|can'?t)\b/i.test(description)) issueType = 'Bug';

    // Generate a clean summary (first sentence or first 80 chars)
    const summaryRaw = description.split(/[.!?\n]/)[0].trim();
    const summary = summaryRaw.length > 80 ? summaryRaw.substring(0, 77) + '...' : summaryRaw;

    // Look up assignee
    let assigneeId: string | undefined;
    let assigneeDisplay = '';
    if (assigneeName) {
      await telegram.send(`🔍 Looking up "${assigneeName}" in Jira...`);
      const user = await jiraClient.lookupUser(assigneeName);
      if (user) {
        assigneeId = user.accountId;
        assigneeDisplay = user.displayName;
      } else {
        await telegram.send(`⚠️ Could not find Jira user "${assigneeName}". Creating ticket as unassigned.`);
      }
    }

    await telegram.send('🎫 Creating Jira ticket...');
    const ticket = await jiraClient.createReportedIssue({
      summary,
      description,
      reportedBy: 'Telegram (via BLUE.Y)',
      assigneeAccountId: assigneeId,
      issueType,
      priority,
    });

    if (ticket) {
      let msg = `✅ Jira ticket created: <a href="${ticket.url}">${ticket.key}</a>\n\n`;
      msg += `📋 <b>${summary}</b>\n`;
      msg += `📌 Type: ${issueType}\n`;
      if (assigneeDisplay) msg += `👤 Assigned to: ${assigneeDisplay}\n`;
      if (priority) msg += `⚡ Priority: ${priority}\n`;
      await telegram.send(msg);
    } else {
      await telegram.send('❌ Failed to create Jira ticket. Check credentials.');
    }
    return;
  }

  // --- Create Jira ticket (from incident context) ---
  if (cmd === '/jira') {
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
      const keywords = extractKeywords(issueText);
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
    } else if (action === 'build') {
      // Trigger Bitbucket pipeline
      if (!bbClient) {
        await telegram.send('❌ Bitbucket not configured.');
        return;
      }

      const repo = target;    // repo name
      const branch = namespace; // branch stored in namespace field

      await telegram.send(
        `⚡ <b>TRIGGERING PIPELINE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>Repo:</b> ${repo}\n` +
        `🌿 <b>Branch:</b> <code>${branch}</code>\n` +
        `🏷️ <b>Label:</b> ${detail || ''}`,
      );

      try {
        const pipeline = await bbClient.triggerPipeline(repo, branch);
        await telegram.send(
          `✅ Pipeline triggered!\n\n` +
          `${BitbucketClient.formatPipeline(pipeline)}\n\n` +
          `🔗 <a href="${pipeline.url}">View in Bitbucket</a>\n\n` +
          `⏳ Monitoring build progress...`,
        );

        // Poll for build completion (every 30s, max 15 min)
        const maxPolls = 30;
        for (let i = 0; i < maxPolls; i++) {
          await new Promise((r) => setTimeout(r, 30000));
          try {
            const status = await bbClient.getPipelineStatus(repo, pipeline.uuid);
            if (status.state === 'COMPLETED') {
              const icon = status.result === 'SUCCESSFUL' ? '✅' : '❌';
              const mins = Math.floor(status.durationSeconds / 60);
              const secs = status.durationSeconds % 60;
              await telegram.send(
                `${icon} <b>Build #${status.buildNumber} ${status.result}</b>\n\n` +
                `📦 ${repo} / <code>${branch}</code>\n` +
                `⏱️ Duration: ${mins}m${secs.toString().padStart(2, '0')}s\n` +
                `🔗 <a href="${status.url}">View in Bitbucket</a>` +
                (status.result === 'SUCCESSFUL' ? '\n\n🚀 Deployment is live!' : '\n\n⚠️ Check build logs for errors.'),
              );
              break;
            }
            // Send progress update every 2 minutes
            if (i > 0 && i % 4 === 0) {
              const mins = Math.floor(status.durationSeconds / 60);
              await telegram.send(`⏳ Build #${status.buildNumber} still running... (${mins}m elapsed)`);
            }
          } catch {
            // Ignore polling errors, try again next cycle
          }
        }
      } catch (err) {
        await telegram.send(`❌ Failed to trigger pipeline: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    } else if (action === 'password_reset') {
      // Password reset approved — execute based on service type
      // SECURITY: All credentials and details go to DM ONLY. Channel gets minimal status only.
      const service = target;     // aws, office365, database, grafana
      const userName = namespace; // stored the user's name in namespace field
      const userChatId = detail;  // stored the DM chat ID in detail field
      const adminChatId = chatId; // the admin who approved (send private details here)

      const serviceLabels: Record<string, string> = {
        aws: 'AWS Console (IAM)',
        office365: 'Microsoft 365',
        database: 'Database (RDS)',
        grafana: 'Grafana',
      };

      // Channel only sees: approved + processing (no usernames, no credentials, no details)
      await telegram.send(`✅ Password reset approved. Processing via DM...`);

      // Generate a secure temporary password
      const genTempPassword = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        let pwd = 'BlueOnion-';
        for (let i = 0; i < 8; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
        pwd += '!' + Math.floor(Math.random() * 100);
        return pwd;
      };

      try {
        let resetInstructions = '';
        let adminInstructions = ''; // Private instructions sent to admin DM (not channel)

        if (service === 'aws') {
          const { IAMClient, ListUsersCommand, UpdateLoginProfileCommand } = await import('@aws-sdk/client-iam');
          const iam = new IAMClient({ region: 'ap-southeast-1' });
          const tempPassword = genTempPassword();

          try {
            const listRes = await iam.send(new ListUsersCommand({}));
            const users = listRes.Users || [];
            const nameParts = userName.toLowerCase().split(/\s+/);
            const iamUser = users.find((u) => {
              const un = (u.UserName || '').toLowerCase();
              return nameParts.some((p: string) => un.includes(p));
            });

            if (iamUser) {
              await iam.send(new UpdateLoginProfileCommand({
                UserName: iamUser.UserName,
                Password: tempPassword,
                PasswordResetRequired: true,
              }));

              resetInstructions = `Your AWS Console password has been reset.\n\n` +
                `🔑 Username: <code>${iamUser.UserName}</code>\n` +
                `🔑 Temporary password: <code>${tempPassword}</code>\n` +
                `🌐 Login: https://716156543026.signin.aws.amazon.com/console\n\n` +
                `⚠️ You MUST set a new password on first login.\n` +
                `🗑️ This message will be your only record — save your new password securely.`;

              // Channel: minimal confirmation only
              await telegram.send(`✅ AWS password reset done — credentials sent via DM.`);
            } else {
              resetInstructions = `⚠️ Could not find your IAM user automatically. Please tell the admin your IAM username.`;
              await telegram.send(`⚠️ AWS reset: user not found. Admin will handle manually.`);
            }
          } catch (awsErr) {
            resetInstructions = `⚠️ AWS password reset encountered an error. The admin has been notified and will help you directly.`;
            await telegram.send(`❌ AWS reset failed. Admin will handle manually.`);
            logger.error(`AWS IAM reset failed: ${awsErr instanceof Error ? awsErr.message : 'Unknown error'}`);
          }

        } else if (service === 'grafana') {
          if (!config.grafana.enabled) {
            resetInstructions = `Your Grafana password reset has been approved.\n\nThe admin will reset it manually and send you the new credentials.`;
            adminInstructions =
              `📋 <b>Action required:</b> Reset Grafana password for ${userName}\n\n` +
              `GRAFANA_ADMIN_PASSWORD not set — cannot auto-reset.\n` +
              `Go to: Grafana Admin → Users → ${userName} → Change password`;
            await telegram.send(`⚠️ Grafana auto-reset unavailable. Admin will handle manually.`);
          } else {
            try {
              const grafanaAuth = Buffer.from(`${config.grafana.adminUser}:${config.grafana.adminPassword}`).toString('base64');
              const grafanaUrl = config.grafana.internalUrl;

              const searchRes = await axios.get(`${grafanaUrl}/api/users/search?query=${encodeURIComponent(userName)}`, {
                headers: { Authorization: `Basic ${grafanaAuth}` },
                timeout: 10000,
              });

              const grafanaUsers = searchRes.data?.users || [];
              if (grafanaUsers.length > 0) {
                const grafanaUser = grafanaUsers[0];
                const tempPassword = genTempPassword();

                await axios.put(
                  `${grafanaUrl}/api/admin/users/${grafanaUser.id}/password`,
                  { password: tempPassword },
                  { headers: { Authorization: `Basic ${grafanaAuth}`, 'Content-Type': 'application/json' }, timeout: 10000 },
                );

                resetInstructions = `Your Grafana password has been reset.\n\n` +
                  `🔑 Username: <code>${grafanaUser.login}</code>\n` +
                  `🔑 Temporary password: <code>${tempPassword}</code>\n` +
                  `🌐 Login: https://grafana.blueonion.today\n\n` +
                  `⚠️ Please change your password after logging in (Profile → Change password).`;

                await telegram.send(`✅ Grafana password reset done — credentials sent via DM.`);
              } else {
                resetInstructions = `⚠️ Could not find your Grafana user. Please tell the admin your Grafana username.`;
                await telegram.send(`⚠️ Grafana reset: user not found. Admin will handle manually.`);
              }
            } catch (grafErr) {
              resetInstructions = `⚠️ Grafana password reset encountered an error. The admin has been notified.`;
              await telegram.send(`❌ Grafana reset failed. Admin will handle manually.`);
              logger.error(`Grafana API reset failed: ${grafErr instanceof Error ? grafErr.message : 'Unknown error'}`);
            }
          }

        } else if (service === 'office365') {
          resetInstructions = `Your Microsoft 365 password reset request has been approved.\n\n` +
            `The admin will reset it via the Microsoft 365 Admin Center and send you the new credentials.\n\n` +
            `⏳ Please wait — you'll receive a follow-up message shortly.`;
          adminInstructions =
            `📋 <b>Action required:</b> Reset Office 365 password for ${userName}\n\n` +
            `Go to: <a href="https://admin.microsoft.com/#/users">M365 Admin Center</a>\n` +
            `→ Active users → Find "${userName}" → Reset password\n\n` +
            `Then DM the new credentials to the user.`;
          await telegram.send(`📋 Office 365 reset requires manual action. Check your DM for instructions.`);

        } else if (service === 'database') {
          resetInstructions = `Your database password reset request has been approved.\n\n` +
            `The admin will generate new credentials and send them to you.\n\n` +
            `⏳ Please wait — you'll receive a follow-up message shortly.`;
          adminInstructions =
            `📋 <b>Action required:</b> Reset database password for ${userName}\n\n` +
            `Connect to the relevant RDS instance and run:\n` +
            `<code>ALTER USER 'username'@'%' IDENTIFIED BY 'NewPassword';</code>\n<code>FLUSH PRIVILEGES;</code>\n\n` +
            `Then DM the new credentials to the user.`;
          await telegram.send(`📋 Database reset requires manual action. Check your DM for instructions.`);
        }

        // Send credentials to the requesting user via DM ONLY
        if (userChatId && resetInstructions) {
          await telegram.send(
            `🔐 <b>Password Reset Update</b>\n\n${resetInstructions}`,
            userChatId,
          );
        }

        // Send manual instructions to admin via DM ONLY (not channel)
        if (adminInstructions) {
          // Send to the admin who approved (the person who typed /yes)
          // We use the admin channel chatId since we can't get the individual admin's DM
          // But log it so admin can check
          logger.info(`[PasswordReset] Admin instructions for ${service}/${userName}: manual reset needed`);
        }
      } catch (err) {
        await telegram.send(`❌ Password reset failed. Check logs for details.`);
        logger.error(`Password reset failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        if (userChatId) {
          await telegram.send(
            `❌ Sorry ${userName}, the password reset encountered an error. The admin has been notified and will help you directly.`,
            userChatId,
          );
        }
      }
    } else {
      await telegram.send(`⚠️ Unknown action: ${action}. Try running the command manually.`);
    }
    return;
  }

  if (cmd === '/no' || cmd === 'no' || cmd === 'n') {
    if (pendingAction) {
      const { teamsTicketId, jiraKey, action, target, namespace, dmChatId, dmUserName } = pendingAction;
      const declinedAction = pendingAction;
      pendingAction = null;

      // Password reset denied — notify the user via DM
      if (action === 'password_reset' && dmChatId) {
        await telegram.send(`👌 Password reset denied.`);
        await telegram.send(
          `❌ Sorry ${dmUserName}, your password reset request for <b>${target}</b> was not approved.\n\n` +
          `Please contact the admin directly for assistance.`,
          dmChatId,
        );
        return;
      }

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
        const keywords = extractKeywords(issueText);
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

  // --- Bitbucket CI/CD ---
  if (cmd === '/build' || cmd === '/pipelines' || cmd.startsWith('/build ') ||
      cmd.match(/^(deploy|build|trigger|run)\s+(backend|frontend|be|fe|um|pdf|bluey|bas)/i)) {

    if (!bbClient) {
      await telegram.send('⚠️ Bitbucket not configured. Set BB_USER and BB_TOKEN env vars.');
      return;
    }

    // /build or /pipelines — list available pipelines
    if (cmd === '/build' || cmd === '/pipelines') {
      await telegram.send(bbClient.formatPipelineList());
      return;
    }

    // Parse search term
    const search = cmd.replace(/^\/(build|pipelines)\s*/i, '').trim() ||
                   text.replace(/^(deploy|build|trigger|run)\s*/i, '').trim();

    const matches = bbClient.findPipeline(search);

    if (matches.length === 0) {
      await telegram.send(`❌ No pipeline found for: <code>${search}</code>\n\nUse /build to see available pipelines.`);
      return;
    }

    if (matches.length > 1) {
      let msg = `🔍 Multiple matches for "<b>${search}</b>":\n\n`;
      matches.forEach((m, i) => {
        const envIcon = m.env === 'prod' ? '🔴' : m.env === 'stg' ? '🟡' : '🟢';
        msg += `${i + 1}. ${envIcon} ${m.repo} / <code>${m.branch}</code> (${m.label})\n`;
      });
      msg += '\nBe more specific, e.g.: /build backend prod';
      await telegram.send(msg);
      return;
    }

    // Single match — confirm before triggering
    const m = matches[0];
    const envIcon = m.env === 'prod' ? '🔴 PRODUCTION' : m.env === 'stg' ? '🟡 STAGING' : '🟢 DEV';
    const warning = m.env === 'prod' ? '\n\n⚠️ <b>This deploys to PRODUCTION!</b>' : '';

    pendingAction = {
      action: 'build',
      target: m.repo,
      namespace: m.branch,  // reuse namespace field for branch
      detail: m.label,
      timestamp: Date.now(),
    };

    await telegram.send(
      `🔧 <b>Trigger Pipeline?</b>\n\n` +
      `📦 Repo: <b>${m.repo}</b>\n` +
      `🌿 Branch: <code>${m.branch}</code>\n` +
      `🏷️ Label: ${m.label}\n` +
      `🔹 Env: ${envIcon}${warning}\n\n` +
      `Reply /yes to trigger or /no to cancel.`,
    );
    return;
  }

  if (cmd === '/builds' || cmd.startsWith('/builds ') || cmd.match(/^(show|recent|last)\s+(builds|pipelines)/i)) {
    if (!bbClient) {
      await telegram.send('⚠️ Bitbucket not configured.');
      return;
    }

    const repoArg = cmd.replace(/^\/(builds)\s*/i, '').trim().toLowerCase();
    const repos = repoArg.includes('fe') || repoArg.includes('frontend')
      ? ['jcp-blo-frontend']
      : repoArg.includes('be') || repoArg.includes('backend')
        ? ['jcp-blo-backend']
        : ['jcp-blo-backend', 'jcp-blo-frontend'];

    await telegram.send('🔍 Fetching recent builds...');

    for (const repo of repos) {
      try {
        const pipelines = await bbClient.getRecentPipelines(repo, 8);
        const shortRepo = repo.replace('jcp-blo-', '');
        let msg = `📋 <b>${shortRepo}</b> — Recent Builds\n\n`;
        for (const p of pipelines) {
          msg += `${BitbucketClient.formatPipeline(p)}\n`;
        }
        await telegram.send(msg);
      } catch (err) {
        await telegram.send(`❌ Failed to fetch builds for ${repo}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
    return;
  }

  // --- Database query ---
  if (cmd === '/db' || cmd.startsWith('/db ') || cmd === '/databases' || cmd === '/tables' ||
      cmd.startsWith('/tables ') || cmd.startsWith('/query ') ||
      cmd.match(/^(find|search|lookup|check|show|does|is|how many|count|list|get)\b.*(user|member|email|isin|fund|company|registration|submission|esg|score|portfolio)/i) ||
      cmd.match(/^(who|which|what)\b.*(registered|signed up|exist|member|company|fund|top|highest|lowest)/i) ||
      cmd.match(/\b(exist|exists)\b.*(database|db|system|um|dwd)/i)) {

    if (!dbClient) {
      await telegram.send('⚠️ Database access not configured. Set DB_READONLY_PASSWORD env var.');
      return;
    }

    // /databases — list all accessible databases
    if (cmd === '/db' || cmd === '/databases') {
      await telegram.send(`🗄️ <b>Accessible Databases</b>\n\n${dbClient.getRegistrySummary()}\n\n💡 Usage:\n/db &lt;question&gt; — Ask in natural language\n/tables &lt;instance.database&gt; — List tables\n/query &lt;instance.database&gt; &lt;SQL&gt; — Run raw SQL`);
      return;
    }

    // /tables [instance.database] — list tables
    if (cmd === '/tables' || cmd.startsWith('/tables ')) {
      const target = cmd.replace('/tables', '').trim() || 'hubsprod.dwd';
      const resolved = dbClient.resolveTarget(target);
      if (!resolved) {
        await telegram.send(`❌ Unknown database: <code>${target}</code>\n\nUse /databases to see available databases.`);
        return;
      }
      await telegram.send(`🔍 Listing tables on <b>${resolved.dbInfo.name}.${resolved.database}</b>...`);
      const tables = await dbClient.listTables(resolved.dbInfo.name, resolved.database);
      if (tables.length === 0) {
        await telegram.send('No tables found (or access denied).');
        return;
      }
      const grouped = tables.reduce((acc, t) => {
        const prefix = t.includes('_') ? t.split('_')[0] : 'other';
        if (!acc[prefix]) acc[prefix] = [];
        acc[prefix].push(t);
        return acc;
      }, {} as Record<string, string[]>);

      let msg = `📋 <b>${resolved.dbInfo.name}.${resolved.database}</b> — ${tables.length} tables\n\n`;
      for (const [prefix, tbls] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
        msg += `<b>${prefix}_*</b> (${tbls.length}): ${tbls.slice(0, 8).join(', ')}${tbls.length > 8 ? '...' : ''}\n`;
      }
      if (msg.length > 3900) msg = msg.substring(0, 3900) + '\n...truncated';
      await telegram.send(msg);
      return;
    }

    // /query <instance.database> <SQL> — run raw SQL
    if (cmd.startsWith('/query ')) {
      const args = cmd.replace('/query ', '').trim();
      const spaceIdx = args.indexOf(' ');
      if (spaceIdx === -1) {
        await telegram.send('Usage: /query &lt;instance.database&gt; &lt;SQL&gt;\nExample: /query hubsprod.dwd SELECT * FROM bas_register_company LIMIT 5');
        return;
      }
      const target = args.substring(0, spaceIdx);
      const sql = args.substring(spaceIdx + 1).trim();
      const resolved = dbClient.resolveTarget(target);
      if (!resolved) {
        await telegram.send(`❌ Unknown database: <code>${target}</code>`);
        return;
      }
      await telegram.send(`🔍 Querying <b>${resolved.dbInfo.name}.${resolved.database}</b>...`);
      const result = await dbClient.query(resolved.dbInfo.name, resolved.database, sql);
      await telegram.send(dbClient.formatForTelegram(result));
      return;
    }

    // Natural language → 3-Agent Pipeline (Generator → Validator → Verifier)
    const question = cmd.replace(/^\/(db|query)\s*/i, '').trim() || text;

    if (!dbPipeline) {
      await telegram.send('⚠️ Database pipeline not available.');
      return;
    }

    await telegram.send('🧠 <b>3-Agent Pipeline</b> starting...\n🔵 Agent 1 (Generator) → 🟡 Agent 2 (Validator) → 🟢 Agent 3 (Verifier)');

    try {
      const result = await dbPipeline.run(question, async (step, detail) => {
        await telegram.send(`${step}: ${detail}`);
      });

      // Send formatted results
      const messages = dbPipeline.formatForTelegram(result);
      for (const msg of messages) {
        await telegram.send(msg);
      }
    } catch (err) {
      logger.error('DB 3-agent pipeline failed', err);
      await telegram.send(`❌ Pipeline failed: ${err instanceof Error ? err.message : 'Unknown error'}\n\n💡 Try /query for raw SQL instead.`);
    }
    return;
  }

  // --- AWS Monitoring: RDS ---
  if (cmd === '/rds' || cmd.match(/^(rds|database)\s*(health|status|metrics)?$/i)) {
    await telegram.send('🗄️ Fetching RDS metrics...');
    try {
      const metrics = await awsMonitor.getRdsMetrics();
      lastBotResponse = awsMonitor.formatRdsForTelegram(metrics);
      await telegram.send(lastBotResponse);
    } catch (err) {
      await telegram.send(`❌ Failed to fetch RDS metrics: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- AWS Monitoring: Glue + EMR ---
  if (cmd === '/jobs' || cmd === '/glue' || cmd === '/emr' || cmd.match(/^(glue|emr|etl)\s*(status|health)?$/i)) {
    await telegram.send('🔧 Fetching Glue & EMR status...');
    try {
      const [crawlers, emrStatus] = await Promise.all([
        awsMonitor.getGlueCrawlers(),
        awsMonitor.getEmrStatus(),
      ]);
      const glueMsg = awsMonitor.formatGlueForTelegram(crawlers);
      const emrMsg = awsMonitor.formatEmrForTelegram(emrStatus);
      lastBotResponse = `${glueMsg}\n\n${emrMsg}`;
      await telegram.send(glueMsg);
      await telegram.send(emrMsg);
    } catch (err) {
      await telegram.send(`❌ Failed to fetch job status: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- AWS Cost Monitor ---
  if (cmd === '/costs' || cmd.startsWith('/costs ') || cmd.match(/^(aws\s+)?(cost|spend|billing)/i)) {
    const daysMatch = cmd.match(/(\d+)/);
    const days = daysMatch ? Math.min(parseInt(daysMatch[1]), 30) : 7;
    await telegram.send(`💰 Fetching AWS costs (last ${days} days)...`);
    try {
      const costs = await awsMonitor.getCosts(days);
      lastBotResponse = awsMonitor.formatCostsForTelegram(costs);
      await telegram.send(lastBotResponse);
    } catch (err) {
      await telegram.send(`❌ Failed to fetch cost data: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- RDS Backup Verification ---
  if (cmd === '/backups' || cmd.match(/^(backup|rds\s*backup)\s*(status|check|verify)?$/i)) {
    await telegram.send('💾 Checking backup status...');
    try {
      const backups = await awsMonitor.getRdsBackupStatus();
      let msg = '💾 <b>RDS Backup Status</b>\n\n';
      for (const b of backups) {
        const age = b.lastBackup !== 'never'
          ? Math.round((Date.now() - new Date(b.lastBackup).getTime()) / (60 * 60 * 1000))
          : -1;
        const icon = age < 0 ? '🔴' : age > 24 ? '🟡' : '🟢';
        msg += `${icon} <b>${b.label}</b>\n`;
        msg += `  Last backup: ${age >= 0 ? `${age}h ago` : 'never'}\n`;
        msg += `  Window: ${b.backupWindow || 'not set'}\n`;
        msg += `  Retention: ${b.retentionDays} days\n\n`;
      }
      // Doris backup check (CronJob in doris namespace)
      try {
        const batchApi = kube.getBatchApi();
        const cronJobs = await batchApi.listNamespacedCronJob({ namespace: 'doris' });
        const dorisBackup = cronJobs.items.find((cj) => cj.metadata?.name?.includes('backup'));
        if (dorisBackup) {
          const lastSchedule = dorisBackup.status?.lastScheduleTime;
          const age = lastSchedule ? Math.round((Date.now() - new Date(lastSchedule).getTime()) / (60 * 60 * 1000)) : -1;
          const icon = age < 0 ? '🔴' : age > 48 ? '🟡' : '🟢';
          msg += `${icon} <b>Doris Backup (CronJob)</b>\n`;
          msg += `  Last run: ${age >= 0 ? `${age}h ago` : 'never'}\n`;
          msg += `  Schedule: ${dorisBackup.spec?.schedule || 'unknown'}\n`;
          msg += `  Active: ${dorisBackup.spec?.suspend ? 'SUSPENDED ⚠️' : 'Yes'}\n`;
        }
      } catch { /* Doris backup check optional */ }
      lastBotResponse = msg;
      await telegram.send(msg);
    } catch (err) {
      await telegram.send(`❌ Failed to check backups: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- K8s CronJob Audit ---
  if (cmd === '/cronjobs' || cmd === '/crons' || cmd.match(/^(cron\s*jobs?|scheduled)/i)) {
    await telegram.send('⏰ Auditing CronJobs...');
    try {
      const batchApi = kube.getBatchApi();
      let allCronJobs: Array<{ name: string; namespace: string; schedule: string; lastRun: string; active: number; suspended: boolean }> = [];
      for (const ns of [...config.kube.namespaces, 'doris']) {
        try {
          const res = await batchApi.listNamespacedCronJob({ namespace: ns });
          for (const cj of res.items) {
            allCronJobs.push({
              name: cj.metadata?.name || '',
              namespace: ns,
              schedule: cj.spec?.schedule || '',
              lastRun: cj.status?.lastScheduleTime ? new Date(cj.status.lastScheduleTime).toISOString() : 'never',
              active: cj.status?.active?.length || 0,
              suspended: cj.spec?.suspend || false,
            });
          }
        } catch { /* skip inaccessible namespace */ }
      }

      let msg = `⏰ <b>CronJob Audit (${allCronJobs.length} jobs)</b>\n\n`;
      for (const cj of allCronJobs) {
        const age = cj.lastRun !== 'never'
          ? Math.round((Date.now() - new Date(cj.lastRun).getTime()) / (60 * 60 * 1000))
          : -1;
        const icon = cj.suspended ? '⏸️' : cj.active > 0 ? '⏳' : age < 0 ? '🔴' : age > 48 ? '🟡' : '🟢';
        msg += `${icon} <b>${cj.name}</b> (${cj.namespace})\n`;
        msg += `  Schedule: <code>${cj.schedule}</code>\n`;
        msg += `  Last: ${age >= 0 ? `${age}h ago` : 'never'}`;
        if (cj.suspended) msg += ' | ⚠️ SUSPENDED';
        if (cj.active > 0) msg += ` | 🔄 ${cj.active} active`;
        msg += '\n\n';
      }
      lastBotResponse = msg;
      await telegram.send(msg);
    } catch (err) {
      await telegram.send(`❌ Failed to audit CronJobs: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- Backend Deep Health Check ---
  if (cmd === '/backend' || cmd.match(/^backend\s*(health|status|check|deep)?$/i)) {
    await telegram.send('🏥 Running backend deep health check...');
    try {
      const backendPod = await kube.findPod('blo-backend');
      if (!backendPod) {
        await telegram.send('❌ Backend pod not found.');
        return;
      }

      const endpoints = [
        { name: 'Nacos', port: 8848, path: '/nacos/v1/ns/service/list?pageNo=1&pageSize=10', expect: 200 },
        { name: 'System (7001)', port: 7001, path: '/actuator/health', expect: 200 },
        { name: 'BlueOnion (7002)', port: 7002, path: '/actuator/health', expect: 200 },
        { name: 'Gateway (9999)', port: 9999, path: '/actuator/health', expect: 200 },
      ];

      let msg = `🏥 <b>Backend Deep Health Check</b>\n📦 Pod: <code>${backendPod.pod.name}</code>\n\n`;

      // Check each JVM endpoint via kubectl exec curl
      for (const ep of endpoints) {
        try {
          const result = await kube.execInPod(
            backendPod.namespace, backendPod.pod.name,
            ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code},%{time_total}', `http://localhost:${ep.port}${ep.path}`],
            5000,
          );
          const [statusCode, responseTime] = result.trim().split(',');
          const ok = parseInt(statusCode) === ep.expect;
          msg += `${ok ? '✅' : '❌'} <b>${ep.name}</b> — HTTP ${statusCode} (${parseFloat(responseTime || '0').toFixed(2)}s)\n`;
        } catch {
          msg += `❌ <b>${ep.name}</b> — unreachable\n`;
        }
      }

      // Check Lucene index status
      msg += '\n<b>Components:</b>\n';
      try {
        const luceneResult = await kube.execInPod(
          backendPod.namespace, backendPod.pod.name,
          ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:7002/blueonion/lucene/createIndex01'],
          5000,
        );
        const luceneOk = parseInt(luceneResult.trim()) < 400;
        msg += `${luceneOk ? '✅' : '⚠️'} Lucene Index — ${luceneOk ? 'available' : 'needs rebuild'}\n`;
      } catch {
        msg += `⚠️ Lucene Index — cannot check\n`;
      }

      // Check memory via actuator (if available)
      try {
        const memResult = await kube.execInPod(
          backendPod.namespace, backendPod.pod.name,
          ['curl', '-s', 'http://localhost:7002/actuator/metrics/jvm.memory.used'],
          5000,
        );
        const memData = JSON.parse(memResult);
        const usedBytes = memData?.measurements?.[0]?.value || 0;
        const usedGB = (usedBytes / (1024 * 1024 * 1024)).toFixed(1);
        msg += `📊 JVM Memory (7002): ${usedGB} GB used\n`;
      } catch { /* optional */ }

      // Check Python processes
      try {
        const psResult = await kube.execInPod(
          backendPod.namespace, backendPod.pod.name,
          ['sh', '-c', 'ps aux | grep -c "[p]ython"'],
          5000,
        );
        const pyCount = parseInt(psResult.trim()) || 0;
        msg += `🐍 Python processes: ${pyCount}\n`;
      } catch { /* optional */ }

      lastBotResponse = msg;
      await telegram.send(msg);
    } catch (err) {
      await telegram.send(`❌ Backend health check failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- Deployment Diff (recent commits on a branch) ---
  if (cmd.startsWith('/diff') || cmd.match(/^(deploy\s*diff|what\s*changed|recent\s*commits)/i)) {
    if (!bbClient) {
      await telegram.send('❌ Bitbucket not configured. Set BB_USER and BB_TOKEN.');
      return;
    }
    const diffArgs = cmd.replace(/^\/(diff)\s*/i, '').trim();
    // Default to backend prod
    const search = diffArgs || 'backend prod';
    const matches = bbClient.findPipeline(search);
    if (matches.length === 0) {
      await telegram.send(`❓ No pipeline matching "${search}". Try: /diff backend prod, /diff frontend prod`);
      return;
    }
    const match = matches[0];
    await telegram.send(`📋 Fetching recent commits for <b>${match.label}</b>...`);
    try {
      const commits = await bbClient.getCommitsBetween(match.repo, match.branch, 10);
      if (commits.length === 0) {
        await telegram.send('No commits found.');
        return;
      }
      let msg = `📋 <b>Recent Commits: ${match.label}</b>\n`;
      msg += `📦 ${match.repo} / <code>${match.branch}</code>\n\n`;
      for (const c of commits) {
        const date = c.date ? new Date(c.date).toLocaleDateString('en-SG', { month: 'short', day: 'numeric' }) : '';
        msg += `<code>${c.hash}</code> ${c.message}\n  👤 ${c.author} — ${date}\n\n`;
      }
      lastBotResponse = msg;
      await telegram.send(msg);
    } catch (err) {
      await telegram.send(`❌ Failed to fetch commits: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  // --- Cheatsheet (full detailed reference) ---
  if (cmd === '/cheatsheet' || cmd === '/cheat' || cmd === '/commands') {
    // Split into multiple messages to avoid Telegram's 4096 char limit
    const sheets: string[] = [];

    sheets.push(
      `📖 <b>BLUE.Y CHEATSHEET — Full Command Reference</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

      `<b>🔍 MONITORING</b>\n` +
      `<code>/status</code> — Cluster health overview (pods, nodes, namespaces)\n` +
      `<code>/check</code> — Run all monitors now (pods, nodes, certs, HPA)\n` +
      `<code>/nodes</code> — Node CPU/memory/disk usage\n` +
      `<code>/resources [ns]</code> — Pod CPU/memory usage vs requests\n` +
      `  └ <code>/resources prod</code> — Prod namespace only\n` +
      `  └ <code>/resources doris</code> — Doris namespace\n` +
      `<code>/hpa [ns]</code> — HPA autoscaler status\n` +
      `  └ <code>/hpa prod</code> — Prod HPAs\n` +
      `<code>/doris</code> — Doris FE/BE health, memory, tablet count\n` +
      `<code>/efficiency</code> — Resource efficiency analysis\n`,
    );

    sheets.push(
      `<b>📦 PODS & DEPLOYMENTS</b>\n` +
      `<code>/logs &lt;pod&gt;</code> — Tail last 50 lines of pod logs\n` +
      `  └ <code>/logs blo-backend</code>\n` +
      `<code>/logsearch &lt;pod&gt; &lt;pattern&gt;</code> — Search logs with grep\n` +
      `  └ <code>/logsearch blo-backend OutOfMemory</code>\n` +
      `<code>/describe &lt;pod&gt;</code> — Pod details (status, events, containers)\n` +
      `<code>/events [ns] [pod]</code> — Recent K8s events\n` +
      `  └ <code>/events prod</code> — All prod events\n` +
      `  └ <code>/events doris doris-be-0</code> — Specific pod\n` +
      `<code>/deployments [ns]</code> — List all deployments with replicas\n` +
      `  └ Aliases: <code>/deps</code>\n` +
      `<code>/rollout &lt;deployment&gt;</code> — Check rollout status\n` +
      `  └ <code>/rollout blo-backend</code>\n` +
      `<code>/diagnose &lt;pod&gt;</code> — Full AI diagnostic (describe + logs + events + Loki + AI analysis)\n` +
      `  └ <code>/diagnose blo-backend</code>\n\n` +

      `<b>⚡ ACTIONS (require /yes confirmation)</b>\n` +
      `<code>/restart &lt;deployment&gt;</code> — Rolling restart\n` +
      `  └ <code>/restart blo-backend</code>\n` +
      `  └ <code>/restart doris/doris-be</code> — With namespace\n` +
      `<code>/scale &lt;deployment&gt; &lt;N&gt;</code> — Scale replicas\n` +
      `  └ <code>/scale blo-frontend 3</code>\n` +
      `<code>/yes</code> — Confirm pending action\n` +
      `<code>/no</code> — Cancel pending action\n`,
    );

    sheets.push(
      `<b>🛡️ QA & SECURITY</b>\n` +
      `<code>/smoketest</code> — Test all 9 production URLs (HTTP status check)\n` +
      `  └ Aliases: <code>/smoke</code>\n` +
      `<code>/securityscan</code> — OWASP security header scan on all URLs\n` +
      `  └ Aliases: <code>/security</code>\n` +
      `<code>/restarts</code> — Pod restart root cause analysis with AI\n` +
      `<code>/dorisbackup</code> — Doris backup CronJob health check\n` +
      `<code>/loki [ns]</code> — Loki log error analysis (last 1 hour)\n` +
      `  └ <code>/loki prod</code> — Prod errors only\n` +
      `  └ <code>/loki doris</code> — Doris errors\n\n` +

      `<b>📧 REPORTS & EMAIL</b>\n` +
      `<code>/report</code> — Generate daily health report\n` +
      `<code>/email &lt;name|team&gt;</code> — Email report via SES\n` +
      `  └ <code>/email zeeshan</code>\n` +
      `  └ <code>/email abdul</code>\n` +
      `  └ <code>/email usama</code>\n` +
      `  └ <code>/email wei</code>\n` +
      `  └ <code>/email elsa</code>\n` +
      `  └ <code>/email team</code> — All team members\n` +
      `<code>/incidents</code> — Show incident timeline\n`,
    );

    sheets.push(
      `<b>🎫 JIRA INTEGRATION</b>\n` +
      `<code>/jira</code> — Create Jira ticket from last incident/diagnosis\n` +
      `<code>/report-issue &lt;desc&gt;, assign to &lt;name&gt;</code> — Report issue to Jira\n` +
      `  └ <code>/report-issue BAS login broken for UOB, assign to Abdul Khaliq</code>\n` +
      `  └ <code>/report-issue PDF export failing, assign to Usama</code>\n` +
      `  └ <code>/report-issue update SSL certs</code> (no assignee)\n` +
      `<code>/tickets</code> — Project summary (open by status & assignee)\n` +
      `<code>/tickets &lt;name&gt;</code> — Tickets assigned to a person\n` +
      `  └ <code>/tickets Abdul Khaliq</code>\n` +
      `  └ <code>/tickets Usama</code>\n\n` +

      `<b>Natural language (Jira):</b>\n` +
      `  "how many tickets assigned to Abdul Khaliq?"\n` +
      `  "pending tickets for Usama"\n` +
      `  "Zeeshan's jira tickets"\n` +
      `  "create a jira ticket: BAS error, assign to Abdul"\n` +
      `  "log a bug: PDF broken, assign Usama"\n`,
    );

    sheets.push(
      `<b>🗄️ DATABASE (3-Agent AI Pipeline)</b>\n` +
      `<code>/databases</code> — List all accessible databases\n` +
      `<code>/db &lt;question&gt;</code> — Ask in natural language (AI generates SQL)\n` +
      `  └ <code>/db how many active users in UM?</code>\n` +
      `  └ <code>/db find user ng.peixiu@uobgroup.com</code>\n` +
      `  └ <code>/db top 10 ESG companies from doris</code>\n` +
      `  └ <code>/db BAS registrations for UOB this year</code>\n` +
      `<code>/tables &lt;instance.database&gt;</code> — List tables\n` +
      `  └ <code>/tables hubsprod.dwd</code>\n` +
      `  └ <code>/tables bo-prod-sg.blo_user</code>\n` +
      `  └ <code>/tables doris.dwd</code>\n` +
      `<code>/query &lt;instance.database&gt; &lt;SQL&gt;</code> — Run raw SELECT\n` +
      `  └ <code>/query hubsprod.dwd SELECT * FROM bas_register_company LIMIT 5</code>\n\n` +

      `<b>Pipeline:</b> Agent 1 (Generator) → Agent 2 (Validator) → Agent 3 (Verifier)\n` +
      `<b>Databases:</b> hubsprod, bo-prod-sg, faceset-prod, data-transfer, blueonion, doris\n` +
      `<b>Safety:</b> SELECT only, 50 row limit, read-only user, no data sent to AI\n`,
    );

    sheets.push(
      `<b>🔧 CI/CD (Bitbucket Pipelines)</b>\n` +
      `<code>/pipelines</code> — List all available pipelines\n` +
      `<code>/build &lt;search&gt;</code> — Trigger a pipeline (requires /yes)\n` +
      `  └ <code>/build backend prod</code> — Production backend ★\n` +
      `  └ <code>/build frontend prod</code> — Production frontend\n` +
      `  └ <code>/build be stg</code> — Staging backend\n` +
      `  └ <code>/build fe dev</code> — Dev frontend\n` +
      `  └ <code>/build um-be prod</code> — User Management BE\n` +
      `  └ <code>/build pdf prod</code> — PDF Service\n` +
      `  └ <code>/build bluey prod</code> — BLUE.Y itself\n` +
      `<code>/builds [be|fe]</code> — Recent build history\n` +
      `  └ <code>/builds be</code> — Backend builds\n` +
      `  └ <code>/builds fe</code> — Frontend builds\n\n` +

      `<b>☁️ AWS MONITORING</b>\n` +
      `<code>/rds</code> — RDS database health (CPU, storage, connections, IOPS)\n` +
      `<code>/jobs</code> — Glue crawler status + EMR cluster health\n` +
      `  └ Aliases: <code>/glue</code>, <code>/emr</code>\n` +
      `<code>/costs [days]</code> — AWS cost breakdown by service\n` +
      `  └ <code>/costs</code> — Last 7 days (default)\n` +
      `  └ <code>/costs 30</code> — Last 30 days\n` +
      `<code>/backups</code> — RDS + Doris backup verification\n` +
      `<code>/backend</code> — Deep health check (4 JVMs, Lucene, memory, Python)\n` +
      `<code>/cronjobs</code> — K8s CronJob audit across all namespaces\n` +
      `  └ Aliases: <code>/crons</code>\n` +
      `<code>/diff [search]</code> — Recent commits on a branch\n` +
      `  └ <code>/diff backend prod</code> — Backend production commits\n` +
      `  └ <code>/diff frontend prod</code> — Frontend production commits\n\n` +

      `<b>⚙️ SYSTEM</b>\n` +
      `<code>/sleep</code> — Pause all monitoring\n` +
      `<code>/wake</code> — Resume monitoring\n` +
      `<code>/help</code> — Quick command reference\n` +
      `<code>/cheatsheet</code> — This full reference\n\n` +

      `<b>🔐 PASSWORD RESET (via DM only)</b>\n` +
      `DM BLUE.Y directly (not in channel) to request:\n` +
      `  "Reset my password for AWS"\n` +
      `  "I forgot my Office 365 password"\n` +
      `  "I can't login to Grafana"\n` +
      `  "Need new database credentials"\n\n` +
      `<b>Supported:</b> AWS Console, Microsoft 365, Database (RDS), Grafana\n` +
      `<b>Flow:</b> User DMs BLUE.Y → Admin gets approval request → /yes or /no\n` +
      `<b>AWS:</b> Auto-resets IAM password and sends temp creds via DM\n` +
      `<b>Others:</b> Admin notified with reset instructions\n\n` +

      `<b>🤖 SMART FEATURES</b>\n` +
      `• Ask anything in plain English — AI understands context\n` +
      `• Auto-diagnose: unhealthy pods investigated automatically\n` +
      `• 📸 Teams: attach screenshots for AI vision analysis\n` +
      `• Actions always need <code>/yes</code> confirmation\n` +
      `• Production builds show extra ⚠️ warning\n` +
      `• Daily report at 9 AM SGT (auto)\n` +
      `• Monitors: pods (2min), nodes (5min), certs (6hr), HPA (5min)\n`,
    );

    for (const sheet of sheets) {
      await telegram.send(sheet);
    }
    return;
  }

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
      `<b>Reports & Jira:</b>\n` +
      `/report — Daily health report\n` +
      `/email &lt;name|team&gt; — Email report\n` +
      `/jira — Create Jira ticket from incident\n` +
      `/report-issue &lt;desc&gt;, assign to &lt;name&gt; — Report issue to Jira\n` +
      `/tickets [name] — Jira ticket summary or person lookup\n` +
      `/incidents — Incident timeline\n\n` +
      `<b>Database:</b>\n` +
      `/db &lt;question&gt; — Ask about data in natural language\n` +
      `/databases — List all accessible databases\n` +
      `/tables &lt;db&gt; — List tables (e.g. /tables hubsprod.dwd)\n` +
      `/query &lt;db&gt; &lt;SQL&gt; — Run raw SELECT query\n\n` +
      `<b>CI/CD:</b>\n` +
      `/build &lt;search&gt; — Trigger pipeline (e.g. /build backend prod)\n` +
      `/builds [be|fe] — Recent build history\n` +
      `/pipelines — List all available pipelines\n\n` +
      `<b>AWS Monitoring:</b>\n` +
      `/rds — RDS database health (CPU, storage, connections)\n` +
      `/jobs — Glue crawlers + EMR cluster status\n` +
      `/costs [days] — AWS cost breakdown\n` +
      `/backups — RDS + Doris backup status\n` +
      `/backend — Deep backend health (4 JVMs, Lucene, memory)\n` +
      `/cronjobs — K8s CronJob audit\n` +
      `/diff [search] — Recent commits on a branch\n\n` +
      `<b>System:</b>\n` +
      `/sleep — Pause monitoring\n` +
      `/wake — Resume monitoring\n\n` +
      `💡 Type <code>/cheatsheet</code> for full detailed reference with examples.\n` +
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
        { command: 'rds', description: 'RDS database health' },
        { command: 'jobs', description: 'Glue + EMR status' },
        { command: 'costs', description: 'AWS cost breakdown' },
        { command: 'backups', description: 'Backup verification' },
        { command: 'backend', description: 'Deep backend health check' },
        { command: 'cronjobs', description: 'K8s CronJob audit' },
        { command: 'report', description: 'Daily health report' },
        { command: 'incidents', description: 'Incident timeline' },
        { command: 'help', description: 'Show all commands' },
        { command: 'sleep', description: 'Pause monitoring' },
        { command: 'wake', description: 'Resume monitoring' },
      ],
    });
    logger.info('Telegram bot commands menu registered');
  } catch { /* ignore */ }

  // Register DM-specific commands (private chats only)
  try {
    await axios.post(`${API}/setMyCommands`, {
      commands: [
        { command: 'help', description: 'What I can do in DMs' },
        { command: 'cheatsheet', description: 'View all commands' },
      ],
      scope: { type: 'all_private_chats' },
    });
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
        const userName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown';
        logger.info(`[Telegram] ${userName} (${chatId}): ${msg.text}`);

        try {
          if (chatId === config.telegram.chatId) {
            // Group channel message — full command set
            await handleTelegramCommand(msg.text, chatId);
          } else if (msg.chat.type === 'private') {
            // Direct message — password reset flow
            await handleTelegramDM(msg.text, chatId, userName);
          } else {
            logger.warn(`Telegram message from unauthorized chat: ${chatId}`);
          }
        } catch (err) {
          logger.error('Error handling Telegram command', err);
          if (chatId === config.telegram.chatId) {
            await telegram.send(`❌ Error: ${(err as Error).message}`);
          } else {
            await telegram.send(`❌ Something went wrong. Please try again later.`, chatId);
          }
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

    // NOTE: Jira tickets are NOT auto-created here. They are only created when:
    // 1. Ops explicitly runs /jira
    // 2. Ops declines an action (/no) — auto-creates ticket for tracking

    // Record BLUE.Y's diagnosis in conversation history
    teamsClient.addToHistory(userName, 'assistant', `Diagnosis: ${analysis.analysis}${analysis.suggestedAction ? ` | Suggested: ${analysis.suggestedAction}` : ''}`, id, ticket.status);

    // Check if AI suggests an action that needs ops approval
    if (analysis.requiresAction && analysis.suggestedCommand) {
      ticket.suggestedAction = analysis.suggestedAction || analysis.suggestedCommand;
      const diagCard = TeamsCards.diagnosis(analysis.analysis, 'awaiting_approval', id, {
        screenshotAnalysis: ticket.imageAnalysis || undefined,
        suggestedAction: analysis.suggestedAction || analysis.suggestedCommand,
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
        `\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚡ Reply /yes to approve or /no to decline\n` +
        `🆔 <code>${id}</code>`,
      );

      // Parse the suggested action for pending approval
      const actionParts = (analysis.suggestedCommand || '').split(' ');
      const actionName = actionParts[0]?.toLowerCase();
      if (actionName === 'restart' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'restart', target: dep, namespace: ns, timestamp: Date.now(), teamsTicketId: id };
      } else if (actionName === 'scale' && actionParts[1]) {
        const [ns, dep] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        const replicas = actionParts[2] || '2';
        pendingAction = { action: 'scale', target: dep, namespace: ns, detail: replicas, timestamp: Date.now(), teamsTicketId: id };
      } else if (actionName === 'diagnose' && actionParts[1]) {
        const [ns, pod] = actionParts[1].includes('/') ? actionParts[1].split('/') : ['prod', actionParts[1]];
        pendingAction = { action: 'diagnose', target: pod, namespace: ns, timestamp: Date.now(), teamsTicketId: id };
      } else {
        pendingAction = { action: actionName || 'unknown', target: actionParts[1] || '', namespace: 'prod', timestamp: Date.now(), teamsTicketId: id };
      }
    } else {
      // No action needed — just inform the user and ops
      const resolvedCard = TeamsCards.diagnosis(analysis.analysis, 'resolved', id, {
        screenshotAnalysis: ticket.imageAnalysis || undefined,
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
        `✅ No action required — auto-resolved`,
      );
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
