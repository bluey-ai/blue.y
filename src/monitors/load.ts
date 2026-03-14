import { Monitor, MonitorResult } from './base';
import { KubeClient } from '../clients/kube';
import { BedrockClient } from '../clients/bedrock';
import { TelegramClient } from '../clients/telegram';
import { EKSClient, UpdateNodegroupConfigCommand, DescribeNodegroupCommand } from '@aws-sdk/client-eks';
import { logger } from '../utils/logger';

interface LoadReading {
  ts: number;
  cpuMilli: number;
  memoryMB: number;
  replicas: number;
}

interface NodeGroupState {
  name: string;
  fullName: string;
  desired: number;
  min: number;
  max: number;
  nodeUtilPct: number;   // avg CPU utilization across its nodes
}

interface ScaleAction {
  deployment: string;
  namespace: string;
  from: number;
  to: number;
  reason: string;
}

interface NodeScaleAction {
  nodeGroup: string;
  fullName: string;
  from: number;
  to: number;
  reason: string;
}

// Deployments BLUE.Y monitors for load.
// Configure via LOAD_WATCH_LIST env var (JSON array).
// Example:
// [{"deployment":"backend-production","namespace":"default","label":"Backend",
//   "memLimitMB":4096,"memWarnMB":3000,"memCritMB":3800,"cpuWarnPct":70,
//   "nodeGroup":"workers","nodeGroupFull":"workers-xxxxx","maxReplicas":3,"minReplicas":1}]
const WATCH_LIST: Array<{
  deployment: string; namespace: string; label: string;
  memLimitMB: number; memWarnMB: number; memCritMB: number; cpuWarnPct: number;
  nodeGroup: string; nodeGroupFull: string; maxReplicas: number; minReplicas: number;
}> = JSON.parse(process.env.LOAD_WATCH_LIST || '[]');

const HISTORY_SIZE = 10;              // 20 min history (2 min interval × 10)
const COOLDOWN_MS = 20 * 60_000;     // 20 min between replica scale actions
const NODE_COOLDOWN_MS = 45 * 60_000; // 45 min between node group changes
const SCALE_DOWN_READINGS = 8;        // 16 min of low load before scale down
const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 min between AI-triggered alerts per deployment
const MAX_SANE_CPU_MILLI = 16_000;   // >16 vCPU per pod is a metrics-server glitch — discard

// Business hours: 8:30AM–9PM SGT (UTC+8) Mon–Fri
function isBusinessHours(): boolean {
  const now = new Date();
  const sgt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const day = sgt.getDay(); // 0=Sun, 6=Sat
  const hour = sgt.getHours();
  const minute = sgt.getMinutes();
  if (day === 0 || day === 6) return false;
  const timeVal = hour * 60 + minute;
  return timeVal >= 8 * 60 + 30 && timeVal < 21 * 60;
}

function isPreBusinessHours(): boolean {
  const now = new Date();
  const sgt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
  const day = sgt.getDay();
  const hour = sgt.getHours();
  const minute = sgt.getMinutes();
  if (day === 0 || day === 6) return false;
  const timeVal = hour * 60 + minute;
  return timeVal >= 8 * 60 + 15 && timeVal < 8 * 60 + 45;
}

export class LoadMonitor implements Monitor {
  name = 'load';

  private history = new Map<string, LoadReading[]>();
  private cooldowns = new Map<string, number>();
  private alertCooldowns = new Map<string, number>();
  private nodeScaleCooldown = 0;
  private eks: EKSClient;

  // Last summary for /load command
  public lastSummary = '';

  // Pending node scale action (requires /yes from Telegram)
  public pendingNodeScale: NodeScaleAction | null = null;

