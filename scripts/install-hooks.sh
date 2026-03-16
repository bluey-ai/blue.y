#!/usr/bin/env bash
# ============================================================
# BLUE.Y — Install git hooks
# ============================================================
# Run this once per developer machine after cloning:
#   chmod +x scripts/install-hooks.sh
#   ./scripts/install-hooks.sh
#
# What it installs:
#   hooks/pre-push  →  .git/hooks/pre-push
#     Blocks accidental push of premium code to GitHub.
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_ROOT/hooks"
HOOKS_DEST="$REPO_ROOT/.git/hooks"

echo ""
echo "🔧 BLUE.Y — Installing git hooks..."
echo "   Repo: $REPO_ROOT"
echo ""

if [[ ! -d "$HOOKS_SRC" ]]; then
  echo "❌ hooks/ directory not found at $HOOKS_SRC"
  exit 1
fi

if [[ ! -d "$HOOKS_DEST" ]]; then
  echo "❌ .git/hooks/ not found — are you in the repo root?"
  exit 1
fi

# Install pre-push hook
cp "$HOOKS_SRC/pre-push" "$HOOKS_DEST/pre-push"
chmod +x "$HOOKS_DEST/pre-push"
echo "  ✅  pre-push hook installed → blocks premium code leaks to GitHub"

echo ""
echo "🔒 Premium code protection is now ACTIVE on this machine."
echo "   Any attempt to 'git push github ...' with premium paths will be blocked."
echo "   Use './scripts/sync-to-github.sh' for safe GitHub releases."
echo ""
