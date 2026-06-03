#!/usr/bin/env bash
# setup-atlassian.sh — interactive PAT setup for pi-frugal's atlassian skill.
#
# Writes ~/.pi/agent/secrets/atlassian.env (chmod 600). Re-running prompts for
# overwrite. Skips empty answers (keeps existing value if present).
#
# Usage:
#   bash setup-atlassian.sh           # interactive
#   bash setup-atlassian.sh --print   # print where the file is and exit

set -eu

SECRETS_DIR="${HOME}/.pi/agent/secrets"
ENV_FILE="${SECRETS_DIR}/atlassian.env"

if [ "${1:-}" = "--print" ]; then
  echo "Secrets file path: ${ENV_FILE}"
  [ -f "${ENV_FILE}" ] && echo "Status: exists (mode $(stat -c %a "${ENV_FILE}" 2>/dev/null || stat -f %A "${ENV_FILE}"))" || echo "Status: does not exist"
  exit 0
fi

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# Load any existing values so empty answers keep them.
declare -A CUR=()
if [ -f "${ENV_FILE}" ]; then
  while IFS='=' read -r key val; do
    [ -z "$key" ] && continue
    case "$key" in \#*) continue ;; esac
    CUR["$key"]="$val"
  done < "${ENV_FILE}"
  echo "Existing file found — press <enter> to keep the current value for any field."
  echo
fi

prompt() {
  local key="$1" prompt_txt="$2" secret="${3:-no}" cur="${CUR[$1]:-}"
  local display_cur=""
  if [ -n "$cur" ]; then
    if [ "$secret" = "yes" ]; then
      display_cur=" [keep current ****${cur: -4}]"
    else
      display_cur=" [keep current: ${cur}]"
    fi
  fi
  local ans=""
  if [ "$secret" = "yes" ]; then
    read -r -s -p "${prompt_txt}${display_cur}: " ans
    echo
  else
    read -r -p "${prompt_txt}${display_cur}: " ans
  fi
  if [ -z "$ans" ] && [ -n "$cur" ]; then
    echo "$cur"
  else
    echo "$ans"
  fi
}

echo "── Jira ──────────────────────────────────────────────"
JIRA_URL=$(prompt JIRA_URL          "Jira base URL (e.g. https://jira.example.com)")
JIRA_USERNAME=$(prompt JIRA_USERNAME "Jira username / email")
JIRA_PAT_TOKEN=$(prompt JIRA_PAT_TOKEN "Jira Personal Access Token" yes)
echo
echo "── Confluence ────────────────────────────────────────"
CONFLUENCE_URL=$(prompt CONFLUENCE_URL "Confluence base URL (e.g. https://confluence.example.com)")
CONFLUENCE_USERNAME=$(prompt CONFLUENCE_USERNAME "Confluence username / email")
CONFLUENCE_PAT_TOKEN=$(prompt CONFLUENCE_PAT_TOKEN "Confluence Personal Access Token" yes)
echo
echo "── Bitbucket (optional, press enter to skip) ─────────"
BITBUCKET_URL=$(prompt BITBUCKET_URL "Bitbucket base URL")
BITBUCKET_PAT_TOKEN=$(prompt BITBUCKET_PAT_TOKEN "Bitbucket Personal Access Token" yes)

# Write atomically with strict perms.
TMP=$(mktemp "${SECRETS_DIR}/.atlassian.env.XXXXXX")
chmod 600 "${TMP}"
{
  echo "# Atlassian credentials for pi-frugal — written by setup-atlassian.sh"
  echo "# DO NOT COMMIT. Mode 0600."
  echo ""
  echo "JIRA_URL=${JIRA_URL}"
  echo "JIRA_USERNAME=${JIRA_USERNAME}"
  echo "JIRA_PAT_TOKEN=${JIRA_PAT_TOKEN}"
  echo ""
  echo "CONFLUENCE_URL=${CONFLUENCE_URL}"
  echo "CONFLUENCE_USERNAME=${CONFLUENCE_USERNAME}"
  echo "CONFLUENCE_PAT_TOKEN=${CONFLUENCE_PAT_TOKEN}"
  echo ""
  if [ -n "${BITBUCKET_URL}" ] || [ -n "${BITBUCKET_PAT_TOKEN}" ]; then
    echo "BITBUCKET_URL=${BITBUCKET_URL}"
    echo "BITBUCKET_PAT_TOKEN=${BITBUCKET_PAT_TOKEN}"
  else
    echo "# BITBUCKET_URL="
    echo "# BITBUCKET_PAT_TOKEN="
  fi
} > "${TMP}"
mv "${TMP}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo
echo "✓ Wrote ${ENV_FILE} (mode 0600)"
echo "  Next: verify with → bash $(dirname "$0")/verify-atlassian.sh"