  constructor(
    private kube: KubeClient,
    private bedrock: BedrockClient,
    private telegram: TelegramClient,
  ) {
    this.eks = new EKSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  async check(): Promise<MonitorResult> {
    const issues: MonitorResult['issues'] = [];

    try {
      // 1. Collect current metrics
      const podMetrics = await this.kube.getTopPods('prod');
      const nodeMetrics = await this.kube.getTopNodes();
      const hpaList = await this.kube.getHPAs('prod');

      // 2. Build per-deployment snapshot
      const snapshots: Array<{
        config: typeof WATCH_LIST[0];
        reading: LoadReading;
        history: LoadReading[];
        hpa?: { cpuPct: number; replicas: number };
      }> = [];

      for (const cfg of WATCH_LIST) {
        // Sum metrics across all pods of this deployment
        const pods = podMetrics.filter((p) => p.name.startsWith(cfg.deployment.replace('-production', '')));
        // Clamp individual pod CPU readings — metrics-server occasionally returns garbage values
        const totalCpu = pods.reduce((s, p) => {
          const v = parseInt(p.cpu || '0');
          return s + (v > MAX_SANE_CPU_MILLI ? 0 : v);
        }, 0);
        const totalMem = pods.reduce((s, p) => s + parseInt(p.memory || '0'), 0);
        const replicas = pods.length || 1;

        const reading: LoadReading = {
          ts: Date.now(),
          cpuMilli: totalCpu,
          memoryMB: totalMem,
          replicas,
        };

        // Update history
        const hist = this.history.get(cfg.deployment) || [];
        hist.push(reading);
        if (hist.length > HISTORY_SIZE) hist.shift();
        this.history.set(cfg.deployment, hist);

        // HPA current CPU%
        const hpa = hpaList.find((h: { name: string }) => h.name === cfg.deployment);
        const cpuPct = (hpa as { metrics?: Array<{ type: string; current: number }> })?.metrics?.find((m) => m.type === 'cpu')?.current || 0;

        snapshots.push({ config: cfg, reading, history: [...hist], hpa: hpa ? { cpuPct, replicas } : undefined });

        // Immediate alerts (no AI needed)
        if (totalMem > cfg.memCritMB) {
          issues.push({ resource: cfg.deployment, message: `Memory critical: ${totalMem}MB / ${cfg.memLimitMB}MB`, severity: 'critical' });
        } else if (totalMem > cfg.memWarnMB) {
          issues.push({ resource: cfg.deployment, message: `Memory high: ${totalMem}MB / ${cfg.memLimitMB}MB`, severity: 'warning' });
        }
      }

      // 3. Node utilization
      const nodeGroups = await this.getNodeGroupStates(nodeMetrics);

      // 4. Pre-business hours scale-up (8:15–8:45 AM SGT)
      await this.handlePreBusinessHoursScaling(snapshots);

      // 5. AI-driven scaling decisions (only every other check to save API calls)
      if (Math.floor(Date.now() / 60_000) % 4 === 0) { // every ~8 min
        await this.runAIScalingAnalysis(snapshots, nodeGroups);
      } else {
        // Threshold-based scaling in between AI checks
        await this.handleThresholdScaling(snapshots);
      }

      // 6. Node capacity alerts
      await this.handleNodeCapacityAlerts(nodeGroups);

      // 7. Update last summary
      this.lastSummary = this.buildSummary(snapshots, nodeGroups);

    } catch (err) {
      logger.error(`[Load] Monitor check failed: ${err}`);
    }

    return {
      monitor: this.name,
      healthy: issues.filter((i) => i.severity === 'critical').length === 0,
      issues,
      checkedAt: new Date(),
    };
  }

  // ========================
  // PRE-BUSINESS HOURS SCALE
  // ========================

  private async handlePreBusinessHoursScaling(snapshots: Array<{ config: typeof WATCH_LIST[0]; reading: LoadReading }>) {
    if (!isPreBusinessHours()) return;

    for (const { config, reading } of snapshots) {
      // Only scale the first deployment in the watch list (assumed to be the main backend)
      if (config !== WATCH_LIST[0]) continue;
      if (reading.replicas >= 2) continue;
      if (this.isOnCooldown(config.deployment)) continue;

      await this.scaleDeployment({
        deployment: config.deployment,
        namespace: config.namespace,
        from: reading.replicas,
        to: 2,
        reason: '📅 Pre-business hours (8:15 AM SGT) — scaling up ahead of morning traffic',
      });
    }
  }

  // ========================
  // THRESHOLD-BASED SCALING
  // ========================

  private async handleThresholdScaling(snapshots: Array<{ config: typeof WATCH_LIST[0]; reading: LoadReading; history: LoadReading[] }>) {
    for (const { config, reading, history } of snapshots) {
      if (this.isOnCooldown(config.deployment)) continue;

      const memPct = (reading.memoryMB / config.memLimitMB) * 100;
      const last3 = history.slice(-3);

      // Scale up: memory critical for 3+ readings
      if (reading.replicas < config.maxReplicas) {
        const memCritCount = last3.filter((r) => r.memoryMB > config.memCritMB).length;
        if (memCritCount >= 2) {
          await this.scaleDeployment({
            deployment: config.deployment,
            namespace: config.namespace,
            from: reading.replicas,
            to: reading.replicas + 1,
            reason: `🧠 Memory pressure: ${reading.memoryMB}MB (${Math.round(memPct)}% of limit) sustained for ${memCritCount} readings`,
          });
          continue;
        }
      }

      // Scale down: low load sustained, outside business hours
      if (reading.replicas > config.minReplicas && !isBusinessHours()) {
        const lowLoadCount = history.filter((r) =>
          r.memoryMB < config.memWarnMB * 0.5 && r.cpuMilli < 100,
        ).length;
        if (lowLoadCount >= SCALE_DOWN_READINGS && history.length >= SCALE_DOWN_READINGS) {
          await this.scaleDeployment({
            deployment: config.deployment,
            namespace: config.namespace,
            from: reading.replicas,
            to: reading.replicas - 1,
            reason: `📉 Low load sustained (${lowLoadCount} readings, outside business hours)`,
          });
        }
      }
    }
  }

  // ========================
  // AI SCALING ANALYSIS
  // ========================

  private async runAIScalingAnalysis(
    snapshots: Array<{ config: typeof WATCH_LIST[0]; reading: LoadReading; history: LoadReading[] }>,
    nodeGroups: NodeGroupState[],
  ) {
    try {
      const stateBlock = snapshots.map(({ config, reading, history }) => {
        const trend = history.length >= 3
          ? history.slice(-3).map((r) => `CPU:${r.cpuMilli}m Mem:${r.memoryMB}MB Replicas:${r.replicas}`).join(' → ')
          : 'insufficient history';
        const memPct = Math.round((reading.memoryMB / config.memLimitMB) * 100);
        return `${config.label} (${config.deployment}):
  Current: CPU=${reading.cpuMilli}m, Mem=${reading.memoryMB}MB (${memPct}% of ${config.memLimitMB}MB limit), Replicas=${reading.replicas} (min=${config.minReplicas}, max=${config.maxReplicas})
  Trend (last 3 readings): ${trend}
  Thresholds: memWarn=${config.memWarnMB}MB, memCrit=${config.memCritMB}MB`;
      }).join('\n\n');

      const nodeBlock = nodeGroups.map((ng) =>
        `  ${ng.name}: ${ng.desired} nodes, avg CPU util ${ng.nodeUtilPct}%`,
      ).join('\n');

      const businessHours = isBusinessHours();
      const sgt = new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', weekday: 'short' });

      const prompt = `You are an AI infrastructure scaling agent for a production Kubernetes cluster. Analyze the current load and decide if scaling is needed.

Time: ${sgt} SGT | Business hours: ${businessHours ? 'YES (be conservative scaling down)' : 'NO (can scale down if safe)'}

DEPLOYMENTS:
${stateBlock}

NODE GROUPS:
${nodeBlock}

Rules:
- Only recommend scale_up if sustained high memory (>85% of limit for 2+ readings) or high CPU trend
- Only recommend scale_down if low memory (<40% of limit) AND low CPU (<50m) for 8+ readings AND NOT business hours
- If scale_up replicas is at max, consider node_scale_up for that node group instead
- Never recommend scaling Doris
- Use "none" for ALL stable, normal, or expected states — do NOT alert on these
- Use "alert" ONLY for genuinely abnormal situations: sudden spike, unexpected pattern, memory leak trend, or something that requires immediate human investigation
- Do NOT use "alert" for: memory <80%, stable trends, normal replica counts, or anything that resolves itself
- A deployment running at minimum replicas (e.g. 1/2 where min=1) is NORMAL — do not alert
- If you would say "but stable" or "but no scaling needed" — use "none" instead

Respond with JSON array only:
[{"deployment": "<name>", "action": "scale_up|scale_down|none|alert", "reason": "<1 sentence>", "urgency": "immediate|normal|low"}]`;

      const raw = await this.bedrock.analyzeRaw(prompt);

      // Parse AI response
      const jsonMatch = raw.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) return;

      const recommendations: Array<{ deployment: string; action: string; reason: string; urgency: string }> = JSON.parse(jsonMatch[0]);

      for (const rec of recommendations) {
        if (rec.action === 'none') continue;

        const snap = snapshots.find((s) => s.config.deployment === rec.deployment);
        if (!snap) continue;

        if (this.isOnCooldown(snap.config.deployment)) continue;

        if (rec.action === 'scale_up' && snap.reading.replicas < snap.config.maxReplicas) {
          await this.scaleDeployment({
            deployment: snap.config.deployment,
            namespace: snap.config.namespace,
            from: snap.reading.replicas,
            to: snap.reading.replicas + 1,
            reason: `🧠 AI: ${rec.reason}`,
          });
        } else if (rec.action === 'scale_down' && snap.reading.replicas > snap.config.minReplicas && !isBusinessHours()) {
          await this.scaleDeployment({
            deployment: snap.config.deployment,
            namespace: snap.config.namespace,
            from: snap.reading.replicas,
            to: snap.reading.replicas - 1,
            reason: `🧠 AI: ${rec.reason}`,
          });
        } else if (rec.action === 'alert' && rec.urgency === 'immediate') {
          // Only send if not already alerted for this deployment recently
          const lastAlert = this.alertCooldowns.get(snap.config.deployment) || 0;
          if (Date.now() - lastAlert > ALERT_COOLDOWN_MS) {
            await this.telegram.sendAlert('warning', `⚠️ <b>${snap.config.label}</b>\n${rec.reason}`);
            this.alertCooldowns.set(snap.config.deployment, Date.now());
          }
        }
      }
    } catch (err) {
      logger.warn(`[Load] AI analysis failed: ${err}`);
    }
  }

