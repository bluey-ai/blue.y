import {
  WAFV2Client,
  ListWebACLsCommand,
  GetWebACLCommand,
  ListIPSetsCommand,
  CreateIPSetCommand,
  GetIPSetCommand,
  UpdateIPSetCommand,
  GetSampledRequestsCommand,
  type WebACL,
  type IPSet,
  type SampledHTTPRequest,
} from '@aws-sdk/client-wafv2';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface WafMetrics {
  allowedRequests: number;
  blockedRequests: number;
  countedRequests: number;
  blockRate: number; // percentage
  period: string;
}

export interface WafRuleSummary {
  name: string;
  action: string;
  blockedCount: number;
}

export interface BlockedIP {
  ip: string;
  reason: string;
  blockedAt: Date;
  expiresAt: Date;
  autoBlocked: boolean;
}

export interface ThreatSample {
  ip: string;
  country: string;
  uri: string;
  method: string;
  rule: string;
  action: string;
  timestamp: Date;
  headers: Record<string, string>;
}

export class WafClient {
  private waf: WAFV2Client;
  private cw: CloudWatchClient;
  private webAclId: string | null = null;
  private webAclArn: string | null = null;
  private ipSetId: string | null = null;
  private ipSetArn: string | null = null;
  private ipSetLockToken: string | null = null;

  // Track auto-blocked IPs with TTL
  private blockedIPs: Map<string, BlockedIP> = new Map();

  constructor() {
    this.waf = new WAFV2Client({ region: config.waf.region });
    this.cw = new CloudWatchClient({ region: config.waf.region });
  }

  // ========================
  // INITIALIZATION
  // ========================

  async initialize(): Promise<boolean> {
    try {
      // Find the WAF Web ACL
      const acls = await this.waf.send(new ListWebACLsCommand({ Scope: config.waf.scope }));
      const acl = (acls.WebACLs || []).find((a) => a.Name === config.waf.webAclName);

      if (!acl) {
        logger.warn(`[WAF] Web ACL "${config.waf.webAclName}" not found`);
        return false;
      }

      this.webAclId = acl.Id || null;
      this.webAclArn = acl.ARN || null;

      // Find or create the IP set for blocking
      await this.ensureIPSet();

      logger.info(`[WAF] Initialized — ACL: ${config.waf.webAclName}, IP Set: ${config.waf.ipSetName}`);
      return true;
    } catch (err) {
      logger.error(`[WAF] Initialization failed: ${err}`);
      return false;
    }
  }

  private async ensureIPSet(): Promise<void> {
    try {
      // Find existing IP set
      const ipSets = await this.waf.send(new ListIPSetsCommand({ Scope: config.waf.scope }));
      const existing = (ipSets.IPSets || []).find((s) => s.Name === config.waf.ipSetName);

      if (existing) {
        this.ipSetId = existing.Id || null;
        this.ipSetArn = existing.ARN || null;
        // Get lock token
        if (this.ipSetId) {
          const detail = await this.waf.send(new GetIPSetCommand({
            Name: config.waf.ipSetName,
            Scope: config.waf.scope,
            Id: this.ipSetId,
          }));
          this.ipSetLockToken = detail.LockToken || null;

          // Rebuild blockedIPs map from existing addresses
          const addresses = detail.IPSet?.Addresses || [];
          for (const addr of addresses) {
            const ip = addr.replace(/\/\d+$/, '');
            if (!this.blockedIPs.has(ip)) {
              this.blockedIPs.set(ip, {
                ip,
                reason: 'Pre-existing block',
                blockedAt: new Date(),
                expiresAt: new Date(Date.now() + config.waf.autoBlockDurationMinutes * 60 * 1000),
                autoBlocked: false,
              });
            }
          }
        }
        logger.info(`[WAF] Found existing IP set: ${config.waf.ipSetName} (${this.blockedIPs.size} IPs)`);
        return;
      }

      // Create new IP set
      const created = await this.waf.send(new CreateIPSetCommand({
        Name: config.waf.ipSetName,
        Scope: config.waf.scope,
        IPAddressVersion: 'IPV4',
        Addresses: [],
        Description: 'Auto-managed by BLUE.Y security monitor',
      }));

      this.ipSetId = created.Summary?.Id || null;
      this.ipSetArn = created.Summary?.ARN || null;
      logger.info(`[WAF] Created IP set: ${config.waf.ipSetName}`);
    } catch (err) {
      logger.error(`[WAF] Failed to ensure IP set: ${err}`);
    }
  }

