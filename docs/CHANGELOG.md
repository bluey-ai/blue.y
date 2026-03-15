# BLUE.Y Changelog

All notable changes to BLUE.Y are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
