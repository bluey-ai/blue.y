# BLUE.Y License Key Management

**BlueOnion internal only — never sync to GitHub.**

License keys are RS256-signed JWTs. The bot verifies them locally using an embedded public key — no phone-home, no internet check. The private key never leaves BlueOnion.

---

## Quick Reference

| Task | Command |
|------|---------|
| Issue a new key | `node scripts/licensing/issue-license.js issue --customer x@y.com --plan premium --seats 25 --expires 2027-03-16` |
| Issue perpetual key | same, without `--expires` |
| Verify a key | `node scripts/licensing/issue-license.js verify <token>` |
| Deliver to customer | add `ADMIN_LICENSE_KEY=<token>` to their `blue-y-secrets` K8s secret |

---

## Plans & Pricing

| Plan | Seats | Use case |
|------|-------|----------|
| `community` | 10 (default, no key needed) | Free tier |
| `premium` | custom | $2.99/user/month |
| `enterprise` | custom | negotiated |

The `community` plan is the automatic fallback when no `ADMIN_LICENSE_KEY` is set or the key is invalid/expired.

---

## Where the Private Key Lives

- **1Password**: vault `BlueOnion Engineering`, item `BLUE.Y License Private Key`
- The key is a 2048-bit RSA PEM block (`-----BEGIN PRIVATE KEY-----`)
- The public key is embedded in `src/admin/license.ts` (in-repo, safe to commit)
- **Never** store the private key in git, Slack, email, or Jira

To use the private key locally for issuing:

```bash
# Option A — write to local file (safest, delete after)
# Paste from 1Password into:
scripts/licensing/bluey-license-private.pem   # gitignored

# Option B — env var (good for one-off commands)
export BLUEY_LICENSE_PRIVATE_KEY="$(pbpaste)"   # paste from 1Password
node scripts/licensing/issue-license.js issue ...
unset BLUEY_LICENSE_PRIVATE_KEY
```

---

## Issuing a Key

### Monthly renewal (fixed 1-year term)

```bash
node scripts/licensing/issue-license.js issue \
  --customer acme@example.com \
  --plan premium \
  --seats 25 \
  --expires 2027-03-16
```

Rules:
- `--expires` is an ISO date (`YYYY-MM-DD`). The bot checks this at startup and hourly.
- When a key expires, the bot falls back to the free tier (10 seats) automatically — it does **not** crash or lock anyone out.
- Set expiry ~1 year out for annual contracts, or 30–90 days for monthly billing.

### Perpetual key (enterprise / internal)

```bash
node scripts/licensing/issue-license.js issue \
  --customer blueonion-internal \
  --plan enterprise \
  --seats 999
```

Omitting `--expires` issues a perpetual key. Use sparingly.

---

## Delivering a Key to a Customer

Add `ADMIN_LICENSE_KEY` to the customer's existing `blue-y-secrets` K8s secret:

```bash
# Patch existing secret (non-destructive — other keys preserved)
kubectl patch secret blue-y-secrets -n prod \
  --type='json' \
  -p='[{"op":"add","path":"/data/ADMIN_LICENSE_KEY","value":"'$(echo -n "PASTE_TOKEN_HERE" | base64)'"}]'
```

Or if creating from scratch:

```bash
kubectl create secret generic blue-y-secrets \
  --from-literal=ADMIN_LICENSE_KEY="eyJhbGci..." \
  --from-literal=deepseek-api-key="..." \
  ... \
  -n prod --dry-run=client -o yaml | kubectl apply -f -
```

The bot picks up the new key within 1 hour (cache TTL). To apply immediately: rolling restart the pod.

---

## Renewing an Expiring Key

1. Get the private key from 1Password
2. Run `issue` with the same `--customer` and `--seats`, updated `--expires`
3. Deliver the new token (patch the K8s secret)
4. Optionally restart the pod so it picks up immediately

```bash
# Example: renew acme for another year
node scripts/licensing/issue-license.js issue \
  --customer acme@example.com \
  --plan premium \
  --seats 25 \
  --expires 2028-03-16
```

---

## Verifying a Key

Before delivering or when debugging:

```bash
node scripts/licensing/issue-license.js verify eyJhbGci...
```

Output example:
```
✅ Valid license:
{
  "iss": "bluey-license",
  "plan": "premium",
  "seats": 25,
  "customer": "acme@example.com",
  "expires": "2027-03-16",
  "iat": 1773664572
}
```

Exit code `1` = invalid or expired.

---

## Changing Seat Count Mid-Term

Issue a new key with the updated `--seats` and the **same** `--expires`:

```bash
node scripts/licensing/issue-license.js issue \
  --customer acme@example.com \
  --plan premium \
  --seats 50 \
  --expires 2027-03-16   # keep original expiry
```

Deliver and patch the secret as above.

---

## If the Private Key Is Ever Compromised

1. Run `setup` again to generate a new keypair:
   ```bash
   rm scripts/licensing/bluey-license-private.pem
   node scripts/licensing/issue-license.js setup
   ```
2. This patches a new public key into `src/admin/license.ts`
3. Commit and push — all existing customer keys become **invalid** immediately after deploy
4. Re-issue new keys for all customers with the new private key
5. Update 1Password with the new private key, delete the old entry

---

## Changelog

| Date | Action | Notes |
|------|--------|-------|
| 2026-03-16 | Initial keypair generated | BLY-61, Zeeshan |
