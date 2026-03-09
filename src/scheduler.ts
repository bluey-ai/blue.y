import { CronJob } from 'cron';
import { Monitor, MonitorResult } from './monitors/base';
import { TelegramClient } from './clients/telegram';
import { BedrockClient } from './clients/bedrock';
import { KubeClient } from './clients/kube';
import { LokiClient } from './clients/loki';
import { config } from './config';
import { logger } from './utils/logger';

interface AuditEntry {
  timestamp: Date;
  action: string;
  monitor: string;
  details: string;
}

export interface IncidentContext {
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
}

export class MonitorScheduler {
  private jobs: CronJob[] = [];
  private paused = false;
  private auditLog: AuditEntry[] = [];
  private actionsThisHour = 0;
  private lastHourReset = Date.now();
  private lastResults: Map<string, MonitorResult> = new Map();
  // Track already-alerted pods to avoid spamming (resource -> timestamp)
  private alertedPods: Map<string, number> = new Map();
  private static ALERT_COOLDOWN = 15 * 60 * 1000; // 15 min cooldown per pod
  // Incident timeline
  private incidentLog: IncidentContext[] = [];
  // Callback to set lastIncident in main.ts
  public onIncident?: (incident: IncidentContext) => void;

  constructor(
    private monitors: Monitor[],
    private telegram: TelegramClient,
    private bedrock: BedrockClient,
    private kube?: KubeClient,
    private loki?: LokiClient,
  ) {}

  start(): void {
    const schedules: Record<string, string> = config.schedules as Record<string, string>;

    for (const monitor of this.monitors) {
      const schedule = schedules[monitor.name] || '*/5 * * * *';

      const job = CronJob.from({
        cronTime: schedule,
        onTick: async (): Promise<void> => { await this.runCheck(monitor); },
        start: true,
        timeZone: 'Asia/Singapore',
      });

      this.jobs.push(job);
      logger.info(`Scheduled ${monitor.name} monitor: ${schedule}`);
    }

    logger.info(`BLUE.Y monitoring started — ${this.monitors.length} monitors active`);
    this.audit('system', 'startup', `Started ${this.monitors.length} monitors`);
  }

  pause(): void {
    this.paused = true;
    this.jobs.forEach((j) => j.stop());
    logger.info('BLUE.Y paused (kill switch)');
    this.audit('system', 'pause', 'Kill switch activated');
  }

  resume(): void {
    this.paused = false;
    this.jobs.forEach((j) => j.start());
    logger.info('BLUE.Y resumed');
    this.audit('system', 'resume', 'Monitoring resumed');
  }

  async runAllChecks(): Promise<MonitorResult[]> {
    const results: MonitorResult[] = [];
    for (const monitor of this.monitors) {
      const result = await this.runCheck(monitor);
      if (result) results.push(result);
    }
    return results;
  }

  async getStatus(): Promise<string> {
    const lines = [
      `🤖 BLUE.Y Status`,
      `State: ${this.paused ? '😴 Paused' : '👁️ Active'}`,
      `Monitors: ${this.monitors.length}`,
      `Actions this hour: ${this.actionsThisHour}/${config.safety.maxActionsPerHour}`,
      '',
    ];

    for (const [name, result] of this.lastResults) {
      const icon = result.healthy ? '✅' : '❌';
      lines.push(`${icon} ${name}: ${result.issues.length} issues (${result.checkedAt.toISOString()})`);
    }

    return lines.join('\n');
  }

  getAuditLog(): AuditEntry[] {
    return this.auditLog.slice(-100);
  }

  private async runCheck(monitor: Monitor): Promise<MonitorResult | null> {
    if (this.paused) return null;

    // Clean up expired cooldowns
    const now = Date.now();
    for (const [key, ts] of this.alertedPods) {
      if (now - ts > MonitorScheduler.ALERT_COOLDOWN) this.alertedPods.delete(key);
    }

    try {
      const result = await monitor.check();
      this.lastResults.set(monitor.name, result);

      if (!result.healthy) {
        const criticals = result.issues.filter((i) => i.severity === 'critical');
        const warnings = result.issues.filter((i) => i.severity === 'warning');

        // Auto-diagnose critical pod issues
        if (criticals.length > 0 && monitor.name === 'pods' && this.kube) {
          for (const issue of criticals) {
            // Skip if already alerted recently
            if (this.alertedPods.has(issue.resource)) continue;
            this.alertedPods.set(issue.resource, now);

            await this.autoDiagnose(issue.resource, monitor.name);
          }
        } else if (criticals.length > 0) {
          // Non-pod criticals — send simple alert
          const newCriticals = criticals.filter((i) => !this.alertedPods.has(i.resource));
          if (newCriticals.length > 0) {
            const message = newCriticals.map((i) => `• ${i.resource}: ${i.message}`).join('\n');
            await this.telegram.sendAlert('critical', `${monitor.name} monitor:\n${message}`);
            newCriticals.forEach((i) => this.alertedPods.set(i.resource, now));
          }
          this.audit('alert', monitor.name, `${criticals.length} critical issues`);
        } else if (warnings.length > 0) {
          const newWarnings = warnings.filter((i) => !this.alertedPods.has(i.resource));
          if (newWarnings.length > 0) {
            const message = newWarnings.map((i) => `• ${i.resource}: ${i.message}`).join('\n');
            await this.telegram.sendAlert('warning', `${monitor.name} monitor:\n${message}`);
            newWarnings.forEach((i) => this.alertedPods.set(i.resource, now));
          }
          this.audit('alert', monitor.name, `${warnings.length} warnings`);
        }
      }

      return result;
    } catch (err) {
      logger.error(`Monitor ${monitor.name} failed`, err);
      this.audit('error', monitor.name, `Check failed: ${err}`);
      return null;
    }
  }