  // ========================
  // METRICS (CloudWatch)
  // ========================

  async getMetrics(periodMinutes = 5): Promise<WafMetrics> {
    const now = new Date();
    const start = new Date(now.getTime() - periodMinutes * 60 * 1000);

    const [allowed, blocked, counted] = await Promise.all([
      this.getWafMetric('AllowedRequests', start, now),
      this.getWafMetric('BlockedRequests', start, now),
      this.getWafMetric('CountedRequests', start, now),
    ]);

    const total = allowed + blocked + counted;
    const blockRate = total > 0 ? (blocked / total) * 100 : 0;

    return {
      allowedRequests: allowed,
      blockedRequests: blocked,
      countedRequests: counted,
      blockRate: Math.round(blockRate * 10) / 10,
      period: `${periodMinutes}min`,
    };
  }

  private async getWafMetric(metricName: string, start: Date, end: Date): Promise<number> {
    try {
      const res = await this.cw.send(new GetMetricStatisticsCommand({
        Namespace: 'AWS/WAFV2',
        MetricName: metricName,
        Dimensions: [
          { Name: 'WebACL', Value: config.waf.webAclName },
          { Name: 'Region', Value: config.waf.region },
          { Name: 'Rule', Value: 'ALL' },
        ],
        StartTime: start,
        EndTime: end,
        Period: 300,
        Statistics: ['Sum'],
      }));

      const dp = res.Datapoints || [];
      return dp.reduce((sum, d) => sum + (d.Sum || 0), 0);
    } catch (err) {
      logger.warn(`[WAF] Failed to get metric ${metricName}: ${err}`);
      return 0;
    }
  }

  // Per-rule metrics
  async getRuleMetrics(periodMinutes = 60): Promise<WafRuleSummary[]> {
    if (!this.webAclId || !this.webAclArn) return [];

    try {
      const acl = await this.waf.send(new GetWebACLCommand({
        Name: config.waf.webAclName,
        Scope: config.waf.scope,
        Id: this.webAclId,
      }));

      const rules = acl.WebACL?.Rules || [];
      const now = new Date();
      const start = new Date(now.getTime() - periodMinutes * 60 * 1000);

      const results: WafRuleSummary[] = [];

      for (const rule of rules) {
        const name = rule.Name || 'Unknown';
        const action = rule.Action?.Block ? 'Block' :
          rule.Action?.Allow ? 'Allow' :
          rule.Action?.Count ? 'Count' :
          rule.OverrideAction?.None ? 'GroupDefault' : 'Unknown';

        // Get blocked count for this rule
        let blockedCount = 0;
        try {
          const res = await this.cw.send(new GetMetricStatisticsCommand({
            Namespace: 'AWS/WAFV2',
            MetricName: 'BlockedRequests',
            Dimensions: [
              { Name: 'WebACL', Value: config.waf.webAclName },
              { Name: 'Region', Value: config.waf.region },
              { Name: 'Rule', Value: name },
            ],
            StartTime: start,
            EndTime: now,
            Period: periodMinutes * 60,
            Statistics: ['Sum'],
          }));
          blockedCount = (res.Datapoints || []).reduce((sum, d) => sum + (d.Sum || 0), 0);
        } catch { /* ignore per-rule metric failures */ }

        results.push({ name, action, blockedCount: Math.round(blockedCount) });
      }

      return results.sort((a, b) => b.blockedCount - a.blockedCount);
    } catch (err) {
      logger.error(`[WAF] Failed to get rule metrics: ${err}`);
      return [];
    }
  }

  // ========================
  // SAMPLED REQUESTS
  // ========================

