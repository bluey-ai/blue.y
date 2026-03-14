import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface AnalysisRequest {
  type: 'pod_issue' | 'node_issue' | 'cert_issue' | 'user_command' | 'incident' | 'user_report' | 'db_query' | 'jira_query' | 'security_threat';
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

=== DATABASES (you have read-only access via user: bluey_readonly) ===

1. RDS hubsprod (MySQL 8.0, r8g.large, 3TB)
   Host: hubsprod.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com:3306
   THE most important database. Two schemas:
   - jeecg-boot: System tables — users (sys_user), roles, permissions, Nacos config, audit logs. This is the JeecgBoot framework database. Key tables: sys_user (backend login accounts), sys_role, sys_permission, sys_dict, sys_log.
   - dwd: ALL business data — ESG scores, fund data, portfolios, benchmarks, BAS awards, due diligence.
     Key table groups:
     * bas_* — BAS Awards: bas_register_company (company registrations), bas_registrations (fund entries per company), bas_invitation (invitation codes), bas_email (email templates), bas_coordinator
     * dd_* — Due Diligence Vault (FundBase/FundConnect): dd_submission (questionnaire submissions), dd_submission_answer (answers), dd_question (questions), dd_fund_info (fund profiles)
     * bluecomm_* — BlueComm partner portfolio data
     * sfdr_* — SFDR compliance (Article 8/9, PAI indicators)
     * pwc_* — PwC Climate Risk data
     * mor_* — MOR client data
     * pri_* — PRI (Principles for Responsible Investment)
     * rimm_* — RIMM client data
     * lucene_* — Search index metadata
     * fund_* / portfolio_* — Core fund & portfolio data for all products

2. RDS bo-prod-sg (MySQL 8.0, t4g.small, 20GB)
   Host: bo-prod-sg.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com:3306
   User Management + WordPress. Used by user-management-be (NestJS) and WordPress pods.
   - blo_user: members (all platform users — email, username, company_id, status, login history), company (companies/tenants), member_token (JWT tokens), member_expiry (subscription expiry), member_data_permission, account (admin accounts), company_role, notify_new_member_created
   - prod_blueonion: WordPress production (posts, pages, media, wp_users, wp_options)
   - stg_blueonion: WordPress staging
   - blo_user_dev: Dev copy of user management data (for future dev environment)
   When someone asks "does user X exist?" or "which company is user Y in?" — query blo_user.

4. RDS faceset-prod (MySQL 8.0, t4g.medium, 200GB)
   Host: faceset-prod.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com:3306
   Market data & financial datasets.
   - dwd: Processed business data layer
   - factset: FactSet market data feeds (fund prices, benchmarks, indices)
   - equity: Equity/stock data
   - edw: Enterprise Data Warehouse tables

5. RDS data-transfer (MySQL 8.0, t4g.small, 200GB)
   Host: data-transfer.cjwo2em4gzz8.ap-southeast-1.rds.amazonaws.com:3306
   ETL staging & data pipeline tables. Used by AWS Glue crawlers (daily 4AM UTC).
   - ods: Operational Data Store (raw ingested data from external sources)
   - hive: Hive metastore tables (EMR/Trino catalog metadata)
   - irs: IRS/tax-related reference data

6. Doris (Apache Doris 2.1.7, on EKS, r6g.4xlarge, 80GB memory)
   Host: doris-prod-fe-service.doris.svc.cluster.local:9030
   Analytics & reporting engine. 151 tables, ~90GB data.
   - dwd: Aggregated analytics — fund performance, ESG scores, portfolio analytics, screening results.
   This is what powers dashboards, charts, and data-heavy pages. When analytics queries are slow or dashboards show no data, Doris is likely the issue.
   WARNING: Doris BE can become unresponsive ~9AM after nightly backup (2AM). Auto-restart CronJob handles this.

7. Redis/Valkey: 5 ElastiCache clusters (cache.t3.micro) — session cache, rate limiting, temp data. No direct query access.

=== DATABASE QUERY GUIDELINES ===
When asked to look up data:
- User/member lookup → bo-prod-sg.blo_user.members (email, username, company_id, status)
- Company lookup → bo-prod-sg.blo_user.company (name, id)
- BAS registration → hubsprod.dwd.bas_register_company (email, companyname, invitationcode, status)
- BAS fund entries → hubsprod.dwd.bas_registrations (companyid, fundname, isin, category, status)
- Backend system users → hubsprod.jeecg-boot.sys_user (username, email, realname, status)
- Fund/portfolio data → hubsprod.dwd or Doris.dwd (depending on query type)
- Market data → faceset-prod.factset or faceset-prod.equity
- Due diligence → hubsprod.dwd.dd_submission, dd_submission_answer, dd_question
- WordPress → blueonion.prod_blueonion (wp_posts, wp_users, wp_options)
- ALWAYS use SELECT only. NEVER attempt INSERT/UPDATE/DELETE.
- Limit results to 50 rows max to keep Telegram messages readable.
- When querying, prefer specific columns over SELECT * to reduce data transfer.

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
    // Use reasoning model for incidents/commands/security, fast model for routine checks
    const model = request.type === 'incident' || request.type === 'user_command' || request.type === 'security_threat'
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

        // For jira_query and db_query, return raw text — callers parse JSON themselves
        if (request.type === 'jira_query' || request.type === 'db_query') {
          return {
            analysis: text,
            severity: 'info',
            requiresAction: false,
          };
        }

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

          // For jira_query and db_query, return raw text — callers parse JSON themselves
          if (request.type === 'jira_query' || request.type === 'db_query') {
            return { analysis: text, severity: 'info' as const, requiresAction: false };
          }

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
      case 'jira_query':
        return `The operator wants to query Jira. Their request: "${request.message}"

${request.context?.userName ? `The operator's name is: ${request.context.userName}\nWhen they say "me", "my", "myself" — they mean this person.\n` : ''}
=== JIRA CONTEXT ===
- Jira Cloud instance: blueonion.atlassian.net
- Projects: HUBS (main platform), BAS (Benchmark Awards), UM (User Management), CRM, EVERCOMM
- Team members: Zeeshan Ali, Abdul Khaliq, Usama, Boey Ng, Imran Akram
- Statuses: To Do, In Progress, In Review, Testing, Deployed, Done, Closed
- Issue types: Bug, Task, Story, Epic, Sub-task
- Priority levels: Highest, High, Medium, Low, Lowest

=== AVAILABLE ACTIONS ===
You can generate ONE of these action types:

1. "search" — Run a JQL query to find/list/count tickets
2. "person_tickets" — Get all tickets for a specific person
3. "project_summary" — Get project overview (tickets by status & assignee)
4. "get_ticket" — Get details of a specific ticket (e.g., BAS-1143)

=== JQL TIPS ===
- assignee = currentUser() — tickets assigned to the authenticated Jira user
- assignee = "accountId" — use lookupUser to find the accountId first
- status NOT IN (Done, Closed, Resolved) — open tickets
- project = HUBS — filter by project
- priority = Highest — filter by priority
- created >= -7d — last 7 days
- updated >= -1d — updated today
- type = Bug — filter by type
- ORDER BY priority DESC, updated DESC — common sort

Respond with ONLY valid JSON:
{
  "action": "search|person_tickets|project_summary|get_ticket",
  "jql": "JQL query string (for search action)",
  "person": "person name (for person_tickets action)",
  "project": "project key (for project_summary, optional)",
  "ticketKey": "BAS-1143 (for get_ticket action)",
  "explanation": "Brief human-readable explanation of what you're doing"
}

Examples:
- "how many tickets assigned to me?" → {"action": "person_tickets", "person": "Zeeshan Ali", "explanation": "Finding all open tickets assigned to you"}
- "show BAS bugs" → {"action": "search", "jql": "project = BAS AND type = Bug AND status NOT IN (Done, Closed) ORDER BY priority DESC", "explanation": "Listing open bugs in BAS project"}
- "what's the status of HUBS-6116?" → {"action": "get_ticket", "ticketKey": "HUBS-6116", "explanation": "Getting details for HUBS-6116"}
- "project summary for BAS" → {"action": "project_summary", "project": "BAS", "explanation": "Getting BAS project overview"}
- "highest priority tickets" → {"action": "search", "jql": "priority = Highest AND status NOT IN (Done, Closed) ORDER BY updated DESC", "explanation": "Listing all highest priority open tickets"}
- "tickets created this week" → {"action": "search", "jql": "created >= startOfWeek() AND status NOT IN (Done, Closed) ORDER BY created DESC", "explanation": "Tickets created this week"}`;

      case 'db_query':
        return `The operator wants to query our databases. Their request: "${request.message}"

${request.context?.schema ? `\nRelevant table schemas:\n${request.context.schema}\n` : ''}
Generate a SQL SELECT query to answer their question. Use the DATABASE QUERY GUIDELINES from your system prompt to pick the right database instance and schema.

IMPORTANT RULES:
- Only generate SELECT queries. Never INSERT/UPDATE/DELETE.
- Always add LIMIT 50 unless the user asks for a specific count.
- Use specific columns instead of SELECT * when possible.
- For user/member lookups, use bo-prod-sg.blo_user.members
- For BAS registrations, use hubsprod.dwd.bas_register_company
- For fund entries, use hubsprod.dwd.bas_registrations
- For due diligence, use hubsprod.dwd.dd_submission / dd_submission_answer
- For analytics/ESG scores, prefer doris.dwd
- For market data, use faceset-prod (factset/equity schemas)

Respond with ONLY valid JSON:
{
  "instance": "hubsprod",
  "database": "dwd",
  "sql": "SELECT ...",
  "explanation": "Brief explanation of what this query does"
}

If the question is ambiguous or you need to query multiple databases, return an array:
[
  {"instance": "...", "database": "...", "sql": "...", "explanation": "..."},
  {"instance": "...", "database": "...", "sql": "...", "explanation": "..."}
]`;
      case 'security_threat':
        return `SECURITY THREAT ANALYSIS:

${request.message}

Context:
${JSON.stringify(request.context || {}, null, 2)}

You are analyzing a potential security threat against our production infrastructure. Provide:

1. **Threat Classification**: What type of attack is this? (DDoS, brute force, vulnerability scanning, SQL injection, XSS, credential stuffing, bot/scraper, etc.)
2. **Severity Assessment**: Rate as info/warning/critical with justification.
3. **Attack Pattern**: Describe what the attacker is doing and what they're targeting.
4. **Risk Level**: What could happen if this attack succeeds? What data or services are at risk?
5. **Recommended Action**: Should we block the IP(s)? For how long? Any other defensive measures?
6. **Context Clues**: Anything notable about the user-agents, request patterns, geographic origin, or timing?

Be concise but thorough. This analysis will be shown to the ops team via Telegram.

Respond with JSON:
{
  "analysis": "human-readable threat analysis",
  "severity": "info|warning|critical",
  "requiresAction": true/false,
  "suggestedAction": "block_ip|monitor|ignore|escalate",
  "suggestedCommand": "block <ip> or other action"
}`;
      default:
        return request.message;
    }
  }
}
