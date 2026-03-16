# BLUE.Y Roadmap

> AI ops assistant for Kubernetes — 24/7 monitoring, auto-diagnosis & incident response via Telegram, Slack, or Teams.

This roadmap reflects our current direction. Priorities may shift based on community feedback.
**Want to influence what gets built?** [Open an issue](https://github.com/bluey-ai/blue.y/issues) or 👍 existing ones.

---

## ✅ v1.0 – v1.3 — Foundation *(shipped)*

- Pod, node, HPA, certificate monitoring
- Auto-diagnosis on pod failure (AI analysis → Telegram alert)
- Telegram, Slack (Socket Mode), MS Teams, WhatsApp support
- `/restart`, `/scale`, `/logs`, `/describe`, `/events`, `/diagnose`
- Jira integration — auto-create tickets on critical incidents
- Loki log aggregation in diagnostics
- AWS WAF monitoring & auto-block
- Database pipeline monitoring
- Bitbucket CI/CD triggers via chat
- Grafana integration
- Security scanner (`/scan`)
- Load monitor with AI-driven auto-scaling hints

---

## ✅ v1.4 — Community Launch *(current)*

- Helm chart published to [ArtifactHub](https://artifacthub.io/packages/helm/bluey/blue-y)
- Public Docker image on GHCR (`ghcr.io/bluey-ai/blue.y`)
- GitHub Actions: CI, GHCR publish, community deploy workflow
- Step-by-step setup guide (`docs/deploy.md`)
- Post-install UX (Helm NOTES.txt)
- Open-source foundations: LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT
- Community genericized codebase (no internal references)

---

## 🔄 v1.5 — Multi-cloud & Polish *(next)*

**Goal: works on any Kubernetes cluster, not just EKS.**

- [ ] SMTP email support — alternative to AWS SES (for GKE/AKS/bare metal users)
- [ ] GKE deployment guide (Workload Identity, `gcloud` kubeconfig)
- [ ] AKS deployment guide (Azure Workload Identity, `az` kubeconfig)
- [ ] Bare metal / k3s / RKE2 deployment guide
- [ ] `/waf` gracefully handles non-AWS clusters ("AWS-only feature")
- [ ] Community vs Pro feature tier gating
- [ ] `KUBE_CONTEXTS` — monitor multiple namespaces per cluster
- [ ] Prometheus `/metrics` endpoint

---

## 📅 v1.6 — Stickiness & Virality *(planned)*

**Goal: make users want to show it off.**

- [ ] **Uptime streaks** — "🔥 14-day incident-free streak!" in daily digest
- [ ] **Weekly SRE digest** — every Monday: incidents resolved, avg MTTR, uptime %, top recurring issue. Shareable screenshot.
- [ ] **Auto-generated postmortems** — `/postmortem <incident-id>` — AI writes full postmortem doc (timeline, root cause, action items) from incident history
- [ ] **"Caught by BLUE.Y" log** — `/incidents` shows a history of what BLUE.Y caught before the team noticed, with resolution time
- [ ] **SRE score** — weekly score (0-100) based on MTTR, incident frequency, uptime. Trends over time.
- [ ] **`monitored-by-blue-y` README badge** — viral badge for repos: `![Monitored by BLUE.Y](https://img.shields.io/badge/monitored%20by-BLUE.Y-blue)`

---

## 📅 v2.0 — Intelligence *(planned)*

**Goal: from reactive to predictive.**

- [ ] **Predictive alerts** — memory/CPU trend analysis: "Pod X will OOM in ~6 hours at current growth rate"
- [ ] **Cost insights** — node utilization analysis: "This node is 18% utilized — right-size to save ~$140/month"
- [ ] **Blast radius simulation** — `/simulate <pod> down` — AI maps what services break if that pod fails
- [ ] **Anomaly detection** — baseline normal behavior per pod/service, alert on statistical deviations
- [ ] **Runbook auto-suggest** — match incident patterns to relevant runbooks, surface them in alerts
- [ ] **Multi-cluster support** — monitor multiple clusters from one bot instance (`KUBE_CONTEXTS`)
- [ ] **Plugin/monitor marketplace** — community-contributed monitors (RabbitMQ, Redis, MongoDB, PostgreSQL)

---

## 🔮 v2.5 — Pro Tier *(future)*

**Goal: teams and enterprises pay for this.**

- [ ] **Multi-cluster web dashboard** — browser UI showing all clusters, incidents, health at a glance
- [ ] **On-call rotation** — `/oncall @john next 3 days` — BLUE.Y routes alerts to whoever is on-call
- [ ] **SLA reports** — `/report monthly` — PDF with uptime, incidents, MTTR for management/clients
- [ ] **Historical incident search** — `/incidents search OOMKilled last 30 days`
- [ ] **PagerDuty integration** — trigger PD incidents from BLUE.Y alerts
- [ ] **OpsGenie integration** — on-call alert routing
- [ ] **GitHub Issues integration** — auto-create GH issues on incidents (for non-Jira teams)
- [ ] **Linear integration** — incident tracking for modern teams

---

## 🚀 Distribution *(ongoing)*

- [ ] AWS Marketplace EKS Add-on (BLY-5)
- [ ] Slack App Directory (BLY-6)
- [ ] Microsoft Teams AppSource (BLY-7)
- [ ] Google Cloud Marketplace (BLY-8)
- [ ] Azure Marketplace (BLY-9)
- [ ] Atlassian Marketplace (BLY-10)
- [ ] Docker Hub Verified Publisher (BLY-11)
- [ ] CNCF Landscape listing (BLY-12)
- [ ] Terraform Registry module (BLY-13)
- [ ] Product Hunt launch (BLY-14)

---

## 💬 Community

- **Issues & feature requests**: [github.com/bluey-ai/blue.y/issues](https://github.com/bluey-ai/blue.y/issues)
- **Discussions**: [github.com/bluey-ai/blue.y/discussions](https://github.com/bluey-ai/blue.y/discussions)
- **Security**: [SECURITY.md](SECURITY.md)

Roadmap updated: March 2026