  async getSampledRequests(ruleMetricName = 'ALL', maxItems = 20): Promise<ThreatSample[]> {
    if (!this.webAclArn) return [];

    try {
      const now = new Date();
      const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

      const res = await this.waf.send(new GetSampledRequestsCommand({
        WebAclArn: this.webAclArn,
        RuleMetricName: ruleMetricName,
        Scope: config.waf.scope,
        TimeWindow: { StartTime: thirtyMinAgo, EndTime: now },
        MaxItems: maxItems,
      }));

      return (res.SampledRequests || []).map((r: SampledHTTPRequest) => {
        const headers: Record<string, string> = {};
        for (const h of r.Request?.Headers || []) {
          if (h.Name && h.Value) headers[h.Name.toLowerCase()] = h.Value;
        }

        return {
          ip: r.Request?.ClientIP || 'unknown',
          country: r.Request?.Country || 'unknown',
          uri: r.Request?.URI || '/',
          method: r.Request?.Method || 'GET',
          rule: r.RuleNameWithinRuleGroup || ruleMetricName,
          action: r.Action || 'unknown',
          timestamp: r.Timestamp || new Date(),
          headers,
        };
      });
    } catch (err) {
      logger.error(`[WAF] Failed to get sampled requests: ${err}`);
      return [];
    }
  }

  // ========================
  // IP BLOCKING
  // ========================

  async blockIP(ip: string, reason: string, autoBlocked = false): Promise<boolean> {
    if (!this.ipSetId) {
      logger.warn('[WAF] IP set not initialized — cannot block IP');
      return false;
    }

    try {
      // Normalize to CIDR
      const cidr = ip.includes('/') ? ip : `${ip}/32`;
      const cleanIP = ip.replace(/\/\d+$/, '');

      // Get current IP set state
      const current = await this.waf.send(new GetIPSetCommand({
        Name: config.waf.ipSetName,
        Scope: config.waf.scope,
        Id: this.ipSetId,
      }));

      const addresses = current.IPSet?.Addresses || [];
      if (addresses.includes(cidr)) {
        logger.info(`[WAF] IP ${cidr} already blocked`);
        return true;
      }

      // Add the IP
      const updated = [...addresses, cidr];
      await this.waf.send(new UpdateIPSetCommand({
        Name: config.waf.ipSetName,
        Scope: config.waf.scope,
        Id: this.ipSetId,
        Addresses: updated,
        LockToken: current.LockToken || undefined,
        Description: 'Auto-managed by BLUE.Y security monitor',
      }));

      // Track for auto-expiry
      const expiresAt = new Date(Date.now() + config.waf.autoBlockDurationMinutes * 60 * 1000);
      this.blockedIPs.set(cleanIP, {
        ip: cleanIP,
        reason,
        blockedAt: new Date(),
        expiresAt,
        autoBlocked,
      });

      logger.info(`[WAF] Blocked IP ${cidr} — reason: ${reason}, expires: ${expiresAt.toISOString()}`);
      return true;
    } catch (err) {
      logger.error(`[WAF] Failed to block IP ${ip}: ${err}`);
      return false;
    }
  }

  async unblockIP(ip: string): Promise<boolean> {
    if (!this.ipSetId) return false;

    try {
      const cidr = ip.includes('/') ? ip : `${ip}/32`;
      const cleanIP = ip.replace(/\/\d+$/, '');

      const current = await this.waf.send(new GetIPSetCommand({
        Name: config.waf.ipSetName,
        Scope: config.waf.scope,
        Id: this.ipSetId,
      }));

      const addresses = current.IPSet?.Addresses || [];
      const filtered = addresses.filter((a) => a !== cidr);

      if (filtered.length === addresses.length) {
        logger.info(`[WAF] IP ${cidr} not found in block list`);
        return false;
      }

      await this.waf.send(new UpdateIPSetCommand({
        Name: config.waf.ipSetName,
        Scope: config.waf.scope,
        Id: this.ipSetId,
        Addresses: filtered,
        LockToken: current.LockToken || undefined,
        Description: 'Auto-managed by BLUE.Y security monitor',
      }));

      this.blockedIPs.delete(cleanIP);
      logger.info(`[WAF] Unblocked IP ${cidr}`);
      return true;
    } catch (err) {
      logger.error(`[WAF] Failed to unblock IP ${ip}: ${err}`);
      return false;
    }
  }

