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
import { TeamsClient, TeamsTicket } from './clients/teams';

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

// Initialize monitors
const monitors = [
  new PodMonitor(kube, bedrock),
  new NodeMonitor(kube, bedrock),
  new CertMonitor(kube, bedrock),
  new HPAMonitor(kube),
];

// Initialize scheduler (pass kube for auto-diagnose)
const scheduler = new MonitorScheduler(monitors, telegram, bedrock, kube);

// Pending action confirmation (teamsTicketId links back to Teams user for cross-channel flow)
let pendingAction: { action: string; target: string; namespace: string; detail?: string; timestamp: number; teamsTicketId?: string; jiraKey?: string } | null = null;

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
      await telegram.send(`🔄 Restarting <code>${target}</code>...`);
      const ok = await kube.restartDeployment(namespace, target);
      await telegram.send(ok
        ? `✅ Restarted <code>${target}</code> in <b>${namespace}</b>. Rolling update in progress.`
        : `❌ Failed to restart <code>${target}</code>.`);
      if (teamsTicketId) {
        await teamsClient.updateTicket(teamsTicketId, 'resolved',
          ok ? `Great news! The ops team has approved and executed a restart of **${target}**. The fix is rolling out now. Please allow a few minutes and try again.`
            : `The ops team attempted to fix the issue but the restart failed. They're investigating further.`);
      }
      if (jiraKey) {
        await jiraClient.addComment(jiraKey,
          ok ? `[BLUE.Y] Action approved by ops: restart ${namespace}/${target} — SUCCESS. Rolling update in progress.`
            : `[BLUE.Y] Action approved by ops: restart ${namespace}/${target} — FAILED. Manual investigation needed.`);
      }
    } else if (action === 'scale') {
      const replicas = parseInt(detail || '1');
      await telegram.send(`📐 Scaling <code>${target}</code> to ${replicas}...`);
      const ok = await kube.scaleDeployment(namespace, target, replicas);
      await telegram.send(ok
        ? `✅ Scaled <code>${target}</code> to ${replicas} replicas.`
        : `❌ Failed to scale <code>${target}</code>.`);
      if (teamsTicketId) {
        await teamsClient.updateTicket(teamsTicketId, 'resolved',
          ok ? `Great news! The ops team has scaled up **${target}** to ${replicas} replicas to handle the load. Things should improve shortly.`
            : `The ops team attempted to scale the service but it failed. They're investigating further.`);
      }
      if (jiraKey) {
        await jiraClient.addComment(jiraKey,
          ok ? `[BLUE.Y] Action approved by ops: scale ${namespace}/${target} to ${replicas} — SUCCESS.`
            : `[BLUE.Y] Action approved by ops: scale ${namespace}/${target} to ${replicas} — FAILED. Manual investigation needed.`);
      }
    } else if (action === 'diagnose') {
      // Run full diagnostic on the target pod
      await telegram.send(`🔬 Running full diagnostic on <code>${target}</code>...`);
      const found = await kube.findPod(target);
      if (found) {
        const [desc, logs, events] = await Promise.all([
          kube.describePod(found.namespace, found.pod.name),
          kube.getPodLogs(found.namespace, found.pod.name, 50),
          kube.getEvents(found.namespace, found.pod.name),
        ]);
        await telegram.send(`🔎 <b>Pod Details:</b>\n${desc}`);
        if (logs && logs.length > 10) {
          await telegram.send(`📋 <b>Recent Logs:</b>\n<pre>${logs.substring(0, 3000)}</pre>`);
        }
        if (events && events !== 'No recent events found.') {
          await telegram.send(`📢 <b>Events:</b>\n${events}`);
        }
        // AI analysis
        const analysis = await bedrock.analyze({
          type: 'incident',
          message: `Diagnose pod ${found.pod.name} in namespace ${found.namespace}`,
          context: { pod: found.pod, description: desc, recentLogs: logs.substring(0, 2000), events },
        });
        await telegram.send(`🧠 <b>AI Analysis:</b>\n\n${analysis.analysis}`);
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'resolved',
            `The ops team ran a full diagnostic. Here's the summary:\n\n${analysis.analysis}`);
        }
        if (jiraKey) {
          await jiraClient.addComment(jiraKey, `[BLUE.Y] Diagnostic completed for ${found.namespace}/${found.pod.name}.\n\n${analysis.analysis}`);
        }
      } else {
        await telegram.send(`❓ Pod matching "${target}" not found. Try /diagnose manually.`);
        if (teamsTicketId) {
          await teamsClient.updateTicket(teamsTicketId, 'escalated',
            'The ops team is investigating your issue manually. They\'ll follow up with you directly.');
        }
      }
    } else {
      await telegram.send(`⚠️ Unknown action: ${action}. Try running the command manually.`);
    }
    return;
  }

  if (cmd === '/no' || cmd === 'no' || cmd === 'n') {
    if (pendingAction) {
      const { teamsTicketId, jiraKey } = pendingAction;
      pendingAction = null;
      await telegram.send('👌 Action cancelled.');
      // Notify Teams user if this was from a Teams report
      if (teamsTicketId) {
        await teamsClient.updateTicket(teamsTicketId, 'escalated',
          'The ops team has reviewed your issue and is handling it manually. ' +
          'They\'ll follow up with you directly if needed. Thank you for reporting!');
      }
      // Update Jira
      if (jiraKey) {
        await jiraClient.addComment(jiraKey,
          '[BLUE.Y] Suggested action declined by ops. Issue escalated for manual handling.');
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
      `<b>Reports:</b>\n` +
      `/email &lt;name|team&gt; — Email report (zeeshan, abdul, usama, wei, elsa, team)\n` +
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
        { command: 'hpa', description: 'HPA autoscaler status' },
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
    // Convert HTML to plain text for Teams
    const plainSummary = summary.replace(/<b>/g, '**').replace(/<\/b>/g, '**').replace(/<[^>]+>/g, '');
    await teamsClient.updateTicket(id, 'resolved', plainSummary);
    return;
  }

  // Diagnose the reported issue using AI
  await teamsClient.updateTicket(id, 'diagnosing');

  try {
    // Gather cluster context
    const clusterSummary = await kube.getClusterSummary();
    const unhealthy = await kube.getUnhealthyPods();

    // Ask AI to analyze the user's report against cluster state
    const analysis = await bedrock.analyze({
      type: 'user_report',
      message: `A user reported via Teams: "${userMessage}". Diagnose this issue.
        If you can identify a specific pod or service that's affected, say so.
        If an action (restart, scale) would fix it, suggest it clearly.
        Keep your response concise and user-friendly.`,
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
        // Create new ticket
        const jiraTicket = await jiraClient.createIncidentTicket({
          summary: `[Teams] ${userName}: ${userMessage.substring(0, 80)}`,
          description: `Reported by: ${userName} (via Microsoft Teams)\n\nOriginal message: "${userMessage}"`,
          analysis: analysis.analysis,
          severity: analysis.requiresAction ? 'critical' : undefined,
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

    // Check if AI suggests an action that needs ops approval
    if (analysis.requiresAction && analysis.suggestedCommand) {
      ticket.suggestedAction = analysis.suggestedAction || analysis.suggestedCommand;
      await teamsClient.updateTicket(id, 'awaiting_approval',
        `**Diagnosis:** ${analysis.analysis}\n\n` +
        `I've identified a potential fix and sent it to the ops team for approval. ` +
        `I'll update you once they respond.${jiraInfo}`,
      );

      // Alert ops on Telegram for approval
      await telegram.send(
        `📩 <b>Teams Report from ${safeTg(userName)}</b>\n\n` +
        `<b>Issue:</b> ${safeTg(userMessage)}\n\n` +
        `<b>Diagnosis:</b> ${safeTg(analysis.analysis)}\n\n` +
        `<b>Suggested:</b> ${safeTg(analysis.suggestedAction || 'none')}\n\n` +
        `Reply /yes to execute or /no to decline.${jiraTgInfo}\n` +
        `<i>Ticket: ${id}</i>`,
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
      await teamsClient.updateTicket(id, 'resolved',
        `**Diagnosis:** ${analysis.analysis}\n\n` +
        `No immediate action required. If the issue persists, I'll escalate to the ops team.${jiraInfo}`,
      );

      // Notify ops on Telegram (FYI, no action needed)
      await telegram.send(
        `📩 <b>Teams Report from ${safeTg(userName)}</b> (resolved)\n\n` +
        `<b>Issue:</b> ${safeTg(userMessage)}\n` +
        `<b>Diagnosis:</b> ${safeTg(analysis.analysis.substring(0, 300))}${jiraTgInfo}`,
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
      `📩 <b>Teams Report from ${safeTg(userName)}</b> (escalated)\n\n` +
      `<b>Issue:</b> ${safeTg(userMessage)}\n` +
      `⚠️ Auto-diagnosis failed. Please investigate manually.`,
    );
  }
});

// Start
app.listen(config.port, () => {
  logger.info(`BLUE.Y started on port ${config.port}`);
  scheduler.start();

  // Start Telegram polling if bot token is configured
  if (config.telegram.botToken) {
    startPolling().catch((err) => logger.error('Polling fatal error', err));
  }
});
