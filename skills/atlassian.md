---
name: atlassian
description: Run Jira / Confluence / Bitbucket / Requirements Yogi operations (read + write) against your Atlassian instance via the sriluxman/atlassian-skills Python toolkit. Use for get/search/create/update Jira issues, transitions, worklogs, sprints; read/create/update/delete Confluence pages, comments, labels; Bitbucket projects, repos, PRs, commits, file content; Requirements Yogi requirement CRUD. Hard-gates write operations until the user approves.
---

# atlassian (pi-frugal execution overlay for sriluxman/atlassian-skills)

This is a thin **execution wrapper** that tells you how to invoke
`sriluxman/atlassian-skills` (full read+write variant, with Requirements Yogi support) from inside pi, using
credentials kept in a chmod-600 secrets file outside this repo.

The upstream toolkit ships its own `SKILL.md` + `REFERENCE.md` with the full
45-function catalog. To keep per-turn token cost low, those are NOT
auto-loaded — read them on demand the first time you need a function not
listed below.

## Prerequisites (one-time setup)

1. Install the upstream Python toolkit:
   ```
   pi install git:github.com/sriluxman/atlassian-skills
   ```
2. Create the venv + install requests/python-dotenv (one-time):
   ```
   cd "$(node -e 'console.log(require("os").homedir())')/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills"
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
| `PI_FRUGAL_ATLASSIAN_DIR` | `~/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills` | Where the upstream Python scripts live |
| `PI_FRUGAL_ATLASSIAN_ENV` | `~/.pi/agent/secrets/atlassian.env` | Where the PAT-bearing env file lives |
| `PI_FRUGAL_ATLASSIAN_PY` | `<atlassian-dir>/.venv/bin/python` | Python interpreter to use |

## Execution recipe (ONE self-contained command per call)

Every toolkit call is a **single self-contained bash line** of this exact shape.
It depends only on `$HOME` (always defined), so it works in a fresh shell even
if nothing was set up beforehand. Substitute `<FUNCTION>` and the `key=value`
args; never split the `cd` and the python call across two tool calls.

```bash
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python atl_run.py <FUNCTION> key=value key=value
```

Worked examples (copy the whole line, change only the function + args):

```bash
# Get one Jira issue
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python atl_run.py jira_get_issue issue_key=THCU-2473 fields=summary,status,assignee

# Search Jira (quote any value containing spaces)
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python atl_run.py jira_search jql="project = THCU AND sprint in openSprints()" fields=summary,status limit=20

