#!/usr/bin/env bash
# ============================================================
# BLUE.Y Smoke Test — post-deploy verification
# ============================================================
# Run after every Bitbucket pipeline deploy to confirm the
# pod is healthy and all systems are responding correctly.
#
# Required env vars:
#   TELEGRAM_BOT_TOKEN   — bot API token (from K8s secret)
#   TELEGRAM_CHAT_ID     — group/channel chat ID
#
# Optional env vars:
#   NAMESPACE            — K8s namespace (default: prod)
#   APP_PORT             — local port for port-forward (default: 8000)
#   SKIP_TELEGRAM        — set to 1 to skip Telegram API tests
#   SKIP_K8S             — set to 1 to skip kubectl tests (HTTP only)
#
# Usage:
#   ./scripts/smoke-test.sh
#   NAMESPACE=prod TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy ./scripts/smoke-test.sh
# ============================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-prod}"
APP_PORT="${APP_PORT:-8000}"
SKIP_TELEGRAM="${SKIP_TELEGRAM:-0}"
SKIP_K8S="${SKIP_K8S:-0}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-120}"  # seconds to wait for rollout
TELEGRAM_WAIT="${TELEGRAM_WAIT:-15}"     # seconds to wait for bot reply

PASS=0
FAIL=0
ERRORS=()

# ── Helpers ───────────────────────────────────────────────────────────────────
ok()   { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1"; ERRORS+=("$1"); ((FAIL++)); }
info() { echo "  ℹ️  $1"; }
section() { echo; echo "── $1 ──────────────────────────────────────────────"; }

require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: Required env var \$$var is not set." >&2
    exit 1
  fi
}

# ── Validate env ──────────────────────────────────────────────────────────────
if [[ "$SKIP_TELEGRAM" != "1" ]]; then
  require_env TELEGRAM_BOT_TOKEN
  require_env TELEGRAM_CHAT_ID
fi

# ── K8s: wait for rollout & find pod ─────────────────────────────────────────
section "Kubernetes"

POD_NAME=""
if [[ "$SKIP_K8S" != "1" ]]; then
  if ! command -v kubectl &>/dev/null; then
    info "kubectl not found — skipping K8s checks"
    SKIP_K8S=1
  fi
fi

if [[ "$SKIP_K8S" != "1" ]]; then
  echo "  Waiting for rollout (timeout ${DEPLOY_TIMEOUT}s)..."
  if kubectl rollout status deployment/blue-y-production \
      -n "$NAMESPACE" \
      --timeout="${DEPLOY_TIMEOUT}s" 2>&1 | grep -q "successfully rolled out"; then
    ok "Rollout complete"
  else
    # Rollout status may still say ok without that string — check again
    ROLLOUT_STATUS=$(kubectl rollout status deployment/blue-y-production -n "$NAMESPACE" --timeout=5s 2>&1 || true)
    if echo "$ROLLOUT_STATUS" | grep -qiE "rolled out|success"; then
      ok "Rollout complete"
    else
      fail "Rollout not confirmed: $ROLLOUT_STATUS"
    fi
  fi

  POD_NAME=$(kubectl get pods -n "$NAMESPACE" \
    -l app=blue-y \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

  if [[ -n "$POD_NAME" ]]; then
    ok "Pod running: $POD_NAME"
  else
    fail "No running blue-y pod found in namespace $NAMESPACE"
    SKIP_K8S=1
  fi
fi

# ── HTTP health checks via port-forward ───────────────────────────────────────
section "HTTP Health"

PF_PID=""

cleanup() {
  if [[ -n "$PF_PID" ]]; then
    kill "$PF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$SKIP_K8S" != "1" && -n "$POD_NAME" ]]; then
  # Start port-forward in background
  kubectl port-forward "pod/$POD_NAME" "${APP_PORT}:8000" -n "$NAMESPACE" &>/dev/null &
  PF_PID=$!
  sleep 3  # give port-forward time to establish

  BASE="http://localhost:${APP_PORT}"

  # /health
  HEALTH=$(curl -sf --max-time 10 "${BASE}/health" 2>/dev/null || true)
  if [[ -n "$HEALTH" ]]; then
    STATUS=$(echo "$HEALTH" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || true)
    VERSION=$(echo "$HEALTH" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || true)
    if [[ "$STATUS" == "ok" ]]; then
      ok "/health → status=ok, version=${VERSION}"
    else
      fail "/health returned unexpected status: $HEALTH"
    fi
  else
    fail "/health endpoint not reachable"
  fi

  # /audit (monitor heartbeats)
  AUDIT=$(curl -sf --max-time 10 "${BASE}/audit" 2>/dev/null || true)
  if [[ -n "$AUDIT" ]]; then
    ok "/audit endpoint responding ($(echo "$AUDIT" | grep -o '"type"' | wc -l | tr -d ' ') log entries)"
  else
    info "/audit returned empty (no monitor runs yet — ok if freshly deployed)"
  fi

  # Kill port-forward now
  kill "$PF_PID" 2>/dev/null || true
  PF_PID=""
