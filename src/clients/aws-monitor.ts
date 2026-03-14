import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { GlueClient, GetCrawlersCommand } from '@aws-sdk/client-glue';
import { EMRClient, DescribeClusterCommand, ListStepsCommand } from '@aws-sdk/client-emr';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { logger } from '../utils/logger';

const REGION = process.env.AWS_REGION || 'us-east-1';

// RDS instances to monitor — configure via RDS_INSTANCES env var (JSON array).
// Example: '[{"id":"mydb","label":"Main DB","critical":true}]'
const RDS_INSTANCES: Array<{ id: string; label: string; critical: boolean }> = JSON.parse(
  process.env.RDS_INSTANCES || '[]'
);

const EMR_CLUSTER_ID = process.env.EMR_CLUSTER_ID || '';

export interface RdsMetrics {
  instanceId: string;
  label: string;
  critical: boolean;
  cpuPercent: number;
  freeStorageMB: number;
  allocatedStorageGB: number;
  storageUsedPercent: number;
  connections: number;
  maxConnections: number;
  readIOPS: number;
  writeIOPS: number;
  status: string;
  engine: string;
  instanceClass: string;
}

export interface GlueCrawlerStatus {
  name: string;
  state: string;
  lastRun: string;
  lastRunDuration: number;
  lastRunStatus: string;
  tablesCreated: number;
  tablesUpdated: number;
}

export interface EmrStatus {
  clusterId: string;
  name: string;
  state: string;
  stateChangeReason: string;
  normalizedInstanceHours: number;
  recentSteps: Array<{ name: string; status: string; createdAt: string }>;
}

export interface CostBreakdown {
  period: string;
  total: number;
  byService: Record<string, number>;
}

export class AwsMonitorClient {
  private cw: CloudWatchClient;
  private glue: GlueClient;
  private emr: EMRClient;
  private ce: CostExplorerClient;
  private rds: RDSClient;

  constructor() {
    this.cw = new CloudWatchClient({ region: REGION });
    this.glue = new GlueClient({ region: REGION });
    this.emr = new EMRClient({ region: REGION });
    this.ce = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer is us-east-1 only
    this.rds = new RDSClient({ region: REGION });
  }

  // ========================
  // RDS MONITORING
  // ========================

  async getRdsMetrics(): Promise<RdsMetrics[]> {
    const results: RdsMetrics[] = [];
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    for (const instance of RDS_INSTANCES) {
      try {
        // Get instance details
        const descRes = await this.rds.send(new DescribeDBInstancesCommand({
          DBInstanceIdentifier: instance.id,
        }));
        const dbInstance = descRes.DBInstances?.[0];
        if (!dbInstance) continue;

        const allocatedGB = dbInstance.AllocatedStorage || 0;
        const maxConns = this.estimateMaxConnections(dbInstance.DBInstanceClass || '');

        // Get metrics in parallel
        const [cpu, storage, conns, readIO, writeIO] = await Promise.all([
          this.getMetric('AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier', instance.id, fiveMinAgo, now),
          this.getMetric('AWS/RDS', 'FreeStorageSpace', 'DBInstanceIdentifier', instance.id, fiveMinAgo, now),
          this.getMetric('AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', instance.id, fiveMinAgo, now),
          this.getMetric('AWS/RDS', 'ReadIOPS', 'DBInstanceIdentifier', instance.id, fiveMinAgo, now),
          this.getMetric('AWS/RDS', 'WriteIOPS', 'DBInstanceIdentifier', instance.id, fiveMinAgo, now),
        ]);

        const freeStorageMB = (storage || 0) / (1024 * 1024);
        const usedPercent = allocatedGB > 0 ? ((allocatedGB * 1024 - freeStorageMB) / (allocatedGB * 1024)) * 100 : 0;

        results.push({
          instanceId: instance.id,
          label: instance.label,
          critical: instance.critical,
          cpuPercent: Math.round((cpu || 0) * 10) / 10,
          freeStorageMB: Math.round(freeStorageMB),
          allocatedStorageGB: allocatedGB,
          storageUsedPercent: Math.round(usedPercent * 10) / 10,
          connections: Math.round(conns || 0),
          maxConnections: maxConns,
          readIOPS: Math.round(readIO || 0),
          writeIOPS: Math.round(writeIO || 0),
          status: dbInstance.DBInstanceStatus || 'unknown',
          engine: `${dbInstance.Engine} ${dbInstance.EngineVersion}`,
          instanceClass: dbInstance.DBInstanceClass || '',
        });
      } catch (err) {
        logger.error(`Failed to get RDS metrics for ${instance.id}: ${err}`);
        results.push({
          instanceId: instance.id,
          label: instance.label,
          critical: instance.critical,
          cpuPercent: -1, freeStorageMB: -1, allocatedStorageGB: 0,
          storageUsedPercent: -1, connections: -1, maxConnections: 0,
          readIOPS: 0, writeIOPS: 0, status: 'error', engine: '', instanceClass: '',
        });
      }
    }

    return results;
  }

