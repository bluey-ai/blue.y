import { Monitor, MonitorResult } from './base';
import { WafClient } from '../clients/waf';
import { LokiClient } from '../clients/loki';
import { BedrockClient } from '../clients/bedrock';
import { TelegramClient } from '../clients/telegram';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ThreatEvent {
  type: 'waf_spike' | 'brute_force' | 'suspicious_pattern' | 'rate_limit' | 'scanner_detected';
  severity: 'info' | 'warning' | 'critical';
  source: string; // IP or pattern
  description: string;
  count: number;
  timestamp: Date;
  autoBlocked: boolean;
  details?: string;
}

export class SecurityMonitor implements Monitor {
  name = 'security';

  // Threat event history (for /threats command)
  private threatLog: ThreatEvent[] = [];
  private lastWafBlocked = 0; // previous check's blocked count (for spike detection)

  constructor(
    private waf: WafClient,
    private loki: LokiClient,
    private bedrock: BedrockClient,
    private telegram: TelegramClient,
  ) {}

  async check(): Promise<MonitorResult> {
    const issues: MonitorResult['issues'] = [];

    try {
      // Clean up expired blocks first
      await this.waf.cleanupExpiredBlocks();

      // Run all checks in parallel
      const [wafResult, authResult, scannerResult] = await Promise.all([
        this.checkWafSpikes(),
        this.checkAuthFailures(),
        this.checkScannerActivity(),
      ]);

      issues.push(...wafResult, ...authResult, ...scannerResult);
    } catch (err) {
      logger.error(`[Security] Monitor check failed: ${err}`);
      issues.push({
        resource: 'security-monitor',
        message: `Security check failed: ${err}`,
        severity: 'warning',
      });
    }

    return {
      monitor: this.name,
      healthy: issues.filter((i) => i.severity === 'critical').length === 0,
      issues,
      checkedAt: new Date(),
    };
  }

  // ========================
  // WAF SPIKE DETECTION
  // ========================

  private async checkWafSpikes(): Promise<MonitorResult['issues']> {
    const issues: MonitorResult['issues'] = [];

    try {
      const metrics = await this.waf.getMetrics(5);
      const threshold = config.security.blockedRequestSpikeThreshold;

      // Detect spike: current blocked > threshold AND higher than last check
      if (metrics.blockedRequests > threshold) {
        const increase = this.lastWafBlocked > 0
          ? Math.round(((metrics.blockedRequests - this.lastWafBlocked) / this.lastWafBlocked) * 100)
          : 100;

        if (increase > 50 || metrics.blockedRequests > threshold * 2) {
          const severity = metrics.blockedRequests > threshold * 3 ? 'critical' as const : 'warning' as const;

          const threat: ThreatEvent = {
            type: 'waf_spike',
            severity,
            source: 'WAF',
            description: `WAF blocked ${metrics.blockedRequests} requests in 5min (${increase > 0 ? `+${increase}%` : 'new spike'})`,
            count: metrics.blockedRequests,
            timestamp: new Date(),
            autoBlocked: false,
          };
          this.addThreat(threat);

          issues.push({
            resource: 'waf-blocked-requests',
            message: threat.description,
            severity,
          });

          // Get sampled requests for context
          if (severity === 'critical') {
            await this.analyzeAndAutoBlock(metrics.blockedRequests);
          }
        }
      }

      this.lastWafBlocked = metrics.blockedRequests;
    } catch (err) {
      logger.warn(`[Security] WAF spike check failed: ${err}`);
    }

    return issues;
  }

  // ========================
  // AUTH FAILURE DETECTION (Brute Force)
  // ========================

