#!/usr/bin/env bash
# install-deps.sh — installs pi-frugal's two upstream skill packs.
#
# pi-frugal composes with:
#   - obra/superpowers          (14 productivity skills)
#   - sriluxman/atlassian-skills   (Jira/Confluence/Bitbucket/Requirements Yogi Python toolkit)
#
# Re-running is safe: pi install is idempotent.

set -eu

echo "Installing upstream skill packs that pi-frugal composes with…"
echo

pi install git:github.com/obra/superpowers
echo
pi install git:github.com/sriluxman/atlassian-skills

# Prepare the Python venv for the atlassian toolkit (one-time).
ATL_DIR="${HOME}/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills"
if [ -d "${ATL_DIR}" ] && [ ! -x "${ATL_DIR}/.venv/bin/python" ]; then
  echo
  echo "Setting up Python venv for atlassian-skills (one-time)…"
  if command -v uv >/dev/null 2>&1; then
    (cd "${ATL_DIR}" && uv venv .venv && .venv/bin/pip install requests python-dotenv)
  else
    (cd "${ATL_DIR}" && python3 -m venv .venv && .venv/bin/pip install requests python-dotenv)
  fi
fi

echo
echo "✓ Upstream dependencies installed."
echo "  Next: bash $(dirname "$0")/setup-atlassian.sh   # configure your Atlassian credentials"
