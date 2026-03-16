# BLUE.Y — Premium Architecture & Build Separation

> Version: 1.6.0+ | BLY-41

---

## Overview

BLUE.Y ships as **two separate Docker images** built from the same Bitbucket repository:

| | Community | Premium |
|---|---|---|
| **Source** | Bitbucket (stripped) → GitHub | Bitbucket (full) |
| **Image** | `ghcr.io/bluey-ai/blue.y` | Private ECR (BlueOnion customers) |
| **Helm chart** | `helm/blue-y/` (ArtifactHub, public) | `helm/blue-y-premium/` (private) |
| **Admin panel** | ❌ Code does not exist | ✅ `admin.enabled: true` |
| **Cost** | Free, open-source | Paid |

---

## The Two-Image System

```
┌──────────────────────────────────────────────────────────────────────┐
│                   BITBUCKET (private — source of truth)              │
│   Full codebase: src/monitors/ + src/clients/ + src/admin/ + ...     │
│   Branch: main                                                        │
└──────────────┬───────────────────────────────────────┬───────────────┘
               │                                       │
               │ scripts/sync-to-github.sh             │ Bitbucket Pipelines
               │ (manual, before each release)         │ (auto on push to main)
               ▼                                       ▼
┌──────────────────────────┐           ┌───────────────────────────────┐
│  github.com/bluey-ai     │           │  ECR: 716156543026.dkr.ecr... │
│  blue.y (PUBLIC)         │           │  blue.y:production-* (PRIVATE) │
│                          │           │                               │
│  src/admin/  → STRIPPED  │           │  src/admin/  → PRESENT ✅    │
│  frontend/   → STRIPPED  │           │  frontend/   → PRESENT ✅    │
│                          │           │                               │
│  GitHub Actions builds:  │           │  Pipeline builds:             │
│  ghcr.io/bluey-ai/       │           │  Full premium image           │
│  blue.y:vX.X (public)   │           │  for paying customers         │
└──────────────────────────┘           └───────────────────────────────┘
               │                                       │
               ▼                                       ▼
┌──────────────────────────┐           ┌───────────────────────────────┐
│  COMMUNITY USER           │           │  PREMIUM USER                 │
│                          │           │                               │
│  helm install blue-y     │           │  Receives from BlueOnion:     │
│    bluey-ai/blue-y       │           │  - ECR pull credentials       │
│                          │           │  - values.yaml (admin section) │
│  /admin → 404            │           │                               │
│  (code absent)           │           │  /admin → works ✅            │
│                          │           │  (code present + enabled)     │
└──────────────────────────┘           └───────────────────────────────┘
```

---

## What is "Premium" Code?

Defined in `.github-sync-ignore` at the repo root. Current premium paths:

| Path | Feature | Ticket |
|------|---------|--------|
| `src/admin/` | Admin backend — magic link auth, REST API, config editor, SQLite | BLY-37 |
| `frontend/` | React admin dashboard — cluster topology, real-time monitoring | BLY-36 |
| `helm/blue-y-premium/` | Premium Helm chart (includes ingress, admin config) | BLY-37 |
| `docs/premium/` | Premium documentation (setup guides, skip-reference) | BLY-40 |
| `docs/CHANGELOG-premium.md` | Premium release notes | BLY-40 |

---

## How License Enforcement Works

### Phase 1 — Now (code separation)

The enforcement is **the code not existing** in the community image.

```
Community user downloads ghcr.io/bluey-ai/blue.y:v1.7
→ src/admin/ was never built into this image
→ Express has no /admin route registered
→ Visiting /admin returns 404
→ No amount of config changes enables it — the code literally isn't there
```

**This is unbypassable.** There is no flag to flip, no license key to forge.

### Phase 2 — Future (cryptographic license key)

For enterprise customers who need per-seat control, expiry, and feature gating:

```
BlueOnion generates (offline, with private key):
  {
    "customer": "Acme Corp",
    "email": "ops@acme.com",
    "expiry": "2027-01-01",
    "features": ["admin", "dynamic-ip", "multi-tenant"]
  }
  → signed with BlueOnion's RSA private key → BLUE_Y_LICENSE_KEY env var

BLUE.Y validates on startup:
  jwt.verify(process.env.BLUE_Y_LICENSE_KEY, BLUEY_PUBLIC_KEY)
  → valid: premium features available per the features[] array
  → expired: features disabled, warning message in bot
  → missing: community mode, admin routes inactive
```

No internet required. Works air-gapped. Key stays in K8s Secret.

---

## Access Modes (Premium Only)

Premium users choose one access mode for the admin dashboard:

### VPN Mode (default — recommended)

```yaml
# helm/blue-y-premium/values.yaml
admin:
  enabled: true
  accessMode: "vpn"
```

