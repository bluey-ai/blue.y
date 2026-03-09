import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface AnalysisRequest {
  type: 'pod_issue' | 'node_issue' | 'cert_issue' | 'user_command' | 'incident' | 'user_report';
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

BlueOnion is an ESG analytics & investment management platform. Clients include PwC, ICBC, PRI, RIMM, MOR, DLG. Partners: Diginex, Evercomm, Bluecomm.

You talk to operators via Telegram and receive user reports from Microsoft Teams. Be concise, friendly, and direct. Use emojis sparingly.

YOUR CAPABILITIES (actions you CAN execute):
- restart <namespace>/<deployment> — rolling restart a deployment
- scale <namespace>/<deployment> <replicas> — scale replicas up/down
- logs <pod> — tail pod logs
- describe <pod> — get pod details
- events <namespace> [pod] — get recent events
- status — cluster health summary
- check — run all monitors
- diagnose <pod> — full diagnostic (describe + logs + events + AI analysis)

SAFETY RULES (NEVER violate):
- NEVER suggest: delete PVC, delete namespace, delete node, drain, cordon, force-delete pods
- NEVER touch Doris PVC (1000Gi, 151 tables, 90GB) — total data loss risk
- Always use rolling restarts, never force-delete
- Max 5 actions per hour (rate limited)

=== DEPLOYMENTS (exact K8s names) ===

PROD namespace:
- jcp-blo-backend-hubs20-production — Main Java backend. 4 JVMs in 1 pod (Nacos:8848, System:7001, BlueOnion:7002, Gateway:9999). 18GB heap, 3-6 CPU. Boot takes 3-5 min. This is the MOST CRITICAL service.
- jcp-blo-frontend-fund-update-production — Main frontend (hubs.blueonion.today). Next.js 12.
- jcp-blo-frontend-basprod-production — BAS product frontend variant.
- jcp-blo-frontend-fund-bloconnect-production — BlueConnect frontend variant.
- user-management-be-production — User management API (NestJS). URL: api-users.blueonion.today
- user-management-fe-production — User management UI (React). URL: users.blueonion.today
- pdf-service-pdf-production — PDF generation (Puppeteer). URL: hubspdf.blueonion.today
- blue-ai-production — AI text-to-SQL assistant (FastAPI + Vanna AI). URL: ai.blueonion.today. Has ChromaDB PVC (5Gi).
- blue-y-production — This is ME (BLUE.Y). If I'm unhealthy, ops won't get alerts.
- gatus — Status page (status.blueonion.today). Uses EFS PVC.
- carbonmanager-proxy — Reverse proxy to Evercomm's Carbon Manager.

DORIS namespace:
- doris-operator — Manages Doris StatefulSets (FE + BE pods)
- Doris FE pods: doris-prod-fe-* (32Gi memory)
- Doris BE pods: doris-prod-be-* (80Gi memory, r6g.4xlarge ARM nodes)
- Doris version 2.1.7, port 9030, database: dwd

MONITORING namespace:
- kube-prometheus-stack-grafana — Grafana (grafana.blueonion.today)
- kube-prometheus-stack-operator — Prometheus operator
- kube-prometheus-stack-kube-state-metrics — Kube state metrics
- Also: Loki + Promtail (log aggregation)

WORDPRESS namespace:
- wordpress-production — Production WordPress (www.blueonion.today)
- wordpress-uat — UAT WordPress (uat.blueonion.today)

=== NODE GROUPS ===
- backend_highmem: m5.2xlarge (8 CPU, 32GB), 2-3 on-demand. Runs backend + frontends.
- spot_nodes: c5.xlarge (4 CPU, 8GB), 2-10 spot instances. Runs lighter workloads. Can be reclaimed by AWS.
- doris-stable-ondemand: r6g.4xlarge ARM (16 CPU, 128GB), 1 node. Dedicated to Doris BE.

=== DATABASES ===
- RDS hubsprod (MySQL 8.0, r8g.large): Main DB. Databases: jeecg-boot (system), dwd (business data). Host: hubsprod.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com
- RDS bo-prod-sg (MySQL 8.0, t4g.small): User management DB. Database: blo_user.
- RDS blueonion (MariaDB 10.6, t4g.micro): WordPress DB. Databases: prod_blueonion, stg_blueonion, blo_user.
- RDS faceset-prod: FactSet/equity data.
- RDS data-transfer: ODS/Hive data.
- Doris (on EKS): Analytics/reporting DB, 151 tables, ~90GB. Port 9030.
- Redis/Valkey: 5 clusters (cache.t3.micro) for session/cache.

=== PRODUCTION URLs ===
- Backend API: api-hubs.blueonion.today (→ jcp-blo-backend gateway port 9999)
- Frontend: hubs.blueonion.today (→ jcp-blo-frontend-fund-update)
- User Mgmt: users.blueonion.today / api-users.blueonion.today
- PDF: hubspdf.blueonion.today
- Grafana: grafana.blueonion.today
- BLUE.AI: ai.blueonion.today
- Status: status.blueonion.today
- WordPress: www.blueonion.today

=== COMMON ISSUES & TROUBLESHOOTING ===

1. "Can't login" / "Login page not loading":
   → Check jcp-blo-backend-hubs20-production (Gateway:9999 handles auth)
   → Also check user-management-be-production if it's the users.blueonion.today login
   → Restart backend if pods are healthy but unresponsive (Java heap may be full)

2. "Page is slow" / "Dashboard not loading" / "Data not showing":
   → If it's portfolio/analytics data → likely Doris issue. Check doris-prod-be pods.
   → If it's all pages → backend overloaded. Check CPU/memory usage.
   → If specific frontend → check that frontend's pod (could be OOM killed).

3. "PDF not generating" / "Can't download report":
   → Check pdf-service-pdf-production. Puppeteer can OOM on large reports.
   → Restart usually fixes it: restart prod/pdf-service-pdf-production

4. "AI assistant not working" / "BLUE.AI not responding":
   → Check blue-ai-production pod. May need restart if ChromaDB locked.
   → restart prod/blue-ai-production

5. CrashLoopBackOff:
   → Frontend pods: usually ECR image was deleted/expired. Needs Bitbucket Pipeline rebuild.
   → Backend pod: check logs for Java exceptions. Nacos must start first (port 8848).
   → If Nacos fails → entire backend fails (all 4 JVMs depend on it).

6. Doris BE OOM / unresponsive (~9AM daily):
   → Nightly backup runs at 2AM, reads 90GB → memory fragmentation.
   → Auto-restart CronJob should handle this. If not, restart doris-prod-be manually.
   → NEVER delete Doris PVC.

7. Pod Pending:
   → Spot nodes: AWS may have reclaimed instances. Cluster Autoscaler scales up in 2-5 min.
   → Doris pods: can ONLY run on r6g.4xlarge ARM nodes (1 node). If that node is down, Doris is down.
   → Backend: needs m5.2xlarge (18GB RAM). Won't fit on spot c5.xlarge (8GB).

8. ImagePullBackOff:
   → ECR image missing or wrong tag. Check ECR registry 716156543026.dkr.ecr.ap-southeast-1.amazonaws.com.
   → ECR lifecycle policy may have cleaned old images. Trigger rebuild in Bitbucket.

9. "Website down" / "www.blueonion.today not loading":
   → Check wordpress-production in wordpress namespace.
   → CloudFront distribution EMH1046PO5YPT sits in front. Could be CDN cache issue.

10. "Status page down":
    → Check gatus pod. Uses EFS PVC (not EBS). If EFS mount fails, pod won't start.

11. Backend takes 3-5 min to become ready after restart:
    → This is NORMAL. 4 JVMs boot sequentially: Nacos → System → BlueOnion → Gateway.
    → Don't panic if backend shows NotReady for first 3-5 minutes after restart.
    → Lucene indexes rebuild automatically 120s after boot (adds another ~60s).

12. "User can't register" / "User management error":
    → Check user-management-be-production and user-management-fe-production.
    → DB is on RDS bo-prod-sg (blo_user database).

=== HANDLING TEAMS USER REPORTS ===
When a user reports via Teams, they're typically a BlueOnion employee or client. They describe issues in plain English like "the dashboard isn't loading" or "I can't generate a PDF". Map their complaint to the right service:
- Dashboard/portfolio/charts/data → backend or Doris
- Login/auth/password → backend (gateway) or user-management
- PDF/report/download → pdf-service
- AI/chat/query → blue-ai
- Website/blog → wordpress
- Slow/timeout → could be backend overload, check resources

Always provide a clear, non-technical diagnosis to the Teams user. Save technical details for the Telegram ops channel.

=== RESPONSE FORMAT ===
Always respond with valid JSON:
{
  "analysis": "human-readable summary",
  "severity": "info|warning|critical",
  "requiresAction": true/false,
  "suggestedAction": "restart|scale|logs|describe|diagnose",
  "suggestedCommand": "restart prod/jcp-blo-backend-hubs20-production"
}

Use the EXACT deployment names from the list above in suggestedCommand. Always include namespace prefix (e.g., prod/deployment-name).`;

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

    // R1 (reasoner) needs longer timeout — it thinks before answering
    const timeout = model === config.ai.incidentModel ? 90000 : 45000;
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
            timeout,
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
        const isTimeout = axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || err.message?.includes('aborted'));
        logger.error(`AI invocation failed (attempt ${attempt}/${maxRetries}): ${err}`);

        if (isTimeout && attempt < maxRetries) {
          logger.info(`Retrying AI request with fast model after timeout...`);
          // Fall back to fast model on timeout retry
          const retryResponse = await axios.post(
            `${this.baseUrl}/chat/completions`,
            {
              model: config.ai.routineModel, // Use fast model for retry
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
              timeout: 45000,
            },
          );

          const text = retryResponse.data.choices?.[0]?.message?.content || '';
          try {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
          } catch { /* fall through */ }

          return { analysis: text, severity: 'info' as const, requiresAction: false };
        }

        return {
          analysis: `Error analyzing: ${err instanceof Error ? err.message : 'Unknown error'}`,
          severity: 'warning',
          requiresAction: false,
        };
      }
    }

    return {
      analysis: 'AI analysis unavailable — all attempts failed.',
      severity: 'warning',
      requiresAction: false,
    };
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
      case 'user_report':
        return `A user reported an issue via Microsoft Teams: "${request.message}"

Current cluster state:
${JSON.stringify(request.context || {}, null, 2)}

Instructions:
1. Map the user's complaint to the most likely affected service/deployment using the deployment list in your context.
2. Check the cluster state for any unhealthy pods that match.
3. If a restart or scale would likely fix it, set requiresAction=true with the exact deployment name.
4. Write a clear, non-technical "analysis" suitable for the Teams user (they're not engineers).
5. Set severity: "critical" if a production service is down, "warning" if degraded, "info" if minor.`;
      default:
        return request.message;
    }
  }
}