  // ========================
  // DEPLOYMENT SCALING
  // ========================

  private async scaleDeployment(action: ScaleAction): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      execSync(
        `kubectl scale deployment ${action.deployment} -n ${action.namespace} --replicas=${action.to}`,
        { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      this.cooldowns.set(action.deployment, Date.now());

      const dirIcon = action.to > action.from ? '🔼' : '🔽';
      const msg = `${dirIcon} <b>Auto-scaled</b> <code>${action.deployment}</code>\n` +
        `Replicas: <b>${action.from} → ${action.to}</b>\n` +
        `Reason: ${action.reason}`;

      await this.telegram.send(msg);
      logger.info(`[Load] Scaled ${action.deployment}: ${action.from} → ${action.to} | ${action.reason}`);
    } catch (err) {
      logger.error(`[Load] Scale failed for ${action.deployment}: ${err}`);
      await this.telegram.sendAlert('warning', `❌ Auto-scale failed for <code>${action.deployment}</code>: ${err}`);
    }
  }

  // ========================
  // NODE GROUP SCALING
  // ========================

  async scaleNodeGroup(action: NodeScaleAction): Promise<boolean> {
    if (Date.now() - this.nodeScaleCooldown < NODE_COOLDOWN_MS) {
      logger.warn('[Load] Node scale on cooldown');
      return false;
    }

    try {
      const current = await this.eks.send(new DescribeNodegroupCommand({
        clusterName: process.env.CLUSTER_NAME || 'my-eks-cluster',
        nodegroupName: action.fullName,
      }));

      const config = current.nodegroup?.scalingConfig;
      if (!config) return false;

      const newDesired = Math.max(config.minSize || 1, Math.min(config.maxSize || 10, action.to));

      await this.eks.send(new UpdateNodegroupConfigCommand({
        clusterName: process.env.CLUSTER_NAME || 'my-eks-cluster',
        nodegroupName: action.fullName,
        scalingConfig: { desiredSize: newDesired },
      }));

      this.nodeScaleCooldown = Date.now();

      const dirIcon = action.to > action.from ? '🔼' : '🔽';
      await this.telegram.send(
        `${dirIcon} <b>Node Group Scaled</b>: <code>${action.nodeGroup}</code>\n` +
        `Nodes: <b>${action.from} → ${newDesired}</b>\n` +
        `Reason: ${action.reason}\n` +
        `⏱ New nodes ready in ~3-5 min.`,
      );

      logger.info(`[Load] Node group ${action.nodeGroup}: ${action.from} → ${newDesired}`);
      return true;
    } catch (err) {
      logger.error(`[Load] Node group scale failed: ${err}`);
      await this.telegram.sendAlert('warning', `❌ Node group scale failed: ${err}`);
      return false;
    }
  }

