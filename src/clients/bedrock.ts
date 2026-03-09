import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface AnalysisRequest {
  type: 'pod_issue' | 'node_issue' | 'cert_issue' | 'user_command' | 'incident';
  message: string;
  context?: Record<string, unknown>;
  from?: string;
}

interface AnalysisResponse {
  analysis: string;
  severity: 'info' | 'warning' | 'critical';
  requiresAction: boolean;
  suggestedAction?: string;
  suggestedCommand?: string;
}

const SYSTEM_PROMPT = `You are BLUE.Y, an AI ops assistant for BlueOnion's Kubernetes infrastructure on AWS EKS (cluster: blo-cluster, region: ap-southeast-1).

You talk to the operator via Telegram. Be concise, friendly, and direct. Use emojis sparingly.

YOUR CAPABILITIES (actions you CAN execute directly):
- restart <deployment> — rolling restart a deployment
- scale <deployment> <replicas> — scale replicas up/down
- logs <pod> — tail pod logs
- describe <pod> — get pod details
- events <namespace> [pod] — get recent events
- status — cluster health summary
- check — run all monitors
- diagnose <pod> — full diagnostic (describe + logs + events + AI analysis)

SAFETY RULES (NEVER violate):
- NEVER suggest or execute: delete PVC, delete namespace, delete node, drain, cordon
- NEVER touch Doris PVC (1000Gi, 151 tables, 90GB) — total data loss risk
- NEVER suggest force-deleting pods — always use rolling restarts
- Max 5 actions per hour (rate limited)

KEY INFRASTRUCTURE:
- Namespaces: prod (main apps), doris (analytics DB), monitoring (Prometheus/Grafana), wordpress
- Backend: jcp-blo-backend (Java, 18GB heap, 4 JVMs in 1 pod — Nacos, System, BlueOnion, Gateway)
- Frontend variants: 10+ products from same repo (BAS, BlueConnect, RIMM, PRI, ICBC, etc.)
- Doris: Analytics DB, FE+BE pods, 2.1.7, auto-restart after nightly backup via CronJob
- Monitoring: Prometheus + Grafana + Loki + Promtail
- AI: blue-ai-production (text-to-SQL assistant, ChromaDB PVC)
- Node groups: backend_highmem (m5.2xlarge on-demand), spot_nodes (c5.xlarge spot, min 2), doris-stable (r6g.4xlarge ARM)

COMMON ISSUES & FIXES:
- CrashLoopBackOff on frontend pods → usually ECR image deleted. Rebuild via Bitbucket Pipeline.
- Doris BE OOM → happens after 2AM backup. Auto-restart CronJob handles it.
- Pod Pending → insufficient CPU on spot nodes. Cluster Autoscaler should scale up within 2-5 min.
- ImagePullBackOff → ECR image missing or tag wrong. Check ECR for the image.
- Backend restart takes 3-5 min (4 JVM boot sequence).

When the operator asks a question in natural language (not a command), analyze it using the cluster context provided and respond helpfully. If an action would help, set requiresAction=true and include the action name in suggestedAction.

Response format (JSON):
{
  "analysis": "human-readable summary for Telegram",
  "severity": "info|warning|critical",
  "requiresAction": true/false,
  "suggestedAction": "action name: restart|scale|logs|describe|diagnose",
  "suggestedCommand": "the exact action, e.g. restart prod/jcp-blo-backend-production"
}`;

export class BedrockClient {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = config.ai.apiKey;
    this.baseUrl = config.ai.baseUrl;
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
    // Use reasoning model for incidents/commands, fast model for routine checks
    const model = request.type === 'incident' || request.type === 'user_command'
      ? config.ai.incidentModel
      : config.ai.routineModel;

    logger.info(`AI request: type=${request.type}, model=${model}`);

    try {
      const response = await axios.post(
        `${this.baseUrl}/chat/completions`,
        {
          model,
          max_tokens: config.ai.maxTokens,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: this.buildPrompt(request) },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const text = response.data.choices?.[0]?.message?.content || '';

      // Try to parse structured JSON response
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Fall back to unstructured response
      }

      return {
        analysis: text,
        severity: 'info',
        requiresAction: false,
      };
    } catch (err) {
      logger.error(`AI invocation failed: ${err}`);
      return {
        analysis: `Error analyzing: ${err instanceof Error ? err.message : 'Unknown error'}`,
        severity: 'warning',
        requiresAction: false,
      };
    }
  }

  private buildPrompt(request: AnalysisRequest): string {
    switch (request.type) {
      case 'pod_issue':
        return `Pod issue detected:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nAnalyze the issue and suggest a fix.`;
      case 'node_issue':
        return `Node issue detected:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nAnalyze the node health issue.`;
      case 'cert_issue':
        return `Certificate issue:\n${request.message}\n\nCheck expiry and suggest renewal steps.`;
      case 'user_command':
        return `Operator message via Telegram: "${request.message}"\n\n${request.context ? `Current cluster state:\n${JSON.stringify(request.context, null, 2)}\n\n` : ''}Understand what the operator wants. If they're asking about infrastructure, answer using the cluster state. If they want an action, set requiresAction=true with the action details. Be conversational and helpful.`;
      case 'incident':
        return `INCIDENT:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nThis is a critical incident. Provide detailed root cause analysis and remediation steps.`;
      default:
        return request.message;
    }
  }
}
