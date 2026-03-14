# BLUE.Y — AI Ops Assistant

**BLUE.Y asks why, so you don't have to.** 24/7 AI-powered infrastructure monitoring and incident response for your EKS cluster, operated entirely via Telegram (or Slack, MS Teams, or WhatsApp).

## Architecture

```
Telegram Bot  ←→  BLUE.Y (Node.js, EKS pod)
                     ├── Monitors (cron-scheduled)
                     │   ├── PodMonitor      — unhealthy pods, crash loops, restarts
                     │   ├── NodeMonitor     — node readiness, pressure conditions
                     │   ├── CertMonitor     — TLS certificate expiry (cert-manager)
                     │   └── HPAMonitor      — autoscaler utilization thresholds
                     ├── Clients
                     │   ├── KubeClient      — K8s API (pods, deployments, metrics, HPA)
                     │   ├── BedrockClient   — DeepSeek V3/R1 AI analysis
                     │   ├── TelegramClient  — Telegram Bot API
                     │   ├── EmailClient     — AWS SES incident reports
                     │   └── JiraClient      — Jira ticket creation
                     └── Scheduler
                         ├── Cron-based monitor execution
                         ├── Auto-diagnose (unhealthy pod → logs/events/AI analysis)
                         ├── Alert deduplication (15-min cooldown per resource)
                         └── Incident timeline (in-memory, last 50 events)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22, TypeScript 5 |
| K8s Client | `@kubernetes/client-node` v1 |
| AI | DeepSeek V3 (fast) + R1 (reasoner), OpenAI-compatible API |
| Alerts | Telegram Bot API (long polling) |
| Email | AWS SES (configurable sender address) |
| Ticketing | Jira REST API |
| Scheduling | `cron` library |
| Container | Alpine-based, non-root user, 256Mi/512Mi |

## Telegram Commands

### Monitoring
| Command | Description |
|---------|-------------|
| `/status` | Cluster health overview (nodes + pods per namespace) |
| `/check` | Run all monitors immediately |
| `/nodes` | Node CPU/memory allocatable resources |
| `/resources [ns]` | Pod CPU/memory usage via metrics API + HPA summary |
| `/hpa [ns]` | HPA autoscaler status — current vs target utilization |
| `/doris` | Doris FE/BE health + resource usage dashboard |

### Pods & Deployments
| Command | Description |
|---------|-------------|
| `/logs <pod>` | Tail last 30 lines of pod logs |
| `/logsearch <pod> <pattern>` | Search last 500 log lines for a pattern |
| `/describe <pod>` | Pod details (containers, state, IP, node) |
| `/events [ns] [pod]` | Recent K8s events |
| `/deployments [ns]` | List deployments with ready/total replicas |
| `/rollout <deployment>` | Rollout status, image, replica progress |
| `/diagnose <pod>` | Full AI diagnostic (describe + logs + events + AI analysis) |

### Actions (require `/yes` confirmation)
| Command | Description |
|---------|-------------|
| `/restart <deployment>` | Rolling restart via annotation patch |
| `/scale <deployment> <N>` | Scale replicas (0-10) |

### Reports
| Command | Description |
|---------|-------------|
| `/email <address>` | Email incident report (last diagnosis or bot response) |
| `/jira` | Create Jira ticket from last incident |
| `/incidents` | View incident timeline |

### System
| Command | Description |
|---------|-------------|
| `/sleep` | Pause all monitoring (kill switch) |
| `/wake` | Resume monitoring |
| `/help` | Show all commands |

Natural language queries are also supported — BLUE.Y will analyze your question with AI and cluster context.

## Monitors & Thresholds

| Monitor | Schedule | Warning | Critical |
|---------|----------|---------|----------|
| Pods | Every 2 min | Restarts > 5 | Not Running, CrashLoopBackOff |
| Nodes | Every 5 min | Pressure conditions | NotReady |
| Certs | Every 6 hours | Expires in 14 days | Expires in 7 days |
| HPA | Every 5 min | CPU/Mem >= 70%, at max replicas | CPU/Mem >= 85% |

## Auto-Diagnose

When the pod monitor detects a critical issue, BLUE.Y automatically:
1. Sends an initial alert to Telegram
2. Gathers pod description, logs (last 50 lines), and K8s events
3. Sends raw diagnostics to Telegram
4. Runs DeepSeek AI analysis on the gathered data
5. Saves the incident context for email/Jira sharing
6. Applies 15-minute cooldown per pod to prevent alert spam

## Safety

- **Confirmation required**: Restart and scale actions need explicit `/yes`
- **Action limit**: Max 5 actions per hour (configurable)
- **Blocked commands**: `kubectl delete pvc/namespace/node`, `kubectl drain/cordon`
- **Audit log**: All actions logged (last 1000 entries, accessible via `/audit` API)
- **Read-only RBAC**: ClusterRole grants read-only access + deployment patch/scale only
- **Non-root container**: Runs as `bluey` user (UID 1001)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8000` | HTTP server port |
| `AI_API_KEY` | Yes | — | DeepSeek API key |
| `AI_BASE_URL` | No | `https://api.deepseek.com/v1` | AI API endpoint |
| `AI_ROUTINE_MODEL` | No | `deepseek-chat` | Fast model (V3) |
| `AI_INCIDENT_MODEL` | No | `deepseek-reasoner` | Reasoning model (R1) |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes | — | Authorized chat ID |
| `WATCH_NAMESPACES` | No | `default,monitoring` | Comma-separated namespaces to watch |
| `KUBE_IN_CLUSTER` | No | `true` | Use in-cluster K8s config |
| `JIRA_EMAIL` | No | — | Jira account email |
| `JIRA_API_TOKEN` | No | — | Jira API token |
| `JIRA_BASE_URL` | No | `https://your-org.atlassian.net` | Jira instance URL |
| `JIRA_PROJECT_KEY` | No | `OPS` | Jira project key |
| `EMAIL_FROM` | No | `noreply@example.com` | SES sender address |
| `GRAFANA_EXTERNAL_URL` | No | — | Public Grafana URL (shown in password reset messages) |
| `AI_SYSTEM_CONTEXT` | No | — | Cluster-specific context injected into AI prompt (deployments, URLs, troubleshooting) |
| `AI_VISION_CONTEXT` | No | — | Service list for Vision AI image analysis |
| `PING_SERVICE_MAP` | No | `{}` | JSON map of service name → `{label, url}` for `/ping` command |
| `TEAM_EMAILS` | No | `{}` | JSON map of name → email for `/email <name>` shorthand |
| `PRODUCTION_URLS` | No | `[]` | JSON array of `{name, url, expect}` for QA smoke tests |