else
  info "Skipping HTTP checks (no K8s access)"
fi

# ── Telegram API: bot responsiveness ─────────────────────────────────────────
section "Telegram Bot"

if [[ "$SKIP_TELEGRAM" != "1" ]]; then
  TG_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

  # 1. Verify bot token is valid
  BOT_INFO=$(curl -sf --max-time 10 "${TG_API}/getMe" 2>/dev/null || true)
  if echo "$BOT_INFO" | grep -q '"ok":true'; then
    BOT_USERNAME=$(echo "$BOT_INFO" | grep -o '"username":"[^"]*"' | cut -d'"' -f4 || true)
    ok "Bot token valid (@${BOT_USERNAME})"
  else
    fail "Bot token invalid or Telegram API unreachable"
    SKIP_TELEGRAM=1
  fi
fi

if [[ "$SKIP_TELEGRAM" != "1" ]]; then
  # 2. Get current update_id watermark (so we only look at NEW replies)
  BEFORE=$(curl -sf --max-time 10 "${TG_API}/getUpdates?limit=1&offset=-1" 2>/dev/null || echo '{"result":[]}')
  LAST_ID=$(echo "$BEFORE" | grep -o '"update_id":[0-9]*' | tail -1 | cut -d: -f2 || echo "0")
  NEXT_OFFSET=$(( ${LAST_ID:-0} + 1 ))

  # 3. Send /version command (safe, read-only, quick response)
  SEND_RESULT=$(curl -sf --max-time 10 -X POST "${TG_API}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"/version\",\"parse_mode\":\"HTML\"}" 2>/dev/null || true)

  if echo "$SEND_RESULT" | grep -q '"ok":true'; then
    info "Sent /version command, waiting ${TELEGRAM_WAIT}s for bot reply..."
    sleep "$TELEGRAM_WAIT"

    # 4. Check for bot's reply
    UPDATES=$(curl -sf --max-time 10 \
      "${TG_API}/getUpdates?offset=${NEXT_OFFSET}&limit=20" 2>/dev/null || echo '{"result":[]}')

    # Look for a message from the bot (not from users — bot messages appear as "from" with is_bot=true)
    BOT_REPLY=$(echo "$UPDATES" | grep -o '"text":"[^"]*"' | head -5 || true)

    if echo "$BOT_REPLY" | grep -qiE "BLUE\.Y|version|v[0-9]+\.[0-9]"; then
      ok "Bot replied to /version command"
    else
      fail "No /version reply detected within ${TELEGRAM_WAIT}s (bot may be slow to start or command routing broken)"
    fi
  else
    fail "Failed to send test message via Telegram API"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
section "Results"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo
  echo "  Failures:"
  for err in "${ERRORS[@]}"; do
    echo "    • $err"
  done
fi

echo

if [[ "$FAIL" -gt 0 ]]; then
  echo "SMOKE TEST FAILED — $FAIL check(s) did not pass."
  exit 1
else
  echo "SMOKE TEST PASSED — all $PASS check(s) green."
  exit 0
fi
