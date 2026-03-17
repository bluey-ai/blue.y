# BLUE.Y Changelog

All notable changes to BLUE.Y are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.12.0] — 2026-03-17 — CI/CD Pipelines Page (BLY-75)
**Branch:** `feat/bly-74-live-build-monitor` | **Jira:** BLY-75

### Added
- **CI/CD Pipelines page** — dedicated dashboard page for full pipeline visibility and control.
  - Lists all repos in the Bitbucket workspace (or GitHub org) via API — no hardcoded repo names.
  - Shows paginated pipeline runs per repo: build number, branch, status badge, duration, trigger, time ago.
  - Status filter tabs: All / Running / Failed / Passed / Stopped.
  - Click any pipeline row to expand its step list with live status icons.
  - Click any step to expand its last 300 lines of log output inline.
  - Auto-refreshes every 10s while any pipeline is running or pending.
  - **Trigger Build** modal — pick a branch from the live branch list and fire a pipeline instantly.
  - **Stop** button on running pipelines (Bitbucket `stopPipeline` / GitHub `cancel`).
  - "Open in Bitbucket/GitHub" external link on every pipeline row.
  - **RBAC**: Admin + SuperAdmin can trigger and stop. Viewer sees read-only "View only" badge.
  - Empty state when no CI provider is configured (links to Integrations page).

### Changed
- Bitbucket token scopes updated: now requires `read:repository:bitbucket` (view repos + branches),
  `write:pipeline:bitbucket` (trigger + stop), `read:pipeline:bitbucket` (view status + logs).
  `write:repository:bitbucket` is no longer needed.
- Bitbucket rebuild method changed from git-push to direct Pipelines API trigger (no dummy commits).
- Integration setup guide updated to reflect new scopes (7 steps, no deprecated app-password warning).

---

## [1.11.0] — 2026-03-17 — Live Build Monitor (BLY-74)
**Branch:** `feat/bly-74-live-build-monitor` | **Jira:** BLY-74

### Added
- **Live Build Monitor** — after Smart Rebuild triggers a pipeline, a live status panel replaces
  the static "Pipeline queued" message inside the Pod Detail panel.
  - Polls pipeline status every 5s (8s initial delay to allow pipeline to appear).
  - Shows: build number, status badge (Pending / Running / Passed / Failed / Stopped), elapsed time.
  - Step-by-step list with live status icons (⏳ pending, 🔄 running, ✅ passed, ❌ failed).
  - Click any step to expand its last 300 lines of log output inline — no need to open Bitbucket.
  - "Open in Bitbucket / GitHub" link for the full pipeline view.
  - Auto-stops polling when pipeline reaches a terminal state (passed / failed / stopped).
  - Provider attribution footer: shows provider, workspace, repo, and branch.
- Backend `GET /api/ci/pipeline?repo=&branch=&provider=` — fetches latest pipeline run for a branch.
  - Bitbucket: `/2.0/repositories/{workspace}/{repo}/pipelines/` filtered by branch + steps.
  - GitHub: `/repos/{org}/{repo}/actions/runs?branch={branch}` + jobs endpoint.
  - Normalised response: `{ found, pipelineId, buildNumber, status, steps, url, ... }`.
- Backend `GET /api/ci/step-log?repo=&pipelineId=&stepId=&provider=` — fetches last 300 lines of
  a Bitbucket step log or GitHub Actions job log.
- Frontend `getPipelineStatus()` and `getStepLog()` API helpers + `PipelineStatus`/`PipelineStep` types.

---

## [1.10.0] — 2026-03-17 — Alert Notification Templates + Recipient Directory (BLY-73)
**Branch:** `main` | **Jira:** BLY-73

### Added
- **Alert Recipients** — new sidebar page with a universal contact directory for alert emails.
  - Add/edit/remove contacts with Name, Email, Type (Internal / Client), and Tags.
  - Stored as JSON in `blue-y-config` ConfigMap under key `alert.recipients`.
  - Type badges: Internal (blue) = staff/engineers, Client (green) = external contacts (PwC, ICBC, etc.).
  - Filter view by type; inline row editing.
  - Backend: `GET/POST/PATCH/DELETE /api/recipients` — accessible to admin+ roles.
- **Email Template: Service Alert — Triggered** (`alert-triggered`)
  - Triggered when a pod enters CrashLoopBackOff / ImagePullBackOff, or health checks fail N times.
  - Editable subject, from name, body text, footer. Variables: `{{monitor_name}}`, `{{fail_count}}`, `{{alert_description}}`, `{{triggered_at}}`.
  - Test Send button sends a sample alert to any address.
