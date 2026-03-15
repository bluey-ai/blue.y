## Summary

<!-- What does this PR do? One or two sentences. -->

## Jira Ticket

<!-- e.g. BLY-17 or HUBS-1234 -->
Ticket:

## Type of Change

- [ ] Bug fix (`fix/` branch → patch bump)
- [ ] New feature (`feat/` branch → minor bump)
- [ ] Breaking change (`feat/` branch → major bump)
- [ ] Chore / docs / config (no version bump)

## Testing

- [ ] Tested locally with `docker compose up`
- [ ] Tested against a real cluster (kubeconfig)
- [ ] `npm run build` passes (no TypeScript errors)
- [ ] `npm run lint` passes

## Checklist

- [ ] No hardcoded credentials, internal URLs, or BlueOnion-specific values
- [ ] `bitbucket-pipelines.yml` changes are intentional (internal only — never push to GitHub)
- [ ] CHANGELOG.md updated if this is a versioned release
- [ ] `package.json` version bumped if applicable

## Notes for Reviewer

<!-- Anything the reviewer should know: edge cases, config changes, K8s secrets needed, etc. -->
