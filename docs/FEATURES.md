# BLUE.Y — Your AI Ops Teammate

> **"Your AI ops teammate — always watching, always ready."**
>
> BLUE.Y is a self-hosted, AI-native Kubernetes operations platform that collapses monitoring, diagnosis, log analysis, network visibility, and CI/CD management into a single chat command or browser tab — and never sends your data to a third-party cloud.

**2-minute pod crash detection.** &nbsp;|&nbsp; **4 chat platforms. Zero agents.** &nbsp;|&nbsp; **Self-hosted — your data stays in your cluster.**

---

## The Problem

Modern Kubernetes operations are a context-switching nightmare. When something breaks at 2AM, your team is simultaneously:

- Jumping between `kubectl`, Grafana, CloudWatch, and a CI dashboard to build a picture that should already exist in one place
- Getting paged by noisy alerts that tell you *what* crashed but never *why*
- Scrolling through 400 lines of logs trying to spot the one repeating exception that caused the incident
- Waiting on a senior engineer to diagnose something that a well-prompted AI could explain in 10 seconds

BLUE.Y eliminates all four problems. It watches your cluster continuously, diagnoses failures automatically, surfaces the answer in your chat before you open a terminal, and gives your whole team a web dashboard that doesn't require `kubectl` expertise.

---

## How BLUE.Y Works

**1. Deploy once.** One `kubectl apply` or `helm install`. BLUE.Y runs as a single container in your cluster — 256Mi RAM at idle, read-only ClusterRole, IRSA-ready. No agents, no sidecars, no external data pipeline.

**2. Connect your channels.** Link Telegram, Slack, WhatsApp, or Teams in minutes. Every platform gets the identical full command set — pick the one your on-call rotation already uses.

**3. Let it watch.** BLUE.Y monitors pods, nodes, HPA, and TLS certs around the clock. When something goes wrong, it doesn't just fire an alert — it gathers `kubectl describe`, logs, and events, sends them to AI, and delivers a root-cause diagnosis directly to your chat. Your team opens the message and already knows the fix. Premium users also get a full web dashboard for deep log analysis, network visibility, and CI/CD management.

---

## Core Features

### Multi-Platform Chat Operations

Manage your entire production cluster from the messaging app your team actually uses — no new tool to adopt.

BLUE.Y runs on **Telegram**, **WhatsApp** (Twilio), **Slack** (Socket Mode), and **Microsoft Teams** simultaneously. Every platform carries the full command surface: status checks, log tailing, pod restarts, scaling, rollouts, incident management, and AI diagnosis. No feature gaps between platforms — on-call rotation can use whichever channel they prefer.

- Inline buttons and formatted alerts — not just raw text
- Threaded conversations keep incident context grouped
- Works on mobile — same commands, same output

---

### AI Auto-Diagnosis — Root Cause Before You Open a Terminal

When a pod enters CrashLoopBackOff, OOMKilled, ImagePullError, or any critical state, BLUE.Y acts immediately — not just alerting, but diagnosing.

Within 2 minutes of detection, BLUE.Y automatically gathers `kubectl describe`, recent container logs, and namespace events, bundles the full context, and sends it to AI for analysis. The result — a structured root-cause summary with specific remediation steps — lands in your chat before most engineers have found their laptop.

- Catches CrashLoopBackOff, OOMKill, ImagePullError, Evicted, Pending, and more
- 15-minute cooldown per pod prevents alert fatigue during flapping incidents
- `/diagnose <pod>` runs on-demand analysis at any time
- Network route diagnosis available inline in the dashboard — AI walks the ingress → service → endpoint chain and returns ranked remediation commands

> *"OOMKill — JVM heap exhausted at 9.8GB/10GB limit. Recommendation: increase memory limit or tune concurrent query threads."* — delivered to chat, automatically.

---

### 24/7 Cluster Monitoring — Zero Agents, Zero Noise

BLUE.Y runs continuous health checks across your entire cluster with no agents to install, no DaemonSets to manage, and no third-party data pipeline to trust.

| Monitor | Frequency | What it checks |
|---|---|---|
| Pod health | Every 2 min | Status, restart count, readiness |
| Node health | Every 5 min | Memory/disk/PID pressure, capacity type, spot termination risk |
| HPA status | Every 5 min | Scaling events, min/max replica breaches |
| TLS certificates | Every 6 hr | Certificates expiring within 30 days |

Alerts fire the moment a threshold is breached. Use `/sleep` before a maintenance window and `/wake` when you're done — monitoring resumes instantly, no config change required.

---

### Admin Dashboard — Full Cluster Visibility Without kubectl *(Premium)*