  private async getMetric(namespace: string, metricName: string, dimName: string, dimValue: string, start: Date, end: Date): Promise<number | null> {
    try {
      const res = await this.cw.send(new GetMetricStatisticsCommand({
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: [{ Name: dimName, Value: dimValue }],
        StartTime: start,
        EndTime: end,
        Period: 300,
        Statistics: ['Average'],
      }));
      const dp = res.Datapoints || [];
      return dp.length > 0 ? dp[dp.length - 1].Average || null : null;
    } catch {
      return null;
    }
  }

  private estimateMaxConnections(instanceClass: string): number {
    // Approximate max connections based on instance class memory
    const estimates: Record<string, number> = {
      'db.t4g.micro': 85, 'db.t4g.small': 150, 'db.t4g.medium': 300,
      'db.t3.micro': 85, 'db.t3.small': 150, 'db.t3.medium': 300,
      'db.r6g.large': 1000, 'db.r8g.large': 1000,
      'db.m5.large': 600, 'db.m5.xlarge': 1200,
    };
    return estimates[instanceClass] || 500;
  }

  formatRdsForTelegram(metrics: RdsMetrics[]): string {
    let msg = '🗄️ <b>RDS Database Health</b>\n\n';

    for (const m of metrics) {
      if (m.status === 'error') {
        msg += `❌ <b>${m.label}</b> — Error fetching metrics\n\n`;
        continue;
      }

      const cpuIcon = m.cpuPercent > 80 ? '🔴' : m.cpuPercent > 60 ? '🟡' : '🟢';
      const storageIcon = m.storageUsedPercent > 90 ? '🔴' : m.storageUsedPercent > 75 ? '🟡' : '🟢';
      const connIcon = m.maxConnections > 0 && (m.connections / m.maxConnections) > 0.8 ? '🔴' :
        m.maxConnections > 0 && (m.connections / m.maxConnections) > 0.6 ? '🟡' : '🟢';

      msg += `${m.critical ? '⭐' : '📦'} <b>${m.label}</b> (${m.instanceClass})\n`;
      msg += `  ${cpuIcon} CPU: ${m.cpuPercent}%\n`;
      msg += `  ${storageIcon} Storage: ${m.storageUsedPercent}% of ${m.allocatedStorageGB}GB (${Math.round(m.freeStorageMB / 1024)}GB free)\n`;
      msg += `  ${connIcon} Connections: ${m.connections}/${m.maxConnections}\n`;
      msg += `  💾 IOPS: R:${m.readIOPS} / W:${m.writeIOPS}\n`;
      msg += `  ⚙️ ${m.engine} | ${m.status}\n\n`;
    }

    // Alerts
    const alerts: string[] = [];
    for (const m of metrics) {
      if (m.cpuPercent > 80) alerts.push(`🔴 ${m.label}: CPU ${m.cpuPercent}% (HIGH)`);
      if (m.storageUsedPercent > 90) alerts.push(`🔴 ${m.label}: Storage ${m.storageUsedPercent}% (CRITICAL)`);
      if (m.storageUsedPercent > 75) alerts.push(`🟡 ${m.label}: Storage ${m.storageUsedPercent}% (WARNING)`);
      if (m.maxConnections > 0 && (m.connections / m.maxConnections) > 0.8) alerts.push(`🔴 ${m.label}: Connections ${m.connections}/${m.maxConnections} (HIGH)`);
    }

    if (alerts.length > 0) {
      msg += '<b>⚠️ Alerts:</b>\n' + alerts.join('\n');
    }

    return msg;
  }

  // ========================
  // GLUE CRAWLER MONITORING
  // ========================

