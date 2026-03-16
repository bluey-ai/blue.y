# Contributing to BLUE.Y

Thank you for your interest in contributing! BLUE.Y is an open-core project — the core monitoring engine is Apache 2.0-licensed and community-driven.

## Getting Started

```bash
git clone https://github.com/bluey-ai/blue.y.git
cd blue.y
npm install
cp .env.example .env   # fill in your values
npm run dev            # starts with ts-node (no build needed)
```

Requirements: Node.js 22+, kubectl configured, a running Kubernetes cluster.

## Branch Naming

| Type    | Branch prefix  | Example                        |
|---------|---------------|--------------------------------|
| Bug fix | `fix/`        | `fix/node-group-label-detect`  |
| Feature | `feat/`       | `feat/slack-notifier`          |
| Docs    | `docs/`       | `docs/helm-install-guide`      |

Always branch from `main`. Never push directly to `main`.

## Version Bumping

We follow [Semantic Versioning](https://semver.org/):

| Change type | Bump | Example |
|------------|------|---------|
| Bug fix    | PATCH | 1.1.0 → 1.1.1 |
| New feature | MINOR | 1.1.1 → 1.2.0 |
| Breaking change | MAJOR | 1.x.x → 2.0.0 |

Update `package.json` `version` field in your PR.

## Changelog

Every PR **must** add an entry to `docs/CHANGELOG.md` before merging:

```markdown
## [1.2.1] — YYYY-MM-DD — Short description
**Branch:** `fix/your-branch`

### Fixed
- What was broken and why
```

## PR Checklist

- [ ] Branch named correctly (`fix/` or `feat/`)
- [ ] `package.json` version bumped
- [ ] `docs/CHANGELOG.md` entry added
- [ ] `npx tsc --noEmit` passes (no TypeScript errors)
- [ ] No hardcoded secrets, IPs, or org-specific values
- [ ] Tested locally against a real cluster (or described test plan)

## Adding a Custom Monitor

1. Create `src/monitors/my-monitor.ts` implementing the `Monitor` interface from `src/monitors/base.ts`
2. Add it to the monitors array in `src/main.ts`
3. Add any new config to `src/config.ts` and `helm/blue-y/values.yaml`

## Adding a New Notifier

1. Create `src/clients/notifiers/my-platform.ts` implementing `Notifier` from `src/clients/notifiers/interface.ts`
2. Add it to the `NotifierRouter` in `src/main.ts`
3. Add config to `src/config.ts` and `helm/blue-y/values.yaml`

## Code Style

- TypeScript strict mode — no `any` unless justified
- No hardcoded cluster names, namespaces, or org-specific values
- All org-specific config must come from environment variables

## Questions?

Open a [GitHub Discussion](https://github.com/bluey-ai/blue.y/discussions) or email **hello@blueonion.today**.