- **Email Template: Service Alert — Resolved** (`alert-resolved`)
  - Triggered when pod recovers or health checks pass consecutively.
  - Same editable fields. Variables: `{{monitor_name}}`, `{{pass_count}}`, `{{resolved_at}}`.
  - Test Send with green-theme resolved email.
- `EmailClient.buildAlertHtml()` — produces clean branded HTML email matching triggered/resolved style
  with monitor name, description, condition checklist (✅/❌), and configurable body/footer.

---

## [1.9.0] — 2026-03-17 — Smart Rebuild + CI/CD Provider Integration (BLY-70)
**Branch:** `main` | **Commits:** `b5b3ced`, `4cab12f`

### Added
- **Smart Rebuild** — when a pod's container is in `ImagePullBackOff` or `ErrImagePull`,
  a red banner appears in the Pod Detail panel with a "Rebuild Image" button.
- Rebuild modal shows detected repo, branch (editable), environment badge, and active CI provider.
- Backend `GET /api/ci/parse-image` — parses ECR image URL to repo + branch using tag format
  `{PRODUCT}-{ENV}-{40-char-SHA}` → derives branch as `ENV-PRODUCT` (e.g. `production-fund-bloconnect`).
- Backend `POST /api/ci/rebuild` — clones repo (depth 1), pushes an empty commit to trigger
  the CI pipeline. Superadmin only. Accepts `{namespace, podName}` (auto-detect) or `{repo, branch}` (manual override).
- **CI/CD Providers** — new section on the Integrations page with Bitbucket and GitHub cards.
  - Tokens + workspace/org stored in `blue-y-config` ConfigMap alongside SSO credentials.
  - `Test` button verifies token via Bitbucket `/2.0/user` or GitHub `/user` API.
  - Step-by-step setup guides for both providers.
- Supports **Bitbucket** (`x-token-auth` scheme) and **GitHub** (PAT). Auto-selects configured
  provider (Bitbucket preferred); accepts optional `provider` override in rebuild request.
- Falls back to `BB_TOKEN` env var for backward compatibility with existing deployments.
- Rebuild modal disables Confirm and shows a warning if no CI provider is configured yet.
- `Dockerfile`: added `apk add --no-cache git` to Alpine production stage (required for git push).
- Jenkins support planned for a future release.

---

## [1.8.0] — 2026-03-16 — Admin Backend — ChatOps magic-link auth (BLY-37)
**Branch:** `feat/bly-37-admin-backend`

### Added
- `src/admin/` (premium) — Express admin app mounted at `/admin` when `ADMIN_ENABLED=true`.
- `src/admin/auth.ts` — JWT HS256 magic-link generation (4h expiry, single-use nonce). Nonces
  stored in memory with TTL; consumed on first click.
- `src/admin/config-watcher.ts` — K8s ConfigMap `blue-y-admin-users` polling every 30s.
  Hot-reloads admin whitelist without pod restart.
  Format: `platform:userId:Display Name` (e.g. `telegram:123456789:Zeeshan Ali`).
- `src/admin/db.ts` — SQLite incident log via `better-sqlite3` (WAL mode, indexed).
  Schema: `id, ts, severity, namespace, pod, monitor, title, message, ai_diagnosis`.
- `src/admin/routes/incidents.ts` — `GET /admin/api/incidents` with filtering by severity,
  namespace, monitor, and full-text search. `GET /admin/api/incidents/:id`.
- `src/admin/routes/config.ts` — `GET /admin/api/config` returns live admin whitelist.
- `src/admin/routes/cluster.ts` — `GET /admin/api/cluster/status|pods|nodes` — live K8s data.
- `/admin` Telegram command — checks whitelist, generates magic link, sends as DM (not channel).
  Community builds receive a "premium feature" message instead of crashing.
- `Dockerfile.premium` — premium image build with native build tools for `better-sqlite3`.
  Includes `/data` volume for SQLite persistence.
- `helm/blue-y-premium/` — premium Helm chart: `Chart.yaml`, `values.yaml`, ingress template
  (internal ALB for VPN mode), `blue-y-admin-users` ConfigMap template.
- `.github-sync-ignore` — added `.bitbucket/` and `Dockerfile.premium` (internal files that
  should never appear on GitHub).

### Changed
- `src/config.ts` — added `admin` config block: `enabled`, `jwtSecret`, `host`,
  `sessionTtlHours`, `dbPath` (all via env vars).
- `src/main.ts` — dynamic `require('./admin')` at startup (try/catch — safe for community builds).
  Admin Express app mounted at `/admin` only when `ADMIN_ENABLED=true` + secrets present.

### Dependencies
- Added `better-sqlite3 ^9.4.3`, `cookie-parser ^1.4.7`, `jsonwebtoken ^9.0.2`.
- Added dev types: `@types/better-sqlite3`, `@types/cookie-parser`, `@types/jsonwebtoken`.

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
