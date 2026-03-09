import { CronJob } from 'cron';
import { Monitor, MonitorResult } from './monitors/base';
import { TelegramClient } from './clients/telegram';
import { BedrockClient } from './clients/bedrock';
import { config } from './config';
import { logger } from './utils/logger';

interface AuditEntry {
  timestamp: Date;
  action: string;
  monitor: string;
  details: string;
}

export class MonitorScheduler {
  private jobs: CronJob[] = [];
  private paused = false;
  private auditLog: AuditEntry[] = [];
  private actionsThisHour = 0;
  private lastHourReset = Date.now();
  private lastResults: Map<string, MonitorResult> = new Map();

  constructor(
    private monitors: Monitor[],
    private telegram: TelegramClient,
    private bedrock: BedrockClient,
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

    try {
      const result = await monitor.check();
      this.lastResults.set(monitor.name, result);

      if (!result.healthy) {
        const criticals = result.issues.filter((i) => i.severity === 'critical');
        const warnings = result.issues.filter((i) => i.severity === 'warning');

        // Send Telegram alerts for critical/warning issues
        if (criticals.length > 0) {
          const message = criticals
            .map((i) => `• ${i.resource}: ${i.message}`)
            .join('\n');
          await this.telegram.sendAlert('critical', `${monitor.name} monitor:\n${message}`);
          this.audit('alert', monitor.name, `${criticals.length} critical issues`);
        } else if (warnings.length > 0) {
          const message = warnings
            .map((i) => `• ${i.resource}: ${i.message}`)
            .join('\n');
          await this.telegram.sendAlert('warning', `${monitor.name} monitor:\n${message}`);
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

  private audit(action: string, monitor: string, details: string): void {
    this.auditLog.push({ timestamp: new Date(), action, monitor, details });
    if (this.auditLog.length > config.safety.auditLogMaxEntries) {
      this.auditLog = this.auditLog.slice(-config.safety.auditLogMaxEntries);
    }
  }
}