A polished, dark-mode web interface at your domain. No Kubernetes CLI knowledge required for your team.

Six purpose-built modules cover every angle of cluster operations — all accessible from a single browser tab. Secure login via SSO (Google, Microsoft, GitHub) or magic link. Role-based access controls who can view, who can act, and who can configure.

---

#### Log Explorer — Live Tailing, AI Analysis, and Error Clustering

The most powerful Kubernetes log interface available outside of a dedicated observability platform — built directly into BLUE.Y.

**Error Clustering** is the headline feature: instead of scrolling 200 lines of stack traces, BLUE.Y automatically groups similar exceptions and stack traces by pattern, shows frequency counts side-by-side, and highlights the repeating errors that actually matter. See *"4 patterns, 2× each"* in seconds.

**AI Analyze** sends your current log view — or just the filtered subset — to AI with a single click. Returns a plain-English root-cause summary with the lines that caused the failure called out explicitly. No copy-paste, no context-building, no waiting.

**Natural Language Search** lets you type *"show all S3 errors"* or *"filter timeout exceptions"* in plain English. AI translates it to a log filter in real time — no regex required.

- Live tail with auto-scroll across any pod in any namespace
- Snapshot mode — freeze logs at a moment in time for forensic analysis
- Keyword filter with inline match highlighting
- Download current view as `.txt`
- Switch between pods instantly without leaving the page

---

#### Network Explorer — From Ingress to Endpoint, Visualized

Complete Kubernetes networking visibility in one panel. BLUE.Y walks every ingress → service → endpoints chain and shows green / yellow / red health with exact breakpoints — no guessing where the path broke.

**Route Health** identifies `service-missing`, `no-endpoints`, `pods-not-ready`, and `tls-expired` failures precisely. Click **AI Diagnose** on any unhealthy route and receive a structured analysis with ranked `kubectl` remediation steps — gathered from ingress spec, service config, and live events automatically.

**ALB Metrics** pulls real CloudWatch data for your AWS Application Load Balancer: request count, 4xx/5xx error totals, P50 latency, and a color-coded 5xx error rate bar (green < 1%, yellow < 5%, red ≥ 5%). No separate Grafana dashboard needed.

**Ingresses** — full CRUD with an inline YAML editor (Admin+). **Services** — endpoint health with dead/orphan detection. **Network Policies** — all policies with affected pod counts.

---

#### CI/CD Pipelines — Monitor and Trigger Without Switching Tabs

Your CI dashboard, embedded directly in BLUE.Y. No more browser tab proliferation when you're tracking a deployment.

BLUE.Y integrates with **Bitbucket Pipelines** and **GitHub Actions** simultaneously. View every pipeline run across all repositories — status, duration, branch, and commit message — in a single feed. Drill into any step to see build logs inline. Trigger a new build on any branch, or stop a running pipeline, without leaving the dashboard.

**Smart Rebuild** is the standout: point BLUE.Y at a pod, it reads the ECR image tag, auto-detects the originating repo and branch, and triggers a rebuild in one click. No copy-pasting pipeline URLs or hunting for the right branch name.

- Auto-refreshes every 10 seconds while pipelines are running
- Full build logs per step — no new tab, no credentials required
- Trigger new builds (Admin+), stop running pipelines (Admin+)

---

#### Incident Management — Structured History, AI Postmortems, Jira Integration

Every critical alert BLUE.Y fires is automatically recorded in the incident log with severity, affected pod, AI diagnosis, and resolution status. Your full incident history is searchable — no more piecing together timelines from Slack messages.

`/postmortem` generates a complete structured incident report from any incident: timeline, impact assessment, root cause, and concrete action items. Generated by AI from the incident data BLUE.Y already captured — ready in seconds, not hours.

Jira integration lets you create a ticket from any incident with pre-filled summary and description — one button, no copy-pasting.

---

#### Cluster & Deployments

Real-time pod status across all namespaces with CPU and memory usage. Node inventory with instance type, capacity type (Spot vs On-Demand), availability zone, and uptime. HPA panel with current vs. desired replica counts and the scaling metric driving each decision. Deployment list with rollout history, image tags, and one-click restart or scale operations.

---

### Full Chat Command Reference

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

All destructive actions require explicit confirmation. Capped at 5 actions per hour per user.

---

## Integrations

BLUE.Y connects to the tools your team already runs — no rip-and-replace.

