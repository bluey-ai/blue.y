# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x.x   | ✅ Yes    |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately by emailing:
**security@blueonion.today**

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

**Expected response time**: We aim to acknowledge reports within 48 hours and provide a fix or mitigation within 14 days for critical issues.

## Scope

In scope:
- BLUE.Y source code (`src/`)
- Helm chart (`helm/`)
- Dockerfile
- Any credential exposure or injection vulnerabilities

Out of scope:
- Issues in third-party dependencies (report to the respective project)
- Vulnerabilities requiring physical access to the cluster

## Disclosure Policy

We follow responsible disclosure. Once a fix is released, we will:
1. Publish a security advisory
2. Credit the reporter (unless anonymity is requested)
3. Tag a patch release

## Security Best Practices for Deployers

- Never commit real secrets to git — use K8s Secrets or a secrets manager
- Use IRSA (IAM Roles for Service Accounts) instead of static AWS credentials
- Restrict BLUE.Y's RBAC to the minimum required permissions
- Run BLUE.Y as a non-root user (already enforced in the official Docker image)
- Keep BLUE.Y updated — subscribe to releases for security patches

## Prompt Injection Mitigation

BLUE.Y processes pod logs, Kubernetes events, and pod descriptions from your cluster and sends them to an AI API for analysis. This creates a prompt injection risk: an attacker who can write to pod logs could craft content intended to manipulate the AI.

BLUE.Y mitigates this with two layers of defense:

1. **Input sanitization** (`src/utils/sanitize.ts`): All cluster-sourced data (logs, events, describe output) is sanitized before reaching the AI API. Suspicious lines matching known injection patterns are redacted.

2. **Hardened system prompt**: The AI receives an explicit, absolute security constraint instructing it to never follow instructions found within log or event content.

For a full security analysis, see [docs/security-architecture.md](docs/security-architecture.md).