# Get one Requirements Yogi requirement (keys use UNDERSCORES, e.g. IAM_001)
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python atl_run.py requirement_yogi_get_requirement space_key=THCU requirement_key=IAM_001
```

**Rules (do these every time):**
- Use the command shape above verbatim; only change `<FUNCTION>` and the args.
- Keep `cd … && .venv/bin/python atl_run.py …` in **one** bash call — each call
  is a fresh shell, so variables set in a previous call are gone.
- **Never invent CLIs** (`atl`, `pi skill atlassian --help`, `acli`, …). The
  ONLY interface is `atl_run.py`. To see every function: append `--list`.
- Credentials load automatically from `~/.pi/agent/secrets/atlassian.env`.

### Fallback: inline `python -c` (frontier models only)

If you need a function not reachable via the runner, the raw form still works —
keep it to ONE line so it survives whitespace flattening:

```bash
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python -c "import sys; sys.path.insert(0,'.'); from dotenv import load_dotenv; load_dotenv('$HOME/.pi/agent/secrets/atlassian.env'); from scripts.jira_search import jira_search; print(jira_search(jql='project = THCU', fields='summary', limit=20))"
```

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

## Function catalog (bare names — call via the runner)

**How to invoke:** every function is called by its **bare name** as the first
argument to `atl_run.py` (see the Execution recipe above), e.g.
`atl_run.py jira_get_issue issue_key=ABC-1`. Do **not** invent CLI commands
like `pi skill atlassian --help` — there is no such command. If you need a
function not listed here, discover the full set with:

```bash
DIR="$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills"
cd "$DIR" && .venv/bin/python atl_run.py --list    # all function names, grouped
read "$DIR/REFERENCE.md"                            # full param reference
```

The dotted `scripts.module.function` paths below are only for the inline
`python -c` fallback; with the runner you pass **just the final name** (the part
after the last dot) into the command shape from the Execution recipe above.

### Jira read
`scripts.jira_issues.jira_get_issue` · `scripts.jira_search.jira_search` · `scripts.jira_search.jira_search_fields` · `scripts.jira_workflow.jira_get_transitions` · `scripts.jira_agile.{jira_get_agile_boards, jira_get_board_issues, jira_get_sprints_from_board, jira_get_sprint_issues}` · `scripts.jira_links.jira_get_link_types` · `scripts.jira_worklog.jira_get_worklog` · `scripts.jira_projects.{jira_get_all_projects, jira_get_project_issues, jira_get_project_versions}` · `scripts.jira_users.jira_get_user_profile`

### Jira write (gated)
`scripts.jira_issues.{jira_create_issue, jira_update_issue, jira_delete_issue, jira_add_comment}` · `scripts.jira_workflow.jira_transition_issue` · `scripts.jira_agile.{jira_create_sprint, jira_update_sprint}` · `scripts.jira_links.{jira_create_issue_link, jira_link_to_epic, jira_remove_issue_link}` · `scripts.jira_worklog.jira_add_worklog` · `scripts.jira_projects.jira_create_version`

### Confluence read
`scripts.confluence_pages.confluence_get_page` · `scripts.confluence_search.confluence_search` · `scripts.confluence_comments.confluence_get_comments` · `scripts.confluence_labels.confluence_get_labels`

### Confluence write (gated)
`scripts.confluence_pages.{confluence_create_page, confluence_update_page, confluence_delete_page}` · `scripts.confluence_comments.confluence_add_comment` · `scripts.confluence_labels.{confluence_add_label, confluence_remove_label}`

### Requirements Yogi (read; create/update/delete gated)
Requirements live in a Confluence space and are addressed by `space_key` +
`requirement_key` (e.g. `space_key=THCU requirement_key=IAM_001` — keys use
UNDERSCORES, not hyphens). The Requirements Yogi REST API requires BOTH the
space and the key (`/requirement2/{spaceKey}/{key}`) — you cannot fetch by bare
key. To browse a space first, use `requirement_yogi_list_requirements`.
- `requirement_yogi_list_requirements(space_key, query=None, limit=...)` — list/search requirements in a space
- `requirement_yogi_get_requirement(space_key, requirement_key)` — fetch one requirement (title + content)
- `requirement_yogi_create_requirement(space_key, requirement_key, title, content_html, properties)` — **gated**
- `requirement_yogi_update_requirement(space_key, requirement_key, title, content_html, properties)` — **gated**
- `requirement_yogi_delete_requirement(space_key, requirement_key)` — **gated**
- `requirement_yogi_bulk_update_requirements(space_key, requirements)` — **gated**

Example (single self-contained line; note the UNDERSCORE in the key):
```bash
cd "$HOME/.pi/agent/git/github.com/sriluxman/atlassian-skills/atlassian-skills" && .venv/bin/python atl_run.py requirement_yogi_get_requirement space_key=THCU requirement_key=IAM_001
```

### Bitbucket (mostly read; PR mutations gated)
`scripts.bitbucket_projects.{bitbucket_list_projects, bitbucket_list_repositories}` · `scripts.bitbucket_pull_requests.{bitbucket_get_pull_request, bitbucket_get_pr_diff, **bitbucket_create_pull_request**, **bitbucket_merge_pull_request**, **bitbucket_decline_pull_request**, **bitbucket_add_pr_comment**}` · `scripts.bitbucket_files.{bitbucket_get_file_content, bitbucket_search}` · `scripts.bitbucket_commits.{bitbucket_get_commits, bitbucket_get_commit}`

## Errors

All functions return JSON. On failure: `{"success": false, "error": "...", "error_type": "..."}`.
Error types: `ConfigurationError`, `AuthenticationError`, `ValidationError`, `NotFoundError`, `APIError`, `NetworkError`.

## Time format (worklog)

`1w` `2d` `3h` `30m` or combined like `1d 4h 30m`.