  // ========================
  // NODE CAPACITY ALERTS
  // ========================

  private async handleNodeCapacityAlerts(nodeGroups: NodeGroupState[]) {
    for (const ng of nodeGroups) {
      if (ng.name === 'doris-stable-ondemand') continue; // never touch Doris
      if (ng.nodeUtilPct > 80 && ng.desired < ng.max) {
        if (!this.isNodeScaleOnCooldown()) {
          this.pendingNodeScale = {
            nodeGroup: ng.name,
            fullName: ng.fullName,
            from: ng.desired,
            to: ng.desired + 1,
            reason: `Node group ${ng.name} at ${ng.nodeUtilPct}% CPU utilization`,
          };
          await this.telegram.send(
            `🖥️ <b>Node Pressure: ${ng.name}</b>\n` +
            `Avg CPU utilization: <b>${ng.nodeUtilPct}%</b>\n` +
            `Current nodes: ${ng.desired}/${ng.max}\n\n` +
            `BLUE.Y recommends adding 1 node.\n` +
            `Reply <code>/yes</code> to scale up or <code>/no</code> to dismiss.`,
          );
        }
      }
    }
  }

  // ========================
  // HELPERS
  // ========================

  private async getNodeGroupStates(nodeMetrics: Array<{ name: string; cpu: string; memory: string }>): Promise<NodeGroupState[]> {
    // capacityMilli = total CPU capacity per node in millicores
    const ngMap: Record<string, { cpuMilli: number[]; desired: number; min: number; max: number; fullName: string; capacityMilli: number }> = {
      'backend_highmem': { cpuMilli: [], desired: 1, min: 1, max: 3, fullName: 'backend_highmem-20260211013708218100000001', capacityMilli: 8000 }, // m5.2xlarge = 8 vCPU
      'spot_nodes': { cpuMilli: [], desired: 3, min: 2, max: 10, fullName: 'spot_nodes-20260211020045376800000001', capacityMilli: 4000 },           // c5.xlarge = 4 vCPU
    };

    for (const node of nodeMetrics) {
      const cpuMilli = parseInt(node.cpu);  // e.g. "50m" → 50
      const memMi    = parseInt(node.memory); // e.g. "28560Mi" → 28560
      // Classify by memory: m5.2xlarge ~32GB, c5.xlarge ~8GB. Threshold at 12GB (12288 Mi).
      if (memMi > 12_000) {
        ngMap['backend_highmem'].cpuMilli.push(cpuMilli);
      } else {
        ngMap['spot_nodes'].cpuMilli.push(cpuMilli);
      }
    }

    return Object.entries(ngMap).map(([name, ng]) => ({
      name,
      fullName: ng.fullName,
      desired: ng.desired,
      min: ng.min,
      max: ng.max,
      nodeUtilPct: ng.cpuMilli.length > 0
        ? Math.round((ng.cpuMilli.reduce((a, b) => a + b, 0) / ng.cpuMilli.length) / (ng.capacityMilli / 100))
        : 0,
    }));
  }