  async getGlueCrawlers(): Promise<GlueCrawlerStatus[]> {
    try {
      const res = await this.glue.send(new GetCrawlersCommand({}));
      return (res.Crawlers || []).map((c) => {
        const lastCrawl = c.LastCrawl;
        return {
          name: c.Name || '',
          state: c.State || 'UNKNOWN',
          lastRun: lastCrawl?.StartTime?.toISOString() || '',
          lastRunDuration: lastCrawl?.StartTime && lastCrawl?.StartTime
            ? Math.round((Date.now() - lastCrawl.StartTime.getTime()) / 1000)
            : 0,
          lastRunStatus: lastCrawl?.Status || '',
          tablesCreated: lastCrawl?.LogGroup ? 0 : 0, // Glue doesn't expose this directly
          tablesUpdated: 0,
        };
      });
    } catch (err) {
      logger.error(`Failed to get Glue crawlers: ${err}`);
      return [];
    }
  }

  formatGlueForTelegram(crawlers: GlueCrawlerStatus[]): string {
    if (crawlers.length === 0) return '🕷️ <b>Glue Crawlers</b>\n\nNo crawlers found or access denied.';

    let msg = `🕷️ <b>Glue Crawlers (${crawlers.length})</b>\n\n`;

    const failed = crawlers.filter((c) => c.lastRunStatus === 'FAILED');
    const running = crawlers.filter((c) => c.state === 'RUNNING');
    const succeeded = crawlers.filter((c) => c.lastRunStatus === 'SUCCEEDED');

    if (failed.length > 0) {
      msg += `<b>❌ Failed (${failed.length}):</b>\n`;
      for (const c of failed) {
        msg += `  • ${c.name} — last run: ${c.lastRun ? new Date(c.lastRun).toLocaleDateString() : 'never'}\n`;
      }
      msg += '\n';
    }

    if (running.length > 0) {
      msg += `<b>⏳ Running (${running.length}):</b>\n`;
      for (const c of running) {
        msg += `  • ${c.name}\n`;
      }
      msg += '\n';
    }

    msg += `<b>✅ Succeeded: ${succeeded.length}</b> | `;
    msg += `❌ Failed: ${failed.length} | `;
    msg += `⏳ Running: ${running.length} | `;
    msg += `📊 Total: ${crawlers.length}\n`;

    // Check for stale crawlers (not run in 48 hours)
    const stale = crawlers.filter((c) => {
      if (!c.lastRun) return true;
      return Date.now() - new Date(c.lastRun).getTime() > 48 * 60 * 60 * 1000;
    });
    if (stale.length > 0) {
      msg += `\n⚠️ <b>${stale.length} crawlers haven't run in 48+ hours:</b>\n`;
      for (const c of stale.slice(0, 5)) {
        msg += `  • ${c.name}\n`;
      }
    }

    return msg;
  }

  // ========================
  // EMR MONITORING
  // ========================

  async getEmrStatus(): Promise<EmrStatus | null> {
    try {
      const [clusterRes, stepsRes] = await Promise.all([
        this.emr.send(new DescribeClusterCommand({ ClusterId: EMR_CLUSTER_ID })),
        this.emr.send(new ListStepsCommand({ ClusterId: EMR_CLUSTER_ID })),
      ]);

      const cluster = clusterRes.Cluster;
      if (!cluster) return null;

      const steps = (stepsRes.Steps || []).slice(0, 5).map((s) => ({
        name: s.Name || '',
        status: s.Status?.State || '',
        createdAt: s.Status?.Timeline?.CreationDateTime?.toISOString() || '',
      }));

      return {
        clusterId: EMR_CLUSTER_ID,
        name: cluster.Name || '',
        state: cluster.Status?.State || '',
        stateChangeReason: cluster.Status?.StateChangeReason?.Message || '',
        normalizedInstanceHours: cluster.NormalizedInstanceHours || 0,
        recentSteps: steps,
      };
    } catch (err) {
      logger.error(`Failed to get EMR status: ${err}`);
      return null;
    }
  }

  formatEmrForTelegram(status: EmrStatus | null): string {
    if (!status) return '🔧 <b>EMR Cluster</b>\n\nCould not fetch EMR status.';

    const stateIcon = status.state === 'WAITING' ? '🟢' : status.state === 'RUNNING' ? '⏳' : '🔴';

    let msg = `🔧 <b>EMR Cluster: ${status.name}</b>\n\n`;
    msg += `${stateIcon} State: <b>${status.state}</b>\n`;
    msg += `📊 Instance Hours: ${status.normalizedInstanceHours}\n`;
    if (status.stateChangeReason) msg += `💬 Reason: ${status.stateChangeReason}\n`;

    if (status.recentSteps.length > 0) {
      msg += '\n<b>Recent Steps:</b>\n';
      for (const s of status.recentSteps) {
        const icon = s.status === 'COMPLETED' ? '✅' : s.status === 'FAILED' ? '❌' : '⏳';
        msg += `  ${icon} ${s.name} — ${s.status}\n`;
      }
    }

    return msg;
  }