  // Clean up expired auto-blocks
  async cleanupExpiredBlocks(): Promise<number> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [ip, block] of this.blockedIPs) {
      if (block.autoBlocked && block.expiresAt.getTime() <= now) {
        expired.push(ip);
      }
    }

    let cleaned = 0;
    for (const ip of expired) {
      const ok = await this.unblockIP(ip);
      if (ok) cleaned++;
    }

    if (cleaned > 0) {
      logger.info(`[WAF] Cleaned up ${cleaned} expired auto-blocks`);
    }
    return cleaned;
  }

  getBlockedIPs(): BlockedIP[] {
    return [...this.blockedIPs.values()];
  }

  // ========================
  // WAF DETAILS
  // ========================

  async getWebAclDetails(): Promise<WebACL | null> {
    if (!this.webAclId) return null;

    try {
      const res = await this.waf.send(new GetWebACLCommand({
        Name: config.waf.webAclName,
        Scope: config.waf.scope,
        Id: this.webAclId,
      }));
      return res.WebACL || null;
    } catch (err) {
      logger.error(`[WAF] Failed to get WebACL details: ${err}`);
      return null;
    }
  }

  // ========================
  // FORMATTING
  // ========================

  formatMetricsForTelegram(metrics: WafMetrics): string {
    const blockIcon = metrics.blockRate > 10 ? '🔴' : metrics.blockRate > 5 ? '🟡' : '🟢';

    return (
      `🛡️ <b>WAF Security Dashboard</b> (${metrics.period})\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Allowed: <b>${metrics.allowedRequests.toLocaleString()}</b>\n` +
      `🚫 Blocked: <b>${metrics.blockedRequests.toLocaleString()}</b>\n` +
      `📊 Counted: <b>${metrics.countedRequests.toLocaleString()}</b>\n` +
      `${blockIcon} Block Rate: <b>${metrics.blockRate}%</b>\n\n` +
      `🔒 Auto-blocked IPs: <b>${this.blockedIPs.size}</b>`
    );
  }

  formatRulesForTelegram(rules: WafRuleSummary[]): string {
    if (rules.length === 0) return 'No WAF rules found.';

    let msg = `📋 <b>WAF Rules (last 1h)</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const rule of rules) {
      const icon = rule.blockedCount > 50 ? '🔴' : rule.blockedCount > 10 ? '🟡' : '🟢';
      msg += `${icon} <code>${rule.name}</code>\n`;
      msg += `   Action: ${rule.action} | Blocked: <b>${rule.blockedCount}</b>\n\n`;
    }

    return msg;
  }

  formatSamplesForTelegram(samples: ThreatSample[]): string {
    if (samples.length === 0) return '✅ No blocked requests in the last 30 minutes.';

    let msg = `🔍 <b>Recent Blocked Requests</b> (${samples.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Group by IP
    const byIP = new Map<string, ThreatSample[]>();
    for (const s of samples) {
      const existing = byIP.get(s.ip) || [];
      existing.push(s);
      byIP.set(s.ip, existing);
    }

    // Sort by count
    const sorted = [...byIP.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [ip, reqs] of sorted.slice(0, 10)) {
      const country = reqs[0].country || '??';
      const uris = [...new Set(reqs.map((r) => r.uri))].slice(0, 3);
      const rules = [...new Set(reqs.map((r) => r.rule))].slice(0, 2);
      msg += `🌐 <b>${ip}</b> (${country}) — ${reqs.length} blocked\n`;
      msg += `   URIs: ${uris.join(', ')}\n`;
      msg += `   Rules: ${rules.join(', ')}\n\n`;
    }

    return msg;
  }

  formatBlockedIPsForTelegram(): string {
    const ips = this.getBlockedIPs();
    if (ips.length === 0) return '✅ No IPs currently blocked by BLUE.Y.';

    let msg = `🚫 <b>Blocked IPs</b> (${ips.length})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    for (const block of ips) {
      const timeLeft = Math.max(0, Math.round((block.expiresAt.getTime() - Date.now()) / 60000));
      const autoTag = block.autoBlocked ? ' [AUTO]' : ' [MANUAL]';
      msg += `🔴 <code>${block.ip}</code>${autoTag}\n`;
      msg += `   Reason: ${block.reason}\n`;
      msg += `   Blocked: ${block.blockedAt.toISOString()}\n`;
      msg += `   Expires: ${timeLeft > 0 ? `${timeLeft}min` : 'expired'}\n\n`;
    }

    return msg;
  }
}
