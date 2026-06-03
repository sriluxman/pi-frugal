#!/usr/bin/env bash
# verify-atlassian.sh — sanity-check that the atlassian skill can authenticate.
#
# Runs a read-only jira_search call (zero side effects, 1-result limit).
# Exits 0 on success, non-zero on any failure (missing venv, missing env, auth fail).

set -eu

ATL_DIR="${PI_FRUGAL_ATLASSIAN_DIR:-$HOME/.pi/agent/git/github.com/langpingxue/atlassian-skills}"
ATL_ENV="${PI_FRUGAL_ATLASSIAN_ENV:-$HOME/.pi/agent/secrets/atlassian.env}"
ATL_PY="${PI_FRUGAL_ATLASSIAN_PY:-$ATL_DIR/.venv/bin/python}"

echo "Atlassian skill verification"
echo "  scripts dir : ${ATL_DIR}"
echo "  env file    : ${ATL_ENV}"
echo "  python      : ${ATL_PY}"
echo

[ -d "${ATL_DIR}" ]  || { echo "✗ scripts dir missing — run: pi install git:github.com/langpingxue/atlassian-skills"; exit 2; }
[ -f "${ATL_ENV}" ] || { echo "✗ secrets file missing — run: bash $(dirname "$0")/setup-atlassian.sh"; exit 2; }
[ -x "${ATL_PY}" ]  || { echo "✗ venv python missing — run: cd \"${ATL_DIR}\" && uv venv .venv && .venv/bin/pip install requests python-dotenv"; exit 2; }

mode=$(stat -c %a "${ATL_ENV}" 2>/dev/null || stat -f %A "${ATL_ENV}" 2>/dev/null || echo "?")
if [ "${mode}" != "600" ]; then
  echo "⚠ secrets file is mode ${mode}, expected 600 — fixing"
  chmod 600 "${ATL_ENV}"
fi

cd "${ATL_DIR}"
out=$("${ATL_PY}" -c "
import sys, json
sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv('${ATL_ENV}')
from scripts.jira_search import jira_search
r = jira_search(jql='order by updated DESC', fields='summary,status', limit=1)
print(r)
" 2>&1) || { echo "✗ python call failed:"; echo "$out"; exit 3; }

if echo "$out" | grep -q '"success": false'; then
  echo "✗ Jira call returned an error:"
  echo "$out"
  exit 4
fi

echo "✓ Auth OK — Jira responded."
echo
echo "Sample (1 issue):"
echo "$out" | head -20