All secrets are stored in K8s Secret `blue-y-secrets`.

## Deployment

Runs on EKS (any cluster and namespace). CI/CD via your pipeline of choice (Bitbucket Pipelines example included).

```bash
# Local development
npm install
npm run dev

# Build
npm run build

# Deploy (via Bitbucket Pipelines)
git push origin main
# Pipeline: build → ECR push → kubectl apply
```

### K8s Resources
- **Deployment**: `blue-y-production`, Recreate strategy, 1 replica
- **Service**: ClusterIP, port 80 → 8000
- **ServiceAccount**: `blue-y` with IRSA (`BlueYBedrockRole`)
- **ClusterRole**: `blue-y-readonly` (read pods/nodes/deployments/events/secrets/metrics/HPA + patch deployments)
- **Secret**: `blue-y-secrets` (deepseek-api-key, telegram-bot-token, telegram-chat-id, jira-email, jira-api-token)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (status, uptime) |
| `/check` | POST | Trigger all monitors manually |
| `/audit` | GET | View audit log (last 100 entries) |

## Project Structure

```
src/
├── main.ts              # Entry point, Telegram command handler, Express server
├── config.ts            # Environment config
├── scheduler.ts         # Cron scheduler, auto-diagnose, incident timeline
├── clients/
│   ├── bedrock.ts       # DeepSeek AI client (V3 fast + R1 reasoner)
│   ├── email.ts         # AWS SES email client
│   ├── jira.ts          # Jira REST API client
│   ├── kube.ts          # Kubernetes API client (pods, nodes, deployments, HPA, metrics)
│   └── telegram.ts      # Telegram Bot API client
├── monitors/
│   ├── base.ts          # Monitor interface
│   ├── pods.ts          # Pod health monitor
│   ├── nodes.ts         # Node health monitor
│   ├── certs.ts         # TLS certificate expiry monitor
│   └── hpa.ts           # HPA utilization monitor
└── utils/
    └── logger.ts        # Winston logger
```
