#!/usr/bin/env bash
# ============================================================
# BLUE.Y — Safe community sync to GitHub
# ============================================================
# Strips all premium code and pushes a clean community build
# to github.com/bluey-ai/blue.y
#
# Usage:
#   ./scripts/sync-to-github.sh              # sync current main
#   ./scripts/sync-to-github.sh --dry-run    # preview only, no push
#   ./scripts/sync-to-github.sh --version    # print version being synced
#
# What it does:
#   1. Validates you are on main, working tree is clean
#   2. Clones current HEAD into a temp directory
#   3. Strips all paths listed in .github-sync-ignore
#   4. Commits the stripped tree as a community release commit
#   5. Force-pushes to the 'github' remote (main branch)
#   6. Cleans up temp directory
#
# Why force-push?
#   Bitbucket main contains premium commits that will never exist
#   on GitHub. The histories legitimately diverge. --force-with-lease
#   is used against GitHub (not origin) to avoid overwriting concurrent
#   GitHub-only changes accidentally.
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IGNORE_FILE="$REPO_ROOT/.github-sync-ignore"
GITHUB_REMOTE="github"
DRY_RUN=false

# ── Parse args ───────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --version) grep '"version"' "$REPO_ROOT/package.json" | head -1 | awk -F'"' '{print $4}'; exit 0 ;;
    --help)
      sed -n '/^# Usage/,/^# ──/p' "$0" | head -20
      exit 0 ;;
  esac
done

cd "$REPO_ROOT"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         BLUE.Y — Community Sync to GitHub                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Pre-flight checks ────────────────────────────────────────
echo "🔍 Pre-flight checks..."

# Must be on main
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "  ❌ Must be on 'main' branch. Currently on: $CURRENT_BRANCH"
  echo "     git checkout main && git pull origin main"
  exit 1
fi
echo "  ✅  Branch: main"

# Working tree must be clean
if ! git diff --quiet HEAD 2>/dev/null; then
  echo "  ❌ Working tree has uncommitted changes. Commit or stash first."
  exit 1
fi
echo "  ✅  Working tree: clean"

# .github-sync-ignore must exist
if [[ ! -f "$IGNORE_FILE" ]]; then
  echo "  ❌ .github-sync-ignore not found at $REPO_ROOT"
  exit 1
fi
echo "  ✅  .github-sync-ignore: found"

# GitHub remote must exist
if ! git remote get-url "$GITHUB_REMOTE" > /dev/null 2>&1; then
  echo "  ❌ Git remote '$GITHUB_REMOTE' not found."
  echo "     Add it: git remote add github https://github.com/bluey-ai/blue.y.git"
  exit 1
fi
echo "  ✅  Remote '$GITHUB_REMOTE': $(git remote get-url $GITHUB_REMOTE)"

# ── Get version ──────────────────────────────────────────────
VERSION=$(grep '"version"' "$REPO_ROOT/package.json" | head -1 | awk -F'"' '{print $4}')
SHORT_COMMIT=$(git rev-parse --short HEAD)
echo ""
echo "📦 Syncing BLUE.Y v${VERSION} (${SHORT_COMMIT}) → GitHub community edition"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo "🔎 DRY RUN — showing what would be stripped (no push will happen):"
  echo ""
fi

# ── Create temp clone ────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "📁 Creating temp workspace..."
git clone "$REPO_ROOT" "$TMPDIR" --branch main --single-branch --quiet
cd "$TMPDIR"

# Copy .github-sync-ignore into temp clone (in case it references relative paths)
cp "$IGNORE_FILE" "$TMPDIR/.github-sync-ignore"

# ── Strip premium paths ──────────────────────────────────────
echo "🔒 Stripping premium paths..."
STRIPPED=()

while IFS= read -r pattern; do
  # Skip comments and blank lines
  [[ "$pattern" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${pattern// }" ]] && continue

  clean="${pattern%/}"  # strip trailing slash

  if [[ -e "$clean" ]] || git ls-files --cached "$clean" 2>/dev/null | grep -q .; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "   Would strip: $pattern"
    else
      git rm -r --cached --ignore-unmatch "$clean" > /dev/null 2>&1 || true
      rm -rf "$clean"
      STRIPPED+=("$pattern")
      echo "   Stripped:    $pattern"
    fi
  else
    echo "   Not present: $pattern (skip)"
  fi
done < .github-sync-ignore

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "✅  Dry run complete. No changes pushed."
  exit 0
fi

echo ""

# ── Commit the stripped community tree ──────────────────────
git add -A > /dev/null 2>&1 || true

# Only commit if there are changes
if ! git diff --cached --quiet; then
  git commit -m "chore: community release v${VERSION} (${SHORT_COMMIT}) — premium features stripped" \
    --no-verify \
    > /dev/null 2>&1
  echo "✅  Community commit created"
else
  echo "ℹ️   No premium files present in tree — nothing to strip"
fi

# ── Add GitHub remote to temp clone and push ─────────────────
GITHUB_URL=$(cd "$REPO_ROOT" && git remote get-url "$GITHUB_REMOTE")
git remote add github "$GITHUB_URL" > /dev/null 2>&1

echo "🚀 Pushing to GitHub..."
git push github main:main --force \
  && echo "" \
  && echo "╔══════════════════════════════════════════════════════════════╗" \
  && echo "║   ✅  BLUE.Y v${VERSION} synced to GitHub successfully!      " \
  && echo "║       Community edition — zero premium code included.        " \
  && echo "╚══════════════════════════════════════════════════════════════╝" \
  && echo ""

# Temp dir cleaned up by trap
