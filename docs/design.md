# pi-frugal — design rationale

This document captures the **why** behind each choice. The README covers the
**what** and **how** (install, configure, use). This file is for future you,
or for anyone wondering why we didn't just take the obvious path.

## The problem we were optimizing

Original setup: `opencode + GitHub Copilot bridge + mcp-atlassian-ry MCP
server + default Opus on every prompt`. Cost characteristics measured on real
usage:

- ~5 000 tokens of MCP tool schemas loaded into the system prompt on every
  turn, regardless of whether the turn touched Atlassian.
- Opus 4.7 pricing applied to every prompt, including pure retrieval like
  "list the open issues in this project" — work that Haiku handles fine.
- Cost displayed in USD from a generic price table, while billing was actually
  in AiCredits at a different rate — invisible cost drift.

Two structural levers presented themselves: kill the always-on tool overhead,
and stop spending Opus rates on Haiku-grade work.

## Design decisions

### 1. Skills > MCP for Atlassian access

A pi skill description (~150 tokens) is loaded into the system prompt every
turn; the skill body (~7 KB here) is loaded **only when the agent invokes
it**, and is then cached for the rest of the session.

An MCP server, by contrast, ships every tool schema into the system prompt on
every turn, plus runs a persistent subprocess.

For Jira/Confluence work, which is bursty (we touch it ~10% of turns), the
per-turn amortized cost of the skill approach is ~30× lower. The skill also
removes a persistent process and is updatable via `git pull` instead of a
package rebuild.

### 2. Thin overlay over a thick upstream toolkit

The upstream `langpingxue/atlassian-skills` has a full 45-function catalog
and a 17 KB SKILL.md describing all of them. Our overlay (~250 lines) lists
only what the agent needs to **find** functions, then tells it to `read` the
upstream SKILL.md / REFERENCE.md on demand for exact signatures.

Result: every turn pays for the thin overlay's description (~390 chars). The
deep reference is paid for at cacheRead rates only on the rare turns that
need it.

### 3. Tier router as a pi extension, not a skill

Why an extension and not a skill:

- A skill instructs the model. The model is then free to ignore the
  instruction or partially apply it.
- An extension changes the pi process state directly. `pi.setModel()` is
  authoritative — the model literally cannot choose a different one.

We want model selection to be a *deterministic* property of the prompt, not a
suggestion to the model. Hence an extension that runs in
`before_agent_start`, classifies the prompt with regex rules, and calls
`setModel` + `setThinkingLevel` before the first token is sent.

### 4. Rule-based classifier (not LLM-based)

We considered using Haiku to classify each prompt into a tier. Rejected for
three reasons:

- It adds an LLM call on every turn — even a cheap one is more expensive than
  a regex evaluation, especially when ~80% of prompts have obvious keywords
  ("list", "brainstorm", "refactor").
- The classification call itself becomes the dominant latency for short
  retrieval prompts.
- Determinism: the same prompt should always go to the same tier. Regex gives
  us that for free.

The price of regex classification is occasional misclassifications. We
mitigate with:

- Conservative tie-breaking: `opus > sonnet > haiku`. Ambiguity always
  upgrades, never downgrades.
- A default-to-opus fallback when no signal is found.
- Explicit user overrides (`!haiku`, `!sonnet`, `!opus`) for prompts where
  the heuristic guesses wrong.

### 5. Safety guards on auto-routing

Two failure modes we explicitly prevented:

- **Context overflow.** Haiku has a smaller context window. If we route a
  "summarize this" prompt to Haiku after the session has already accumulated
  120 K tokens, the call fails. The router checks `ctx.getContextUsage()` and
  auto-promotes to Sonnet when context > 100 K.
- **Fighting the user.** If the user explicitly picks a model via `/model`
  or `Ctrl+P`, the router records that as a manual pin and stops
  auto-switching for the session. They release the pin with `/route auto`.

### 6. AiCredits visibility as a separate extension

The footer is split out from the router because:

- It's useful even without the router (anyone using pi with AiCredits
  billing benefits).
- It has different update triggers (session message events vs. before-agent
  events) and different data dependencies.
- Toggle independently (`/credits-footer`).

The rates are env-overridable because billing tiers differ per customer.
Shipped defaults are based on one published rate sheet for github-copilot's
Claude offerings; users should verify against their own.

### 7. PAT secrets outside the package

Three options were considered:

- Env vars only. Forces the user to edit `.bashrc`. Painful.
- OS keychain (libsecret / Windows credman). Cross-platform pain; runtime
  dep.
- A chmod-600 file in a centralised secrets dir. Familiar shape, repeatable,
  works on any POSIX-ish system.

Chose the file. Same risk surface as a `.ssh/id_rsa` — the user already
manages files like this. The setup script enforces mode 600 in a 700 dir,
and the verify script self-heals if mode drifts.

### 8. Composition over bundling for upstream skills

We could vendor `obra/superpowers` and `langpingxue/atlassian-skills` into
the package for a one-shot install. Rejected:

- Updates lag behind upstream until we cut a new release.
- License attribution complexity.
- Package size balloons.
- Disrespects the maintainers' release cadence.

Composition (3 `pi install` commands) is honest about the dependencies and
keeps each piece independently updateable. The `install-deps.sh` script
makes the 3-command sequence into a 1-command sequence for convenience.

## What we deliberately did *not* include

- **po-advisor / architecture-advisor** — these are personal/role-specific
  agents from the original setup. They have value for one engineer, not
  general distribution.
- **Compaction policy** — pi's default works fine for sessions under ~80 K
  tokens. A custom policy is an obvious follow-up but is opt-in territory.
- **Telemetry / spend logging** — the AiCredits footer shows live values;
  per-session SQLite logging was discussed but felt like a separate
  package's job.
- **Semantic code search / llm-wiki** — flagged as the next-highest ROI
  optimizations, but neither has a tight enough scope yet to ship as part
  of "lean setup".

## Provenance

This package was extracted from a working setup at an industrial-automation
company. The measured numbers in the README (∼33× token overhead reduction,
∼2.7× blended cost reduction) come from that migration's before/after
benchmarks documented in an internal Confluence space.
