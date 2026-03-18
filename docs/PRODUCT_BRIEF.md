# BLUE.Y

### Your AI Ops Teammate — Always Watching, Always Ready.

`Community — Open Source` &nbsp;&nbsp; `Premium — Enterprise-Ready`

---

BLUE.Y is a self-hosted, AI-native Kubernetes operations platform. It combines 24/7 cluster monitoring, AI-powered auto-diagnosis, a full-featured admin dashboard, and multi-platform chat operations into a single container that runs inside your cluster — so your data never leaves it.

Built for DevOps and platform engineering teams running production EKS, GKE, or AKS.

---

## By the Numbers

| 2 min | 4 | 6 | 5 min |
|---|---|---|---|
| Pod crash detection | Chat platforms | Dashboard modules *(Premium)* | Time to deploy |

---

## Feature Highlights

**AI Auto-Diagnosis**
- Detects pod failures, OOMKills, and CrashLoopBackOffs within 2 minutes
- Automatically gathers describe + logs + events → AI root-cause + fix delivered to chat

**Log Explorer**
- Live tail, snapshot mode, keyword filter, and one-click `.txt` download
- Error clustering groups similar stack traces by pattern with frequency counts; AI Analyze and Natural Language Search included

**Network Explorer**
- Route health walks every ingress → service → endpoint chain with green/yellow/red status and exact breakpoint identification
- Live ALB CloudWatch metrics (requests, 4xx/5xx, latency, error rate) + AI route diagnosis

**CI/CD Pipelines**
- Bitbucket Pipelines and GitHub Actions — monitor, view build logs, trigger builds, and stop runs
- Smart Rebuild auto-detects repo + branch from ECR image tag for one-click retrigger

**Incident Management**
- Full incident history with severity, AI diagnosis, and resolution status
- `/postmortem` generates structured reports (timeline, root cause, action items); Jira ticket creation built in

**Security & Safety**
- RBAC: Viewer / Admin / Super Admin; SSO via Google, Microsoft, GitHub (Premium)
- AI prompt sanitization strips credentials before any data leaves the cluster
- Hardcoded blocks on PVC delete, namespace delete, node drain/cordon — not overridable

---

## Integrations

DeepSeek AI &nbsp;·&nbsp; AWS Bedrock &nbsp;·&nbsp; AWS CloudWatch &nbsp;·&nbsp; AWS SES &nbsp;·&nbsp; Bitbucket &nbsp;·&nbsp; GitHub &nbsp;·&nbsp; Jira &nbsp;·&nbsp; Telegram &nbsp;·&nbsp; WhatsApp &nbsp;·&nbsp; Slack &nbsp;·&nbsp; Microsoft Teams

---

## Community vs. Premium

| Feature | Community | Premium |
|---|---|---|
| All 4 chat platforms | ✓ | ✓ |
| AI auto-diagnosis | ✓ | ✓ |
| 24/7 monitoring (pods, nodes, HPA, TLS) | ✓ | ✓ |
| All chat /commands incl. /diagnose, /postmortem | ✓ | ✓ |
| Jira & email notifications | ✓ | ✓ |
| Self-hosted — data stays in your cluster | ✓ | ✓ |
| **Admin Dashboard (web UI — all 6 modules)** | — | ✓ |
| Log Explorer, Network Explorer, CI/CD | — | ✓ |
| Incident log + AI postmortem + Jira dashboard | — | ✓ |
| SSO (Google / Microsoft / GitHub) | — | ✓ |
| Multi-user RBAC | — | ✓ |
| Signed images + SBOM (Cosign) | — | ✓ |
| IP allowlist / VPN mode | — | ✓ |
| Audit log | — | ✓ |
| Priority support + SLA | — | ✓ |

---

## Deploy

```bash
# kubectl
kubectl apply -f https://bluey.ai/install/latest.yaml

# Helm
helm repo add bluey https://charts.bluey.ai && helm install blue-y bluey/blue-y -n prod
```

256Mi RAM / 100m CPU at idle. IRSA-ready. Read-only ClusterRole. No agents. No external database.

---

**bluey.ai** &nbsp;·&nbsp; github.com/bluey-ai/blue.y &nbsp;·&nbsp; hello@blueonion.today
