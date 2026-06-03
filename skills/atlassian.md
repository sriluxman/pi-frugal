---
name: atlassian
description: Run Jira / Confluence / Bitbucket operations (read + write) against your Atlassian instance via the langpingxue/atlassian-skills Python toolkit. Use for get/search/create/update Jira issues, transitions, worklogs, sprints; read/create/update/delete Confluence pages, comments, labels; Bitbucket projects, repos, PRs, commits, file content. Hard-gates write operations until the user approves.
---

# atlassian (pi-frugal execution overlay for langpingxue/atlassian-skills)

This is a thin **execution wrapper** that tells you how to invoke
`langpingxue/atlassian-skills` (full read+write variant) from inside pi, using
credentials kept in a chmod-600 secrets file outside this repo.

The upstream toolkit ships its own `SKILL.md` + `REFERENCE.md` with the full
45-function catalog. To keep per-turn token cost low, those are NOT
auto-loaded — read them on demand the first time you need a function not
listed below.

## Prerequisites (one-time setup)

1. Install the upstream Python toolkit:
   ```
   pi install git:github.com/langpingxue/atlassian-skills
   ```
2. Create the venv + install requests/python-dotenv (one-time):
   ```
   cd "$(node -e 'console.log(require("os").homedir())')/.pi/agent/git/github.com/langpingxue/atlassian-skills"
   uv venv .venv && .venv/bin/pip install requests python-dotenv
   ```
3. Run the setup script (interactive prompts for URLs + PATs):
   ```
   bash <pi-frugal-install-dir>/scripts/setup-atlassian.sh
   ```
   This writes `~/.pi/agent/secrets/atlassian.env` with mode 0600. **That file is the only place your PAT lives — never commit it.**

## Environment variables you can override

| Variable | Default | Purpose |
|---|---|---|
| `PI_FRUGAL_ATLASSIAN_DIR` | `~/.pi/agent/git/github.com/langpingxue/atlassian-skills` | Where the upstream Python scripts live |
| `PI_FRUGAL_ATLASSIAN_ENV` | `~/.pi/agent/secrets/atlassian.env` | Where the PAT-bearing env file lives |
| `PI_FRUGAL_ATLASSIAN_PY` | `<atlassian-dir>/.venv/bin/python` | Python interpreter to use |

## Execution recipe (use the bundled venv; load creds from the secrets file)

```bash
ATL_DIR="${PI_FRUGAL_ATLASSIAN_DIR:-$HOME/.pi/agent/git/github.com/langpingxue/atlassian-skills}"
ATL_ENV="${PI_FRUGAL_ATLASSIAN_ENV:-$HOME/.pi/agent/secrets/atlassian.env}"
ATL_PY="${PI_FRUGAL_ATLASSIAN_PY:-$ATL_DIR/.venv/bin/python}"

cd "$ATL_DIR" && "$ATL_PY" -c "
import sys, os
sys.path.insert(0, '.')
from dotenv import load_dotenv
load_dotenv('$ATL_ENV')
from scripts.jira_search import jira_search
print(jira_search(jql='project = MYPROJ AND sprint in openSprints()', fields='summary,status,assignee', limit=20))
"
```

The pattern is the same for every function — change the `from scripts.X import Y` line and the call.

## <HARD-GATE> Write operations

Before invoking ANY of the following, you MUST briefly state what you intend to
change (target key, fields, comment text, etc.) and get **explicit user
approval in the SAME message** before proceeding. Do not approve yourself.

- `jira_create_issue`, `jira_update_issue`, `jira_delete_issue`, `jira_add_comment`
- `jira_transition_issue`, `jira_add_worklog`
- `jira_create_sprint`, `jira_update_sprint`
- `jira_create_issue_link`, `jira_link_to_epic`, `jira_remove_issue_link`
- `jira_create_version`
- `confluence_create_page`, `confluence_update_page`, `confluence_delete_page`
- `confluence_add_comment`, `confluence_add_label`, `confluence_remove_label`
- `bitbucket_create_pull_request`, `bitbucket_merge_pull_request`, `bitbucket_decline_pull_request`, `bitbucket_add_pr_comment`