| Integration | What it powers |
|---|---|
| **DeepSeek AI / AWS Bedrock** | Auto-diagnosis, log analysis, postmortem generation, NL search |
| **AWS CloudWatch** | ALB metrics in Network Explorer |
| **AWS SES** | Email alerts and incident reports |
| **Bitbucket Pipelines** | CI/CD monitoring, log viewing, build triggering |
| **GitHub Actions** | CI/CD monitoring, log viewing, build triggering |
| **Jira** | Incident ticket creation with pre-filled context |
| **Telegram** | Chat operations — primary interface |
| **WhatsApp** | Chat operations via Twilio |
| **Slack** | Chat operations via Socket Mode (no public URL needed) |
| **Microsoft Teams** | Chat operations — native integration |

---

## Security and Compliance

BLUE.Y is built security-first — because an ops tool that touches production deserves to be held to a higher standard.

**Access control.** Three roles cover every team shape: Viewer (read-only), Admin (operations: restart, scale, rollout), and Super Admin (configuration, user management). SSO via Google, Microsoft, or GitHub OAuth with configurable providers (Premium).

**No credential leakage.** AI prompt sanitization strips passwords, API keys, IP addresses, and internal identifiers before any data is sent for analysis. Your secrets stay in your cluster.

**Hardcoded safety blocks.** Regardless of role, BLUE.Y refuses to delete PVCs, delete namespaces, or drain/cordon nodes. These guards are in the code — not in configuration that can be overridden.

**Rate limiting and confirmation gates.** Every destructive action (restart, scale, delete) requires explicit acknowledgement. A hard cap of 5 destructive actions per hour per user prevents runaway automation.

**Supply chain integrity.** Container images are signed with Cosign and shipped with a Software Bill of Materials (SBOM) so you can verify exactly what you're running (Premium).

**Network isolation.** IP allowlist mode restricts dashboard access to VPN or office CIDR ranges. Slack Socket Mode requires no inbound firewall rules. (Premium)

**Self-hosted by design.** Your cluster data, your logs, your incident history — none of it touches a BLUE.Y-operated cloud. You control the deployment, the updates, and the data retention.

---

## Deploy in Under 5 Minutes

BLUE.Y runs as a single container. There's nothing to install on your nodes, no agents to configure, and no external database to provision.

```bash
# Option 1 — kubectl
kubectl apply -f https://bluey.ai/install/latest.yaml

# Option 2 — Helm
helm repo add bluey https://charts.bluey.ai
helm install blue-y bluey/blue-y --namespace prod
```

**Minimal footprint.** 256Mi RAM and 100m CPU at idle — invisible on any cluster that runs real workloads.

**IRSA-ready.** Uses AWS IAM Roles for Service Accounts. No hardcoded credentials, no long-lived keys.

**Read-only by default.** The ClusterRole grants only the permissions BLUE.Y needs to read cluster state. Write verbs are additive and clearly documented.

**Self-updating.** Deploy a new image tag to pick up a release. No database migrations, no state to transfer.

---

## Community vs. Premium

| Feature | Community | Premium |
|---|---|---|
| Multi-platform chat (Telegram, WhatsApp, Slack, Teams) | Yes | Yes |
| AI auto-diagnosis (pod crashes, OOMKill, ImagePull) | Yes | Yes |
| 24/7 monitoring — pods, nodes, HPA, TLS | Yes | Yes |
| Chat command reference (all /commands) | Yes | Yes |
| Admin dashboard (web UI) | — | Yes |
| Log Explorer (live tail, error clustering, AI analyze, NL search) | — | Yes |
| Network Explorer (route health, AI diagnose, ALB metrics) | — | Yes |
| CI/CD Pipelines (Bitbucket + GitHub, trigger + smart rebuild) | — | Yes |
| Incident log + AI postmortem + Jira integration | — | Yes |
| SSO — Google, Microsoft, GitHub OAuth | — | Yes |
| Multi-user RBAC (Viewer / Admin / Super Admin) | — | Yes |
| Signed container images + SBOM (Cosign) | — | Yes |
| IP allowlist / VPN mode | — | Yes |
| Audit log | — | Yes |
| Priority support + SLA | — | Yes |
| Seats | Up to 10 | Unlimited |

---

## Get Started

**Community** is fully open source and production-ready. Includes full chat operations and AI auto-diagnosis across all 4 platforms. No credit card, no account, no expiry.

**Premium** unlocks the full Admin Dashboard (Log Explorer, Network Explorer, CI/CD, Incidents) plus SSO, RBAC, signed images, IP allowlisting, and priority support — for teams that need a complete ops platform with compliance and auditability.

[**Get Community on GitHub →**](https://github.com/bluey-ai/blue.y) &nbsp;&nbsp; [**Talk to Us about Premium →**](mailto:hello@blueonion.today)

---

*BLUE.Y — Built for the team that runs production on Kubernetes and wants their nights back.*
