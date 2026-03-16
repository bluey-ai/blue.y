# BLUE.Y Changelog

All notable changes to BLUE.Y are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.7.1] — 2026-03-16 — Community vs Premium tier definitions (BLY-39)
**Branch:** `feat/bly-39-community-premium-split`

### Added
- `README.md` — "Community vs Premium" section: clear feature tier table, licensing model
  explanation, and contact details for premium inquiries.
- `docs/CHANGELOG-premium.md` — dedicated premium changelog (Bitbucket-only). Tracks premium
  releases separately from the community changelog. Includes planned v1.8.0 and v2.0.0 roadmap.

---

## [1.7.0] — 2026-03-16 — SMTP email support (BLY-22)
**Branch:** `feat/bly-22-smtp-email`

### Added
- SMTP transport support via `nodemailer` — BLUE.Y can now send incident emails on GKE, AKS,
  bare-metal, or any cloud where AWS SES is unavailable.
- Auto-detection: if `SMTP_HOST` env var is set, SMTP is used; otherwise falls back to AWS SES
  (fully backwards-compatible — existing EKS+SES deployments require no changes).
- New Helm `email.smtp.*` values: `host`, `port`, `secure`, `user`, `pass`.
  SMTP credentials stored in K8s Secret (`smtp-user`, `smtp-pass` keys, both optional).
- `.env.example` updated with Option A (SMTP) / Option B (SES) sections.
- `src/config.ts` — `config.email.smtp` block.

### Changed
- `helm/blue-y/values.yaml` — `emailFrom` renamed to `email.from` (nested under `email:`).
  **Migration**: replace `emailFrom: "..."` with `email.from: "..."` in your override file.
- `helm/blue-y/templates/deployment.yaml` — `EMAIL_FROM` now reads from `email.from`;
  `SMTP_*` env vars injected conditionally when `email.smtp.host` is set.
- `helm/blue-y/templates/secret.yaml` — `smtp-user` and `smtp-pass` keys added.

### Dependencies
- Added `nodemailer: ^8.0.2` (runtime), `@types/nodemailer: ^7.0.11` (dev).

---

## [1.6.0] — 2026-03-16 — Security Hardening (BLY-35)
**Branch:** `feat/bly-35-security-hardening`

### Added
- `src/utils/sanitize.ts` — `sanitizeForAI()`: 13-pattern regex injection scanner applied to all
  cluster data (logs, events, pod descriptions) before it reaches the AI API. Suspicious lines are
  redacted, input is truncated at 4,000 chars, and HTML angle brackets are escaped.
  `sanitizeLabel()`: strips non-safe characters from user-supplied labels/names.
- `docs/security-architecture.md` — full threat model covering 7 attack surfaces: supply chain,
  prompt injection, RBAC, container hardening, secret zero, network exposure, and AI API security.
- `.github/dependabot.yml` — automated weekly PRs for npm packages, Docker base image, and GitHub
  Actions versions.
- **gitleaks** secret scanning job in `.github/workflows/ci.yml` — blocks PRs that accidentally
  commit API keys, tokens, or credentials.
- **Docker Scout** vulnerability scan in CI — warns on critical/high CVEs in every Docker build.
- **cosign keyless image signing** (Sigstore) — every GHCR release tag is signed; users can verify
  authenticity with `cosign verify`.
- **SBOM generation** (`anchore/sbom-action`) — SPDX JSON Software Bill of Materials attached as
  release artifact for every version tag.
- Container `securityContext` in Helm deployment: `readOnlyRootFilesystem: true`, `runAsNonRoot: true`,
  `runAsUser: 1000`, `allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`. `/tmp` is
  provided as an in-memory `emptyDir` volume.

### Changed
- `src/clients/bedrock.ts` — `SYSTEM_PROMPT_CORE` hardened with absolute security constraint
  instructing the AI to never act on instructions found in analyzed cluster data. `buildPrompt()`
  now applies `sanitizeForAI()` to `request.message` and all string values in `request.context`
  before constructing the AI prompt.
- `.github/workflows/ci.yml` — added secret-scan, Docker Scout, cosign, and SBOM steps to the
  existing build + publish pipeline.
- `SECURITY.md` — new "Prompt Injection Mitigation" section documenting the two-layer defence.

---

## [1.4.0] — 2026-03-15 — Community Quality Standards (BLY-17)
**Branch:** `feat/bly-17-fresh`

### Added
- `docker-compose.yml` — run BLUE.Y locally without an EKS cluster. Mounts `~/.kube/config`
  for cluster access. Includes a `dev` profile with `ts-node` live reload for contributors.
- `.bitbucket/PULL_REQUEST_TEMPLATE.md` — standardised PR checklist: change type, testing steps,
  and a reminder that `bitbucket-pipelines.yml` must never be pushed to the public GitHub repo.
- `assets/blue-y.svg` — official BLUE.Y logo: navy hexagon + lightning bolt + eye icon.
  Required for CNCF Landscape submission (BLY-12).

### Fixed
- `src/main.ts` — added `SIGTERM`/`SIGINT` graceful shutdown handler. On pod termination:
  stops all monitor cron jobs, closes the HTTP server, then exits cleanly within 8 seconds.
  Prevents mid-message truncation and `CrashLoopBackOff` noise during rolling deploys.

---

## [1.3.0] — 2026-03-15 — GitHub open-source release (BLY-4)
**Branch:** `feat/bly-4-github-opensource`

### Added
- `.github/workflows/ci.yml` — GitHub Actions CI: TypeScript type-check + build + Docker build on every push/PR.
- `.github/ISSUE_TEMPLATE/bug_report.yml` — Structured bug report template.
- `.github/ISSUE_TEMPLATE/feature_request.yml` — Feature request template.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.

### Changed
- `LICENSE` — switched from MIT to **Apache 2.0** (explicit patent grant; better for enterprise adoption).
- `README.md` — full rewrite: Mermaid architecture diagram, Quick Start (Helm + raw K8s + local dev),
  full configuration reference, architecture diagram, RBAC summary, safety section.
- `CONTRIBUTING.md` — updated license reference (MIT → Apache 2.0); GitHub Discussions link.
- `bitbucket-pipelines.yml` — removed hardcoded internal account ID; switched to `${AWS_ACCOUNT_ID}` variable.

### Fixed
- `src/clients/bedrock.ts`, `src/clients/db-agents.ts`, `src/main.ts` — removed all BlueOnion-specific
  table names, schema references, and org-specific example values from source code and help text.
- `deploy/deployment_blueonion.yaml` — removed from community repo (contains org-specific production values;
  belongs in a private infrastructure repo per the file's own comment).

---

## [1.2.0] — 2026-03-15 — Slack integration + Helm chart (BLY-3 + BLY-7)
**Branches:** `feat/hubs-6133-slack-notifier`, `feat/bly-7-helm-chart`

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

### Config
- `SLACK_BOT_TOKEN` (xoxb-...) — enables outbound Slack alerts
- `SLACK_CHANNEL_ID` — channel to post alerts to
- `SLACK_APP_TOKEN` (xapp-...) — enables Socket Mode inbound commands

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