Read-only calls (`*_get_*`, `*_search`, `*_list_*`) do NOT need approval.

## Confluence writes — one critical rule

Confluence Data Center / Server requires **storage format (XHTML)** for
`confluence_create_page` / `confluence_update_page` body content. Markdown
and wiki formats render incorrectly. The `confluence_pages` functions accept
the body as a string and assume storage format by default — pass XHTML.

Storage format quick reference:
- Paragraphs: `<p>…</p>` · Headings: `<h1>…</h1>` … `<h6>…</h6>`
- Bold/italic: `<strong>…</strong>` / `<em>…</em>` · Inline code: `<code>…</code>`
- Lists: `<ul><li>…</li></ul>`, `<ol><li>…</li></ol>`
- Code block: `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[…]]></ac:plain-text-body></ac:structured-macro>`
- Info/Note/Warning: `<ac:structured-macro ac:name="info|note|warning"><ac:rich-text-body><p>…</p></ac:rich-text-body></ac:structured-macro>`
- Tables: standard `<table><tr><th>…</th></tr><tr><td>…</td></tr></table>`
- Links: `<a href="…">…</a>` · Page mention: `<ac:link><ri:page ri:content-title="Page Title" /></ac:link>`

## Function catalog (45 functions, abbreviated)

For exact signatures (parameter names, optional fields, return shape) read on demand:

```
read $PI_FRUGAL_ATLASSIAN_DIR/SKILL.md       # usage patterns
read $PI_FRUGAL_ATLASSIAN_DIR/REFERENCE.md   # full param reference
```

### Jira read
`scripts.jira_issues.jira_get_issue` · `scripts.jira_search.jira_search` · `scripts.jira_search.jira_search_fields` · `scripts.jira_workflow.jira_get_transitions` · `scripts.jira_agile.{jira_get_agile_boards, jira_get_board_issues, jira_get_sprints_from_board, jira_get_sprint_issues}` · `scripts.jira_links.jira_get_link_types` · `scripts.jira_worklog.jira_get_worklog` · `scripts.jira_projects.{jira_get_all_projects, jira_get_project_issues, jira_get_project_versions}` · `scripts.jira_users.jira_get_user_profile`

### Jira write (gated)
`scripts.jira_issues.{jira_create_issue, jira_update_issue, jira_delete_issue, jira_add_comment}` · `scripts.jira_workflow.jira_transition_issue` · `scripts.jira_agile.{jira_create_sprint, jira_update_sprint}` · `scripts.jira_links.{jira_create_issue_link, jira_link_to_epic, jira_remove_issue_link}` · `scripts.jira_worklog.jira_add_worklog` · `scripts.jira_projects.jira_create_version`

### Confluence read
`scripts.confluence_pages.confluence_get_page` · `scripts.confluence_search.confluence_search` · `scripts.confluence_comments.confluence_get_comments` · `scripts.confluence_labels.confluence_get_labels`

### Confluence write (gated)
`scripts.confluence_pages.{confluence_create_page, confluence_update_page, confluence_delete_page}` · `scripts.confluence_comments.confluence_add_comment` · `scripts.confluence_labels.{confluence_add_label, confluence_remove_label}`

### Bitbucket (mostly read; PR mutations gated)
`scripts.bitbucket_projects.{bitbucket_list_projects, bitbucket_list_repositories}` · `scripts.bitbucket_pull_requests.{bitbucket_get_pull_request, bitbucket_get_pr_diff, **bitbucket_create_pull_request**, **bitbucket_merge_pull_request**, **bitbucket_decline_pull_request**, **bitbucket_add_pr_comment**}` · `scripts.bitbucket_files.{bitbucket_get_file_content, bitbucket_search}` · `scripts.bitbucket_commits.{bitbucket_get_commits, bitbucket_get_commit}`

## Errors

All functions return JSON. On failure: `{"success": false, "error": "...", "error_type": "..."}`.
Error types: `ConfigurationError`, `AuthenticationError`, `ValidationError`, `NotFoundError`, `APIError`, `NetworkError`.

## Time format (worklog)

`1w` `2d` `3h` `30m` or combined like `1d 4h 30m`.