  private isOnCooldown(deployment: string): boolean {
    const last = this.cooldowns.get(deployment) || 0;
    return Date.now() - last < COOLDOWN_MS;
  }

  private isNodeScaleOnCooldown(): boolean {
    return Date.now() - this.nodeScaleCooldown < NODE_COOLDOWN_MS;
  }

  // ========================
  // /load COMMAND SUPPORT
  // ========================

  buildSummary(
    snapshots: Array<{ config: typeof WATCH_LIST[0]; reading: LoadReading; history: LoadReading[] }>,
    nodeGroups: NodeGroupState[],
  ): string {
    const bh = isBusinessHours();
    const sgt = new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore', timeStyle: 'short' });

    let msg = `📊 <b>Cluster Load Monitor</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🕒 ${sgt} SGT | ${bh ? '🟢 Business hours' : '🌙 Off-hours'}\n\n`;

    msg += `<b>Deployments:</b>\n`;
    for (const { config, reading, history } of snapshots) {
      const memPct = Math.round((reading.memoryMB / config.memLimitMB) * 100);
      const memIcon = memPct > 85 ? '🔴' : memPct > 65 ? '🟡' : '🟢';
      const trend = history.length >= 2
        ? (reading.memoryMB > history[history.length - 2].memoryMB ? '↑' : '↓')
        : '→';
      const cooldownLeft = this.isOnCooldown(config.deployment)
        ? ` ⏳${Math.ceil((COOLDOWN_MS - (Date.now() - (this.cooldowns.get(config.deployment) || 0))) / 60_000)}m cooldown`
        : '';
      msg += `${memIcon} <b>${config.label}</b> — ${reading.replicas} replica(s)${cooldownLeft}\n`;
      msg += `   CPU: <b>${reading.cpuMilli}m</b>  Mem: <b>${reading.memoryMB}MB</b> (${memPct}%) ${trend}\n`;
    }

    msg += `\n<b>Node Groups:</b>\n`;
    for (const ng of nodeGroups) {
      const icon = ng.nodeUtilPct > 80 ? '🔴' : ng.nodeUtilPct > 60 ? '🟡' : '🟢';
      msg += `${icon} <code>${ng.name}</code>: ${ng.desired} nodes, ~${ng.nodeUtilPct}% util\n`;
    }

    msg += `\n💡 <code>/scale &lt;deployment&gt; &lt;N&gt;</code> to override manually`;
    return msg;
  }

  async getStatus(): Promise<string> {
    return this.lastSummary || '⏳ Load data not yet collected (first check pending).';
  }
}