- Internal ALB (`alb.ingress.kubernetes.io/scheme: internal`)
- Only reachable from within the VPC
- Requires VPN: **OpenVPN, Tailscale, WireGuard, AWS Client VPN — any works**
- Auth: magic link sent via Telegram/Slack/Teams → click → session
- **Most secure**: network-layer isolation + application-layer auth

### Dynamic IP Mode (premium — no VPN required)

```yaml
admin:
  enabled: true
  accessMode: "dynamic-ip"
```

- Public ALB (internet-facing)
- Admin visits `/admin` → gets a 6-digit code → sends to Telegram bot → receives magic link
- IP dynamically whitelisted per session, destroyed on logout
- **Good for**: teams without VPN, or users on mobile
- **Trade-off**: application-layer security only (no network isolation)

---

## Developer Workflow

### Day-to-day development (everyone)

```bash
# All work happens on Bitbucket — push to origin only
git push origin feature/my-branch

# Never push directly to GitHub remote
# The pre-push hook will block you if you try
```

### Releasing a community edition to GitHub

```bash
# Install the hook once per machine (do this first):
./scripts/install-hooks.sh

# When ready to release (on main, clean working tree):
./scripts/sync-to-github.sh

# Preview what would be stripped (no push):
./scripts/sync-to-github.sh --dry-run
```

### The sync script does this internally:

```
1. Validates: must be on main, clean working tree, github remote exists
2. Clones current HEAD into a temp directory
3. Reads .github-sync-ignore, strips every listed path
4. Commits: "chore: community release vX.X (abc1234) — premium features stripped"
5. Force-pushes to github remote main branch
6. Cleans up temp directory
```

Force-push is intentional — Bitbucket main includes premium commits that will never exist on GitHub. The histories legitimately diverge.

### Anti-leak protection (pre-push hook)

Installed by `scripts/install-hooks.sh`. Runs automatically on every `git push`:

```
If pushing to github.com:
  → Scans tracked files against .github-sync-ignore
  → If any premium path present → BLOCKED with clear error
  → Tells you to use sync-to-github.sh instead

If pushing to origin (Bitbucket):
  → Hook does nothing, push proceeds normally
```

---

## Premium Customer Onboarding

When a customer purchases premium:

1. **Give them ECR pull access:**
   ```bash
   # Add their AWS account to the ECR repo policy
   # OR generate a long-lived ECR token and send securely
   ```

2. **Send them the premium Helm chart:**
   ```bash
   # From helm/blue-y-premium/ (never published to ArtifactHub)
   helm package helm/blue-y-premium/
   # Send the .tgz or host on a private OCI registry
   ```

3. **Send them a sample values.yaml** with admin section pre-filled

4. **Point them to** `docs/premium/SETUP-GUIDE.md` (private docs)

---

## What Goes Where — Quick Reference

| File/Directory | Bitbucket | GitHub | Notes |
|---|---|---|---|
| `src/monitors/` | ✅ | ✅ | Community |
| `src/clients/` | ✅ | ✅ | Community |
| `src/admin/` | ✅ | ❌ | Premium — BLY-37 |
| `frontend/` | ✅ | ❌ | Premium — BLY-36 |
| `helm/blue-y/` | ✅ | ✅ | Community Helm chart |
| `helm/blue-y-premium/` | ✅ | ❌ | Premium Helm chart |
| `docs/CHANGELOG.md` | ✅ | ✅ | Community changelog |
| `docs/CHANGELOG-premium.md` | ✅ | ❌ | Premium changelog |
| `docs/premium/` | ✅ | ❌ | Premium docs |
| `docs/security-architecture.md` | ✅ | ✅ | Community |
| `.github-sync-ignore` | ✅ | ✅ | Safe to expose (just a list) |
| `scripts/sync-to-github.sh` | ✅ | ✅ | Safe to expose (transparency) |
| `hooks/pre-push` | ✅ | ✅ | Safe to expose |
| `bitbucket-pipelines.yml` | ✅ | ❌ | Internal CI/CD, stays private |

---

## Adding New Premium Features (checklist)

When creating a new premium feature:

- [ ] Code lives under an excluded path (`src/admin/`, `frontend/`, etc.)
  OR add its path to `.github-sync-ignore`
- [ ] File has `// @premium — BlueOnion internal only.` header comment
- [ ] Feature disabled gracefully when not configured (never crashes BLUE.Y)
- [ ] Module doc created in `docs/premium/modules/` (see BLY-40 template)
- [ ] `docs/premium/SETUP-GUIDE.md` updated with new module
- [ ] `docs/premium/SKIP-REFERENCE.md` updated
- [ ] Run `./scripts/sync-to-github.sh --dry-run` to verify path is excluded
