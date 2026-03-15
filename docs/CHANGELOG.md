# BLUE.Y Changelog

---

## [1.2.0] — 2026-03-15 — Slack integration (BLY-3)
**Branch:** `feat/hubs-6133-slack-notifier`

### Added
- `SlackNotifier` (`src/clients/notifiers/slack.ts`) — outbound messages via `@slack/web-api`.
  Wired into `NotifierRouter` alongside `TelegramNotifier` — all monitor alerts now fan out
  to both Telegram and Slack simultaneously when `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` set.
  Converts Telegram HTML tags (`<b>`, `<code>`, `<pre>`) to Slack mrkdwn automatically.
- `startSlackBot` (`src/slack-bot.ts`) — Socket Mode inbound command handler via `@slack/bolt`.
  Listens for `@BLUE.Y` mentions, DMs, and `/bluey` slash commands.
  Supports: `status`, `check`, `nodes`, `load`, `help`.
  Administrative commands (restart, scale, etc.) remain Telegram-only until full platform
  refactor (future BLY ticket).

### Config
- `SLACK_BOT_TOKEN` (xoxb-...) — enables outbound Slack alerts
- `SLACK_CHANNEL_ID` — channel to post alerts to
- `SLACK_APP_TOKEN` (xapp-...) — enables Socket Mode inbound commands

---

All notable changes to BLUE.Y are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.2.0] — 2026-03-15 — Helm chart (BLY-7)
**Branch:** `feat/bly-7-helm-chart`

### Added
- `helm/blue-y/` — full Helm chart for community deployment.
  - `Chart.yaml` — version 1.2.0, appVersion 1.2.0
  - `values.yaml` — all config as values with sane defaults and inline comments
  - `templates/deployment.yaml` — full Deployment with all env vars templated
  - `templates/secret.yaml` — chart-managed Secret (skipped if `existingSecret.name` set)
  - `templates/serviceaccount.yaml` — SA with optional IRSA annotation
  - `templates/clusterrole.yaml` — RBAC rules (read + patch deployments/scale)
  - `templates/clusterrolebinding.yaml`
  - `templates/service.yaml` — ClusterIP service on port 80 → 8000
  - `templates/_helpers.tpl` — standard Helm helper templates
- `existingSecret.name` value: point to a pre-existing K8s Secret instead of creating one
- IRSA support via `serviceAccount.irsaRoleArn` annotation
- Optional integrations (Slack, Teams, Jira, Grafana, Loki, Bitbucket, WAF) only emit
  env vars when their values are non-empty — no noise for unused features

### Install
```bash
helm install blue-y bluey/blue-y \
  --set ai.apiKey=$AI_API_KEY \
  --set telegram.botToken=$BOT_TOKEN \
  --set telegram.chatId=$CHAT_ID \
  --set kube.clusterName=my-cluster \
  --set kube.awsRegion=us-east-1 \
  --namespace monitoring --create-namespace
```

---

## [1.1.1] — 2026-03-15 — Fix node group detection by EKS label
**Branch:** `fix/hubs-6130-node-group-label` | **Jira:** HUBS-6130

### Fixed
- `load.ts` `getNodeGroupStates()` now reads the actual `eks.amazonaws.com/nodegroup`
  label from each node's K8s metadata instead of guessing by memory threshold
  (was: `memMi > 12_000 → backend_highmem`, else `spot_nodes`).
- `kube.ts` adds `getNodeGroupMap()` — single K8s API call returning node-name →
  `{ nodeGroup label, allocatableCpuMilli }` derived from real node spec.
- EKS `DescribeNodegroupCommand` now fetches actual `min/max/desired` per group at
  runtime instead of using hardcoded values.
- Allocatable CPU per node comes from `node.status.allocatable.cpu` (real spec) instead
  of hardcoded 8000m / 4000m constants.
- Root cause: the old code worked by coincidence as long as node types never changed.
  Any future node type change (resize, replace, new group) would silently misclassify nodes.

---

## [1.1.0] — 2026-03-14 — Community Foundations (BLY-16)
**Branch:** `feat/community-tier1-foundations`

### Changed
- Genericized entire codebase — removed all BlueOnion-specific hardcoded values.
- All org-specific config (cluster name, RDS endpoints, URLs, Jira project, team emails,
  Bitbucket repos, WAF ACL name) now comes from env vars / K8s Secrets at runtime.
- BlueOnion production config lives in `deploy/deployment_blueonion.yaml` + `blue-y-secrets`.
- Any organization can now deploy BLUE.Y by filling in their own env vars.
- Pipeline uses `TAG=blueonion` to apply `deployment_blueonion.yaml` (not the generic template).

### Fixed
- TypeScript error in `qa.ts` — `endpoint` parameter lost type after `productionUrls` became
  `JSON.parse(...)` returning `any[]`. Added explicit type annotation.
- Teams client crash on startup when `TEAMS_APP_ID` set but `TEAMS_TENANT_ID` empty.
  Guard now checks both `!config.teams.enabled` and `!config.teams.tenantId`.
- YAML parse errors in `deployment_blueonion.yaml` — JSON array/object values rewritten
  as single-line strings (multi-line single-quoted YAML breaks on `[` and `{`).
- `LOAD_WATCH_LIST` missing threshold fields (`memLimitMB`, `memWarnMB`, `memCritMB`,
  `cpuWarnPct`, `nodeGroup`, `nodeGroupFull`) caused false "undefined limits" AI alerts.
- WAF monitoring `AccessDeniedException` — added `wafv2:*` permissions to `BlueYBedrockRole`
  via Terraform (`blue-y-irsa.tf`).

---

## [1.0.0] — 2026-03-09 — Initial production deployment
**Jira:** HUBS-6116

### Added
- BLUE.Y AI ops assistant deployed to EKS prod namespace.
- Telegram bot interface for 24/7 cluster monitoring.
- Pod, node, cert, HPA monitors (2min / 5min / 6hr / 5min intervals).
- Auto-diagnose: critical pod issues → DeepSeek AI analysis → Telegram report.
- Commands: /status /check /nodes /resources /hpa /doris /logs /logsearch /describe
  /events /deployments /rollout /diagnose /restart /scale /email /jira /incidents
  /sleep /wake /load /help
- Load monitor with threshold-based and AI-driven replica scaling.
- Pre-business hours scale-up (8:15–8:45 AM SGT Mon–Fri).
- AWS integrations: SES email, WAF read/block, CloudWatch, RDS, Glue, EMR, Cost Explorer.
- IRSA: `BlueYBedrockRole` for Bedrock Claude model invocation.
- RBAC: `blue-y-readonly` ClusterRole (pods/nodes/deployments/events + autoscaling + metrics).
