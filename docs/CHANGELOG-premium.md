# BLUE.Y Premium Changelog

> This changelog covers premium-only features. Community changelog: [CHANGELOG.md](CHANGELOG.md)
>
> **This file is Bitbucket-only — never published to GitHub.**

---

## [1.12.0] — 2026-03-17 — CI/CD Pipelines Page (BLY-75)

### Added
- **CI/CD Pipelines page** — full pipeline visibility and control without leaving the dashboard
  - Lists all repos in the Bitbucket workspace (or GitHub org) dynamically via API
  - Paginated pipeline runs per repo: build number, branch, status badge, duration, trigger, time ago
  - Status filter tabs: All / Running / Failed / Passed / Stopped
  - Click any pipeline row → expands step list with live status icons
  - Click any step → expands last 300 lines of log output inline
  - Auto-refreshes every 10s while any pipeline is running or pending
  - **Trigger Build** modal — pick a branch from the live branch list and fire a pipeline instantly
  - **Stop** button on running pipelines (Bitbucket `stopPipeline` / GitHub cancel)
  - "Open in Bitbucket/GitHub" external link on every pipeline row
  - **RBAC**: Admin + SuperAdmin can trigger and stop pipelines. Viewer gets read-only access

### Changed
- Bitbucket Smart Rebuild switched from git-push to Pipelines API trigger — no dummy commits in history
- Bitbucket token scopes simplified:
  - **Required**: `read:repository:bitbucket` + `write:pipeline:bitbucket` + `read:pipeline:bitbucket`
  - **Removed**: `write:repository:bitbucket` no longer needed
- Integration setup guide updated to reflect new scopes

---

## [1.11.0] — 2026-03-17 — Live Build Monitor + Alert Recipients + Email Templates (BLY-67/73/74)

### Added
- **Live Build Monitor** (BLY-74) — after Smart Rebuild triggers a pipeline, a live status panel replaces the static confirmation inside the Pod Detail panel
  - Polls pipeline status every 5s (8s initial delay for pipeline to appear)
  - Step-by-step list with live status icons and elapsed time
  - Click any step to expand its last 300 lines of log inline
  - Auto-stops polling on terminal state (passed / failed / stopped)
  - Supports both Bitbucket Pipelines and GitHub Actions

- **Alert Recipients** (BLY-73) — contact directory for alert routing
  - Two contact types: Internal (ops team) and Client (stakeholders)
  - Tag-based filtering — assign tags to control which alerts each recipient receives
  - Add, edit, delete recipients from the dashboard
  - Foundation for automated alert email delivery

- **Email Templates** (BLY-67) — SuperAdmin editor for all transactional emails
  - Templates: magic link login, incident alert, incident resolved, incident summary
  - Live variable preview — see `{{cluster}}`, `{{severity}}`, `{{summary}}` substitutions
  - Reset to default button per template
  - Test send — preview actual email to any address
  - Stored in ConfigMap, hot-reloaded without pod restart

---

## [1.10.0] — 2026-03-14 — Pod Management Suite (BLY-63/68/69/70)

### Added
- **Pod Detail Panel** (BLY-69) — deep-dive panel accessible from the Deployments page
  - Overview: pod phase, node, restart count, age, IP, QoS class
  - Containers: image, state, readiness, CPU/memory requests and limits
  - Environment variables (with secret masking — values truncated for safety)
  - Events: warning events with reason, count, age, message
  - Resource breakdown per container
  - Entry point for Smart Rebuild, AI Diagnosis, and Pod Terminal

- **Pod Terminal** (BLY-63) — full web-based `kubectl exec` in the browser
  - xterm.js terminal — real TTY, resize-aware
  - Container selector (for multi-container pods)
  - Shell auto-detection: `bash` → `sh` fallback
  - WebSocket tunneled through the admin API — no direct cluster access from browser
  - SuperAdmin only

- **Deployment Rollback** (BLY-68) — revision history with one-click rollback
  - Shows last 10 revision history entries per deployment
  - Per-revision: revision number, container images, replica count, age
  - Current revision highlighted
  - Rollback to any previous revision with confirmation modal
  - Requires approval if approval workflow is enabled

- **Smart Rebuild** (BLY-70) — trigger a CI pipeline rebuild from a failing pod
  - Parses ECR image tag to detect repo and branch automatically
  - Confirmation modal shows detected repo + branch before triggering
  - Works for Bitbucket Pipelines and GitHub Actions
  - Admin + SuperAdmin only

---

## [1.9.0] — 2026-03-09 — React Dashboard + SSO + RBAC + IP Allowlist + Integrations (BLY-36/50/53/55/57/58/59)

### Added
- **React Admin Dashboard** (BLY-36) — full web UI shipped in production for the first time
  - Dark GitHub-aesthetic design (navy `#0d1117` background, Tailwind CSS)
  - Overview page — cluster health summary, incident sparkline, node grid, namespace health cards
  - Incidents page — searchable timeline with severity filters, incident stats
  - Cluster page — node grid (CPU/memory/status), namespace health, live SSE stream
  - Deployments page — per-namespace deployment table with scale, restart, rollout actions
  - Log Explorer — pod/container selector, live streaming logs via SSE, log analysis
  - Users page — team management, invite flow, seat usage bar
  - Integrations page — all platform tokens configured from UI (no K8s Secret editing)
  - Config page — all ConfigMap keys editable from UI (SuperAdmin only)
  - Persistent sidebar with role badge, version, and seat count

