# BLUE.Y — Feature Overview

> AI-powered Kubernetes operations assistant. Monitor, diagnose, and act — from your chat app or browser.

---

## The Problem We Solve

Running Kubernetes in production means context-switching between `kubectl`, Grafana, CI dashboards, and log aggregators — often at 2AM when something breaks. BLUE.Y collapses all of that into a single, intelligent interface: a chat command or a browser tab.

---

## Core Capabilities

### 1. Multi-Platform Chat Operations
Manage your entire Kubernetes cluster from the messaging app your team already uses.

- **Telegram** — primary interface, inline buttons, formatted alerts
- **WhatsApp** — via Twilio, same command set on mobile
- **Slack** — Socket Mode, no public URL required
- **Microsoft Teams** — native integration

Every platform gets the same full command set — no feature gaps between platforms.

---

### 2. AI-Powered Auto-Diagnosis
When a pod goes critical, BLUE.Y doesn't just alert — it diagnoses.

- Detects pod crashes, OOMKills, CrashLoopBackOffs, and ImagePullErrors within 2 minutes
- Automatically gathers `kubectl describe`, recent logs, and namespace events
- Sends the full context to DeepSeek AI for root-cause analysis
- Delivers a structured diagnosis report directly to your chat — before you even open a terminal
- **15-minute cooldown** per pod prevents alert fatigue during flapping incidents

> *"Pod jcp-blo-backend is CrashLoopBackOff. Root cause: OOMKill — heap exhausted at 9.8GB/10GB limit. Recommendation: increase memory limit or reduce concurrent Doris queries."*

---

### 3. 24/7 Automated Monitoring
Continuous health checks across your entire cluster, no agents required.

| Monitor | Frequency | What it checks |
|---|---|---|
| Pod health | Every 2 min | Status, restart count, readiness |
| Node health | Every 5 min | Pressure, capacity, spot termination |
| HPA status | Every 5 min | Scaling events, min/max breaches |
| TLS certificates | Every 6 hr | Expiry within 30 days |

Alerts fire immediately when thresholds are breached. Use `/sleep` and `/wake` to pause alerts during maintenance windows.

---

### 4. Admin Dashboard
A full-featured web UI at `your-domain/admin` — no `kubectl` required for your team.

Secure login via **SSO** (Google, Microsoft, GitHub) or **magic link**. Role-based access: **Viewer**, **Admin**, **Super Admin**.

---

#### Log Explorer
The most powerful feature in the dashboard — live Kubernetes log analysis in the browser.

- **Live tail** with auto-scroll across any pod in any namespace
- **Snapshot mode** — freeze logs at a point in time for forensic analysis
- **Error Clustering** — automatically groups similar stack traces and exception patterns, showing frequency counts. Instantly see *"4 patterns, 2× each"* instead of scrolling through 200 lines
- **AI Analyze** — one click sends your logs (or only the filtered subset) to AI for root-cause summary
- **Natural Language search** — type *"show all S3 errors"* or *"filter timeout exceptions"* in plain English; the AI translates it to a log filter in real time
- **Keyword filter** — instant client-side filtering, highlights matches inline
- **Download** — export current log view as a `.txt` file
- **Multi-pod view** — switch between pods without leaving the page

---

#### Network Explorer
Full visibility into your Kubernetes networking layer — from ingress to endpoints.

**Route Health Tab**
- Walks every ingress → service → endpoints chain and shows green / yellow / red health
- Pinpoints the exact breakpoint: `service-missing`, `no-endpoints`, `pods-not-ready`, `tls-expired`
- **AI Diagnose** button on any unhealthy route — gathers ingress spec, service config, and recent events, then returns a structured diagnosis with ranked kubectl remediation commands
- Edit and delete ingresses directly from the health view (Admin+)

**ALB Metrics Panel**
- Reads real CloudWatch metrics for your AWS Application Load Balancer
- Shows request count, 4xx/5xx error counts, latency (P50), and 5xx error rate
- Color-coded error rate bar: green < 1%, yellow < 5%, red ≥ 5%

**Ingresses Tab** — full CRUD: view, create, edit, delete ingresses with YAML editor

**Services Tab** — lists all services with endpoint health, dead/orphan detection

**Network Policies Tab** — view all network policies with affected pod counts

---

#### CI/CD Pipelines
Monitor and manage your build pipelines without switching tabs.