  private async autoDiagnose(resource: string, monitorName: string): Promise<void> {
    const [namespace, podName] = resource.includes('/') ? resource.split('/') : ['prod', resource];

    try {
      await this.telegram.sendAlert('critical', `${monitorName}: ${resource} is unhealthy\n\n🔬 Auto-diagnosing...`);

      // Gather full context (K8s + Loki in parallel)
      const [desc, logs, events, lokiErrors, lokiStats, lokiTrend] = await Promise.all([
        this.kube!.describePod(namespace, podName),
        this.kube!.getPodLogs(namespace, podName, 50),
        this.kube!.getEvents(namespace, podName),
        this.loki?.getErrorLogs(namespace, podName, '1h', 30).catch(() => []) ?? Promise.resolve([]),
        this.loki?.getLogStats(namespace, podName, '1h').catch(() => null) ?? Promise.resolve(null),
        this.loki?.getErrorTrend(namespace, podName).catch(() => 'unknown' as const) ?? Promise.resolve('unknown' as const),
      ]);

      // Get error patterns
      const lokiPatterns = await (this.loki?.getErrorPatterns(namespace, '1h', 100).catch(() => []) ?? Promise.resolve([]));

      // Send raw data
      await this.telegram.send(`🔎 <b>Pod Details:</b>\n${desc}`);
      if (logs && logs.length > 10) {
        await this.telegram.send(`📋 <b>Recent Logs:</b>\n<pre>${logs.substring(0, 3000)}</pre>`);
      }
      if (events && events !== 'No recent events found.') {
        await this.telegram.send(`📢 <b>Events:</b>\n${events}`);
      }

      // Send Loki analysis
      const lokiStatsStr = lokiStats && this.loki ? this.loki.formatStats(lokiStats, lokiTrend) : '';
      const lokiPatternsStr = lokiPatterns.length > 0 && this.loki ? this.loki.formatPatterns(lokiPatterns) : '';
      const lokiErrorsStr = lokiErrors.slice(0, 15).join('\n');

      if (lokiStatsStr) {
        await this.telegram.send(`📊 <b>Log Analysis (Loki):</b>\n<pre>${lokiStatsStr}</pre>`);
      }
      if (lokiErrors.length > 0) {
        await this.telegram.send(`🔴 <b>Error Logs (${lokiErrors.length}):</b>\n<pre>${lokiErrors.slice(0, 10).join('\n').substring(0, 3000)}</pre>`);
      }

      // AI analysis (with Loki context)
      let analysis = '';
      const lokiContext = lokiStatsStr
        ? `\n\n=== LOKI LOG ANALYSIS ===\n${lokiStatsStr}\n\nError Trend: ${lokiTrend}\n\nTop Error Patterns:\n${lokiPatternsStr}\n\nRecent Error Logs:\n${lokiErrorsStr.substring(0, 1500)}`
        : '';
      try {
        const aiResult = await this.bedrock.analyze({
          type: 'incident',
          message: `Auto-detected: pod ${resource} is unhealthy`,
          context: { description: desc, recentLogs: logs.substring(0, 2000), events, lokiAnalysis: lokiContext || undefined },
        });
        analysis = aiResult.analysis;
        await this.telegram.send(`🧠 <b>AI Analysis:</b>\n\n${analysis}`);
      } catch (err) {
        logger.warn(`AI analysis failed for ${resource}: ${err}`);
      }

      // Save incident context (including Loki data)
      const incident: IncidentContext = {
        monitor: monitorName,
        pod: podName,
        namespace,
        status: 'Critical',
        description: desc,
        logs,
        events,
        analysis,
        timestamp: new Date().toISOString(),
        lokiErrorLogs: lokiErrorsStr,
        lokiStats: lokiStatsStr,
        lokiPatterns: lokiPatternsStr,
        lokiTrend: lokiTrend,
      };

      // Add to incident timeline
      this.incidentLog.push(incident);
      if (this.incidentLog.length > 50) this.incidentLog = this.incidentLog.slice(-50);

      // Notify main.ts to update lastIncident
      if (this.onIncident) this.onIncident(incident);

      await this.telegram.send(`💡 Use <code>/email user@blueonion.today</code> or <code>/jira</code> to share this report.`);
      this.audit('auto-diagnose', monitorName, `Auto-diagnosed ${resource}`);
    } catch (err) {
      logger.error(`Auto-diagnose failed for ${resource}: ${err}`);
      // Still send basic alert
      await this.telegram.sendAlert('critical', `${monitorName}: ${resource} is unhealthy (auto-diagnose failed)`);
    }
  }

  getIncidentLog(): IncidentContext[] {
    return this.incidentLog.slice(-20);
  }

  private audit(action: string, monitor: string, details: string): void {
    this.auditLog.push({ timestamp: new Date(), action, monitor, details });
    if (this.auditLog.length > config.safety.auditLogMaxEntries) {
      this.auditLog = this.auditLog.slice(-config.safety.auditLogMaxEntries);
    }
  }
}
