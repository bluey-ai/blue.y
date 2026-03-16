# BLUE.Y Premium Changelog

> This changelog covers premium-only features. Community changelog: [CHANGELOG.md](CHANGELOG.md)
>
> **This file is Bitbucket-only — never published to GitHub.**

---

## [Unreleased] — Admin Dashboard (BLY-37, BLY-38, BLY-36)

### Planned for v1.8.0

- **Admin backend** (`src/admin/`) — Express REST API with ChatOps magic-link auth
  - `/admin` Telegram command → signed JWT magic link (HS256, 4h expiry, single-use nonce)
  - Admin whitelist via K8s ConfigMap `blue-y-admin-users`
  - SQLite incident log via `better-sqlite3`
  - ConfigMap hot-reload (30s polling, no pod restart needed)
  - `/incidents` command — searchable incident timeline from chat
  - VPN mode: internal ALB (`scheme: internal`) — private VPC IP, unreachable from internet
- **Dynamic IP access mode** (`src/admin/dynamic-ip/`) — BLY-38
  - Public ALB + landing-page 6-digit code challenge
  - Visit `/admin` → 6-digit code → send to Telegram bot → magic link → IP whitelisted per session
  - Session destroyed on logout or 30-minute inactivity

### Planned for v2.0.0

- **React admin dashboard** (`frontend/`) — BLY-36
  - Cluster topology view — live pod/node graph
  - Real-time monitoring panels — CPU, memory, HPA pressure
  - Incident timeline UI — searchable SQLite log
  - Config editor — hot-reload without pod restart
  - BLUE.Y branding — navy/blue Command Center aesthetic

---

## Access Modes (Premium)

| Mode | How | Security |
|------|-----|----------|
| **VPN** (default) | Internal ALB, private VPC — reach via OpenVPN / Tailscale / WireGuard / AWS Client VPN | Network-layer isolation + magic-link auth |
| **Dynamic IP** | Public ALB + 6-digit code challenge + IP whitelist per session | Application-layer security only |

Config: `admin.accessMode: "vpn"` (default) or `"dynamic-ip"` in premium Helm values.

---

*No premium releases yet — first release will be v1.8.0.*