- **Bitbucket Pipelines** and **GitHub Actions** — both supported
- View all pipeline runs across every repository with status, duration, branch, and commit message
- **Step-by-step build logs** — drill into any build step inline, no new tab
- **Trigger a new build** on any branch with one click (Admin+)
- **Stop a running pipeline** instantly (Admin+)
- **Smart Rebuild** — point BLUE.Y at a pod, it auto-detects the repo and branch from the ECR image tag and triggers a rebuild (Super Admin)
- Auto-refreshes every 10 seconds while any pipeline is running

---

#### Cluster & Deployments
- Real-time pod status across all namespaces with CPU/memory usage
- Node inventory with instance type, capacity type (Spot/On-Demand), AZ, and uptime
- HPA status with current vs. desired replica counts and scaling metrics
- Deployment list with rollout history, image tags, and one-click restart/scale

---

#### Incident Management
- Chronological incident log with severity, pod, AI diagnosis, and resolution status
- **Auto-postmortem** — `/postmortem` generates a structured incident report (timeline, impact, root cause, action items) from any incident
- **Jira integration** — create tickets from incidents with pre-filled summary and description

---

### 5. Chat Commands (Full Reference)

| Category | Commands |
|---|---|
| **Status** | `/status`, `/check`, `/nodes`, `/resources`, `/hpa` |
| **Logs** | `/logs <pod>`, `/logsearch <pod> <keyword>` |
| **Inspect** | `/describe <pod>`, `/events`, `/deployments` |
| **Actions** | `/restart <pod>`, `/scale <deployment> <n>`, `/rollout <deployment>` |
| **AI** | `/diagnose <pod>` |
| **Incidents** | `/incidents`, `/postmortem` |
| **Notify** | `/email`, `/jira` |
| **Control** | `/sleep`, `/wake`, `/help` |

All destructive actions require explicit confirmation. Rate-limited to 5 actions/hour.

---

### 6. Security & Safety

- **Role-based access control** — Viewer (read-only), Admin (operations), Super Admin (config + user management)
- **SSO login** — Google, Microsoft, GitHub OAuth via configurable providers
- **Confirmation gates** — every restart, scale, or delete requires explicit acknowledgement
- **Action rate limiting** — max 5 destructive actions per hour, per user
- **Blocked commands** — hardcoded safeguards prevent deleting PVCs, namespaces, nodes, or draining/cordoning nodes
- **AI prompt sanitization** — credentials, IPs, and internal identifiers are stripped before any data leaves the cluster
- **Signed container images** — Cosign + SBOM for supply chain integrity (premium)
- **IP allowlist mode** — optionally restrict dashboard access to VPN/office IPs

---

### 7. Integrations

| Integration | Purpose |
|---|---|
| **AWS Bedrock / DeepSeek** | AI diagnosis and log analysis |
| **AWS CloudWatch** | ALB metrics in Network Explorer |
| **AWS SES** | Email alerts and reports |
| **Bitbucket Pipelines** | CI/CD monitoring and triggering |
| **GitHub Actions** | CI/CD monitoring and triggering |
| **Jira** | Incident ticket creation |
| **Telegram / WhatsApp / Slack / Teams** | Chat operations |

---

### 8. Deployment & Operations

- **Single Docker container** — one `kubectl apply` to deploy
- **Helm chart** included for teams that prefer GitOps
- **Minimal footprint** — 256Mi RAM / 100m CPU at idle
- **IRSA-ready** — uses AWS IAM Roles for Service Accounts; no hardcoded credentials
- **Read-only by default** — ClusterRole grants only the permissions needed; write verbs are additive
- **Namespace-scoped monitoring** — watch `prod`, `dev`, `monitoring`, or any namespace
- **Self-updating** — deploy a new image tag to pick up fixes; no data migration needed

---

## Edition Comparison

| Feature | Community | Premium |
|---|---|---|
| All chat platforms | ✓ | ✓ |
| AI auto-diagnosis | ✓ | ✓ |
| Admin dashboard | ✓ | ✓ |
| Log Explorer | ✓ | ✓ |
| Network Explorer | ✓ | ✓ |
| CI/CD Pipelines | ✓ | ✓ |
| Incident log | ✓ | ✓ |
| SSO login | — | ✓ |
| Multi-user RBAC | — | ✓ |
| Signed images + SBOM | — | ✓ |
| IP allowlist / VPN mode | — | ✓ |
| Priority support | — | ✓ |

---

*BLUE.Y — Built for the team that runs production on Kubernetes and wants their nights back.*