- **SSO Login** — Microsoft Azure AD (BLY-53) and Google Workspace (BLY-54)
  - OpenID Connect via `openid-client` — industry-standard, no vendor SDK lock-in
  - Microsoft: Azure App Registration, redirect `https://<host>/admin/auth/microsoft/callback`
  - Google: GCP OAuth 2.0 credentials, redirect `https://<host>/admin/auth/google/callback`
  - SSO login button auto-appears on login page once credentials are saved in Integrations
  - JWT session (HS256, 8h), refresh token support, single-use nonce

- **SSO Invite System** (BLY-50/58) — controlled team access via email invite
  - SuperAdmin sends invite → invited user receives magic link email via SES
  - Invite flow: invite created → email sent → user clicks link → SSO login → account activated
  - Seat limit enforcement — invite blocked if at capacity
  - Invite management table: status (pending/joined), role, resend, revoke
  - Role change for existing invites (admin ↔ viewer)

- **3-Role RBAC** (BLY-57) — role-based access control across the entire dashboard
  - **SuperAdmin**: full access — Users, Integrations, Config, Email Templates, terminal, rollback
  - **Admin**: cluster ops — Deployments, Logs, Smart Rebuild, Alert Recipients, trigger CI pipelines
  - **Viewer**: read-only — Overview, Incidents, Cluster, Deployments, Logs, CI/CD view
  - Enforced both in frontend nav (hidden pages) and backend API (403 on unauthorized endpoints)

- **IP Allowlist** (BLY-55) — CIDR-based access control for the admin dashboard
  - Add/remove CIDR blocks from the Users page (SuperAdmin)
  - My IP auto-detect — one-click add your current IP
  - Blocks requests at the middleware layer before any auth check
  - Wildcard allow (`0.0.0.0/0`) when list is empty — backwards compatible

- **Integrations page** (BLY-59) — manage all credentials from the UI
  - Platforms: Telegram, Slack, MS Teams, WhatsApp, SES Email
  - SSO providers: Microsoft Azure AD, Google Workspace
  - CI/CD providers: Bitbucket, GitHub
  - Fields hidden after save (password-type inputs)
  - Test connection button per integration — live connectivity check
  - Setup guide (collapsible) per integration with step-by-step instructions
  - Read-only mode flag — surfaced when ConfigMap is managed externally

---

## [1.8.0] — 2026-03-09 — Admin Backend + Dynamic IP Mode (BLY-37/38)

### Added
- **Admin backend** (`src/admin/`) — Express REST API with ChatOps magic-link auth
  - `/admin` Telegram/Slack/Teams command → signed JWT magic link (HS256, 4h expiry, single-use nonce)
  - Admin whitelist via K8s ConfigMap `blue-y-admin-users`
  - SQLite incident log via `better-sqlite3`
  - ConfigMap hot-reload (30s polling, no pod restart needed)
  - `/incidents` command — searchable incident timeline from chat
  - VPN mode: internal ALB (`scheme: internal`) — private VPC IP, unreachable from internet

- **Dynamic IP access mode** (BLY-38) — `src/admin/dynamic-ip/`
  - Public ALB + landing-page 6-digit code challenge
  - Visit `/admin` → 6-digit code → send to Telegram/Slack bot → magic link → IP whitelisted per session
  - Session destroyed on logout or 30-minute inactivity
  - **Good for**: teams without VPN, or users on mobile

---

## Access Modes (Premium)

| Mode | How | Security |
|------|-----|----------|
| **VPN** (default) | Internal ALB, private VPC — reach via OpenVPN / Tailscale / WireGuard / AWS Client VPN | Network-layer isolation + magic-link auth |
| **Dynamic IP** | Public ALB + 6-digit code challenge + IP whitelist per session | Application-layer security only |

Config: `admin.accessMode: "vpn"` (default) or `"dynamic-ip"` in premium Helm values.

---

## Dashboard Pages — Current State (v1.12.0)

| Page | Min Role | Features |
|------|----------|---------|
| Overview | Viewer | Cluster health, incident sparkline, node grid, namespace health |
| Incidents | Viewer | Searchable incident log, severity/namespace/monitor filters, stats |
| Cluster | Viewer | Node grid (CPU/mem/status), namespace health cards, live SSE |
| Deployments | Viewer | Pod table, scale, restart, rollout — Pod Detail panel |
| Log Explorer | Viewer | Live log streaming, pod/container selector, AI log analysis |
| **CI/CD** | Viewer (R/O) | Pipeline list, step expansion, inline logs — trigger/stop requires Admin |
| Alert Recipients | Admin | Internal/client contact directory with tag-based routing |
| Email Templates | SuperAdmin | Transactional email editor, test send, reset to default |
| Users | SuperAdmin | Team management, SSO invites, seat usage, IP allowlist |
| Integrations | SuperAdmin | All credential management + connection tests + setup guides |
| Config | SuperAdmin | ConfigMap editor, hot-reload |