  private async checkAuthFailures(): Promise<MonitorResult['issues']> {
    const issues: MonitorResult['issues'] = [];

    try {
      // Search Loki for auth failure patterns across prod namespace
      const authErrors = await this.loki.queryPodLogs('prod', '.*', 50, '5m');
      const authFailures = authErrors.filter((line) =>
        /(?:login|auth|password|credential).*(?:fail|invalid|wrong|denied|reject|401|403|unauthorized)/i.test(line) ||
        /(?:fail|invalid|wrong|denied|reject).*(?:login|auth|password|credential)/i.test(line) ||
        /(?:brute.?force|too.many.attempts|rate.limit|account.lock)/i.test(line),
      );

      if (authFailures.length >= config.security.authFailureThreshold) {
        // Extract IPs from auth failures
        const ipPattern = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
        const ipCounts = new Map<string, number>();
        for (const line of authFailures) {
          const ips = line.match(ipPattern) || [];
          for (const ip of ips) {
            // Skip private IPs
            if (ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.') || ip === '127.0.0.1') continue;
            ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
          }
        }

        // Find top offenders
        const topOffenders = [...ipCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

        const severity = authFailures.length > config.security.authFailureThreshold * 3 ? 'critical' as const : 'warning' as const;

        const threat: ThreatEvent = {
          type: 'brute_force',
          severity,
          source: topOffenders.length > 0 ? topOffenders[0][0] : 'multiple',
          description: `${authFailures.length} auth failures in 5min${topOffenders.length > 0 ? ` — top IP: ${topOffenders[0][0]} (${topOffenders[0][1]} attempts)` : ''}`,
          count: authFailures.length,
          timestamp: new Date(),
          autoBlocked: false,
          details: topOffenders.map(([ip, count]) => `${ip}: ${count} failures`).join(', '),
        };
        this.addThreat(threat);

        issues.push({
          resource: 'auth-failures',
          message: threat.description,
          severity,
        });

        // Auto-block IPs with excessive failures
        if (config.security.autoBlockEnabled && severity === 'critical') {
          for (const [ip, count] of topOffenders) {
            if (count >= config.security.authFailureThreshold) {
              const blocked = await this.waf.blockIP(ip, `Brute force: ${count} auth failures in 5min`, true);
              if (blocked) {
                threat.autoBlocked = true;
                await this.telegram.sendAlert('critical',
                  `🛡️ AUTO-BLOCKED <code>${ip}</code>\nReason: Brute force — ${count} auth failures in 5min\nDuration: ${config.waf.autoBlockDurationMinutes}min`);
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Security] Auth failure check failed: ${err}`);
    }

    return issues;
  }

  // ========================
  // SCANNER / BOT DETECTION
  // ========================

  private async checkScannerActivity(): Promise<MonitorResult['issues']> {
    const issues: MonitorResult['issues'] = [];

    try {
      // Check Loki for common scanner patterns
      const scanLogs = await this.loki.queryPodLogs('prod', '.*', 100, '5m');
      const scannerPatterns = scanLogs.filter((line) =>
        /(?:\/wp-admin|\/wp-login|\/xmlrpc|\/\.env|\/\.git|\/phpmyadmin|\/admin\/config|\/actuator|\/api\/swagger)/i.test(line) ||
        /(?:sqlmap|nikto|nmap|dirsearch|gobuster|wpscan|masscan|nuclei|burpsuite)/i.test(line) ||
        /(?:SELECT.*FROM.*WHERE|UNION.*SELECT|OR\s+1\s*=\s*1|'--|\bDROP\s+TABLE\b)/i.test(line) ||
        /(?:<script|javascript:|onerror=|onload=|eval\()/i.test(line),
      );

      if (scannerPatterns.length >= 10) {
        // Extract scanner IPs
        const ipPattern = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
        const scannerIPs = new Map<string, number>();
        for (const line of scannerPatterns) {
          const ips = line.match(ipPattern) || [];
          for (const ip of ips) {
            if (ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.') || ip === '127.0.0.1') continue;
            scannerIPs.set(ip, (scannerIPs.get(ip) || 0) + 1);
          }
        }

        const severity = scannerPatterns.length > 50 ? 'critical' as const : 'warning' as const;
        const topScanner = [...scannerIPs.entries()].sort((a, b) => b[1] - a[1])[0];

        const threat: ThreatEvent = {
          type: 'scanner_detected',
          severity,
          source: topScanner ? topScanner[0] : 'multiple',
          description: `${scannerPatterns.length} scanner/attack patterns detected in 5min${topScanner ? ` — top IP: ${topScanner[0]} (${topScanner[1]} hits)` : ''}`,
          count: scannerPatterns.length,
          timestamp: new Date(),
          autoBlocked: false,
          details: scannerPatterns.slice(0, 3).map((l) => l.substring(0, 150)).join('\n'),
        };
        this.addThreat(threat);

        issues.push({
          resource: 'scanner-activity',
          message: threat.description,
          severity,
        });

        // Auto-block aggressive scanners
        if (config.security.autoBlockEnabled && severity === 'critical' && topScanner && topScanner[1] >= 20) {
          const blocked = await this.waf.blockIP(topScanner[0], `Scanner/attack: ${topScanner[1]} malicious patterns in 5min`, true);
          if (blocked) {
            threat.autoBlocked = true;
            await this.telegram.sendAlert('critical',
              `🛡️ AUTO-BLOCKED <code>${topScanner[0]}</code>\nReason: Scanner — ${topScanner[1]} malicious patterns in 5min\nDuration: ${config.waf.autoBlockDurationMinutes}min`);
          }
        }
      }
    } catch (err) {
      logger.warn(`[Security] Scanner check failed: ${err}`);
    }

    return issues;
  }

  // ========================
  // AI-POWERED THREAT ANALYSIS
  // ========================

  private async analyzeAndAutoBlock(blockedCount: number): Promise<void> {
    try {
      const samples = await this.waf.getSampledRequests('ALL', 20);
      if (samples.length === 0) return;

      // Group by IP
      const ipGroups = new Map<string, typeof samples>();
      for (const s of samples) {
        const existing = ipGroups.get(s.ip) || [];
        existing.push(s);
        ipGroups.set(s.ip, existing);
      }

      // Find top attackers
      const topAttackers = [...ipGroups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5);

      // AI analysis
      const analysis = await this.bedrock.analyze({
        type: 'security_threat' as 'incident',
        message: `WAF blocked ${blockedCount} requests in 5 minutes. Analyze these sampled blocked requests and determine threat level:`,
        context: {
          blockedCount,
          topAttackers: topAttackers.map(([ip, reqs]) => ({
            ip,
            count: reqs.length,
            countries: [...new Set(reqs.map((r) => r.country))],
            uris: [...new Set(reqs.map((r) => r.uri))].slice(0, 5),
            methods: [...new Set(reqs.map((r) => r.method))],
            userAgents: [...new Set(reqs.map((r) => r.headers['user-agent'] || 'unknown'))].slice(0, 3),
          })),
        },
      });

      // Send AI analysis to Telegram
      await this.telegram.send(
        `🧠 <b>AI Threat Analysis</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${analysis.analysis}`,
      );

      // Auto-block top attackers if critical
      if (config.security.autoBlockEnabled && analysis.severity === 'critical') {
        for (const [ip, reqs] of topAttackers) {
          if (reqs.length >= 5) {
            const blocked = await this.waf.blockIP(ip, `WAF threat (AI-confirmed): ${reqs.length} blocked requests`, true);
            if (blocked) {
              await this.telegram.sendAlert('critical',
                `🛡️ AUTO-BLOCKED <code>${ip}</code>\nReason: AI-confirmed threat — ${reqs.length} blocked requests\nDuration: ${config.waf.autoBlockDurationMinutes}min`);
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[Security] AI threat analysis failed: ${err}`);
    }
  }

  // ========================
  // THREAT LOG
  // ========================

  private addThreat(threat: ThreatEvent): void {
    this.threatLog.push(threat);
    if (this.threatLog.length > 200) {
      this.threatLog = this.threatLog.slice(-200);
    }
  }

  getThreats(limit = 20): ThreatEvent[] {
    return this.threatLog.slice(-limit);
  }

  getThreatSummary(): {
    total: number;
    critical: number;
    warning: number;
    autoBlocked: number;
    topTypes: Record<string, number>;
    topSources: Array<{ source: string; count: number }>;
  } {
    const last24h = this.threatLog.filter(
      (t) => Date.now() - t.timestamp.getTime() < 24 * 60 * 60 * 1000,
    );

    const topTypes: Record<string, number> = {};
    const sourceCounts = new Map<string, number>();

    for (const t of last24h) {
      topTypes[t.type] = (topTypes[t.type] || 0) + 1;
      sourceCounts.set(t.source, (sourceCounts.get(t.source) || 0) + 1);
    }

    const topSources = [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([source, count]) => ({ source, count }));

    return {
      total: last24h.length,
      critical: last24h.filter((t) => t.severity === 'critical').length,
      warning: last24h.filter((t) => t.severity === 'warning').length,
      autoBlocked: last24h.filter((t) => t.autoBlocked).length,
      topTypes,
      topSources,
    };
  }

  formatThreatsForTelegram(threats?: ThreatEvent[]): string {
    const list = threats || this.getThreats(15);
    if (list.length === 0) return '✅ No security threats detected recently.';

    const summary = this.getThreatSummary();

    let msg = `🛡️ <b>Security Threat Report</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `📊 Last 24h: <b>${summary.total}</b> events`;
    msg += ` | 🔴 ${summary.critical} critical`;
    msg += ` | 🟡 ${summary.warning} warning`;
    msg += ` | 🛡️ ${summary.autoBlocked} auto-blocked\n\n`;

    // Threat types
    if (Object.keys(summary.topTypes).length > 0) {
      msg += '<b>By Type:</b>\n';
      const typeLabels: Record<string, string> = {
        waf_spike: '📈 WAF Spike',
        brute_force: '🔑 Brute Force',
        suspicious_pattern: '🔍 Suspicious Pattern',
        rate_limit: '⏱️ Rate Limit',
        scanner_detected: '🤖 Scanner/Bot',
      };
      for (const [type, count] of Object.entries(summary.topTypes)) {
        msg += `  ${typeLabels[type] || type}: <b>${count}</b>\n`;
      }
      msg += '\n';
    }

    // Recent threats
    msg += '<b>Recent Events:</b>\n\n';
    for (const t of list.slice(-10).reverse()) {
      const icon = t.severity === 'critical' ? '🔴' : t.severity === 'warning' ? '🟡' : '🔵';
      const time = t.timestamp.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });
      const blocked = t.autoBlocked ? ' [BLOCKED]' : '';
      msg += `${icon} <b>${time}</b> ${t.description}${blocked}\n`;
    }

    return msg;
  }
}
