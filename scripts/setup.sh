#!/usr/bin/env bash
# setup.sh — one-shot pi-frugal setup.
#
# Runs (in order):
#   1. install-deps.sh      → pi install obra/superpowers + sriluxman/atlassian-skills + venv
#   2. setup-atlassian.sh   → interactive PAT prompts → ~/.pi/agent/secrets/atlassian.env
#   3. verify-atlassian.sh  → read-only Jira call to confirm auth works
#
# Flags:
#   --no-creds   skip step 2 (creds setup) — use if creds already exist or you'll configure later
#   --no-verify  skip step 3 (verify call)
#
# Re-runnable: every sub-script is idempotent.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

SKIP_CREDS=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --no-creds)  SKIP_CREDS=1 ;;
    --no-verify) SKIP_VERIFY=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

echo "╭──────────────────────────────────────────────────╮"
echo "│  pi-frugal setup                                 │"
echo "╰──────────────────────────────────────────────────╯"
echo ""

echo "▶ [1/3] Installing upstream skill packs (obra/superpowers + sriluxman/atlassian-skills)…"
bash "$DIR/install-deps.sh"

if [ "$SKIP_CREDS" -eq 1 ]; then
  echo ""
  echo "▶ [2/3] Skipping Atlassian credentials (--no-creds)."
else
  echo ""
  echo "▶ [2/3] Configuring Atlassian credentials…"
  if [ -f "$HOME/.pi/agent/secrets/atlassian.env" ]; then
    echo "  Existing secrets file detected — re-running setup-atlassian.sh in update mode"
    echo "  (press <enter> at any prompt to keep the current value)."
    echo ""
  fi
  bash "$DIR/setup-atlassian.sh"
fi

if [ "$SKIP_VERIFY" -eq 1 ]; then
  echo ""
  echo "▶ [3/3] Skipping verification (--no-verify)."
else
  echo ""
  echo "▶ [3/3] Verifying Atlassian auth…"
  bash "$DIR/verify-atlassian.sh" || {
    echo ""
    echo "⚠  Verification failed. Common causes:"
    echo "   - Wrong PAT or expired token → re-run: bash $DIR/setup-atlassian.sh"
    echo "   - Wrong base URL             → re-run: bash $DIR/setup-atlassian.sh"
    echo "   - Network/VPN issue          → check connectivity to your Atlassian instance"
    exit 1
  }
fi

echo ""
echo "✓ pi-frugal setup complete."
echo ""
echo "Try it:    pi"
echo "Re-run:    bash $0"