  // ========================
  // COST MONITORING
  // ========================

  async getCosts(days = 7): Promise<CostBreakdown | null> {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

      const res = await this.ce.send(new GetCostAndUsageCommand({
        TimePeriod: {
          Start: start.toISOString().split('T')[0],
          End: end.toISOString().split('T')[0],
        },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }));

      const byService: Record<string, number> = {};
      let total = 0;

      for (const result of res.ResultsByTime || []) {
        for (const group of result.Groups || []) {
          const service = group.Keys?.[0] || 'Other';
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
          // Shorten service names
          const shortName = service
            .replace('Amazon Elastic Compute Cloud - Compute', 'EC2')
            .replace('Amazon Relational Database Service', 'RDS')
            .replace('Amazon Simple Storage Service', 'S3')
            .replace('Amazon Elastic Container Service for Kubernetes', 'EKS')
            .replace('Amazon ElastiCache', 'ElastiCache')
            .replace('Amazon Elastic Load Balancing', 'ELB')
            .replace('Amazon CloudFront', 'CloudFront')
            .replace('Amazon Route 53', 'Route53')
            .replace('AWS Data Transfer', 'Data Transfer')
            .replace('Amazon EC2 Container Registry (ECR)', 'ECR')
            .replace('AWS Glue', 'Glue')
            .replace('Amazon EMR', 'EMR')
            .replace('AWS WAF', 'WAF')
            .replace('AmazonCloudWatch', 'CloudWatch')
            .replace('AWS Key Management Service', 'KMS')
            .replace('Amazon Simple Email Service', 'SES');
          byService[shortName] = (byService[shortName] || 0) + cost;
          total += cost;
        }
      }

      return {
        period: `${days} days`,
        total: Math.round(total * 100) / 100,
        byService,
      };
    } catch (err) {
      logger.error(`Failed to get cost data: ${err}`);
      return null;
    }
  }

  formatCostsForTelegram(costs: CostBreakdown | null): string {
    if (!costs) return '💰 <b>AWS Costs</b>\n\nCould not fetch cost data.';

    let msg = `💰 <b>AWS Costs (Last ${costs.period})</b>\n\n`;
    msg += `💵 <b>Total: $${costs.total.toFixed(2)}</b>\n`;
    msg += `📊 Daily avg: $${(costs.total / parseInt(costs.period)).toFixed(2)}\n\n`;

    // Sort by cost descending
    const sorted = Object.entries(costs.byService)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0.01);

    msg += '<b>By Service:</b>\n';
    for (const [service, cost] of sorted.slice(0, 15)) {
      const pct = costs.total > 0 ? ((cost / costs.total) * 100).toFixed(1) : '0';
      const bar = '█'.repeat(Math.round(parseFloat(pct) / 5)) || '▏';
      msg += `  ${bar} ${service}: $${cost.toFixed(2)} (${pct}%)\n`;
    }

    return msg;
  }

  // ========================
  // RDS BACKUP VERIFICATION
  // ========================

  async getRdsBackupStatus(): Promise<Array<{ id: string; label: string; lastBackup: string; backupWindow: string; retentionDays: number }>> {
    const results: Array<{ id: string; label: string; lastBackup: string; backupWindow: string; retentionDays: number }> = [];

    try {
      const res = await this.rds.send(new DescribeDBInstancesCommand({}));
      for (const db of res.DBInstances || []) {
        const inst = RDS_INSTANCES.find((r) => r.id === db.DBInstanceIdentifier);
        if (!inst) continue;

        results.push({
          id: db.DBInstanceIdentifier || '',
          label: inst.label,
          lastBackup: db.LatestRestorableTime?.toISOString() || 'never',
          backupWindow: db.PreferredBackupWindow || '',
          retentionDays: db.BackupRetentionPeriod || 0,
        });
      }
    } catch (err) {
      logger.error(`Failed to get RDS backup status: ${err}`);
    }

    return results;
  }
}
