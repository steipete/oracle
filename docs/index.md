---
title: Overview
permalink: /
description: "Oracle bundles your prompt and files so a mythical pro agent — GPT-5.5 Pro, Gemini 3 Pro, Claude Opus, and friends — can answer with real repository context. CLI, MCP, browser, and API in one tool."
---

## Try it

After installing (`brew install steipete/tap/oracle` or `npm i -g @steipete/oracle`), every consult is a one-liner.

```bash
# Browser path — no API key, drives ChatGPT directly (default: GPT-5.5 Pro).
oracle --engine browser -p "Review the storage layer for schema drift" --file "src/**/*.ts"

# API path — multi-model cross-check in one run.
oracle -p "Cross-check the data layer assumptions" \
  --models gpt-5.5-pro,gemini-3-pro,claude-4.6-sonnet \
  --file "src/**/*.ts"

# Manual fallback — assemble the bundle and copy it to your clipboard.
oracle --render --copy -p "Architecture review" --file "src/**/*.ts"

# Sessions you can replay or continue.
oracle status --hours 72
oracle session <id> --render
oracle --followup <id> -p "Re-evaluate with this new context" --file "src/**/*.ts"
```

`--render` emits the assembled markdown, sessions persist machine-readable metadata, and progress stays out of saved answers so pipes remain usable.

## What Oracle does

- **One CLI to a stable of pro agents.** GPT-5.5 Pro (default), GPT-5.5, GPT-5.4 Pro, GPT-5.4, GPT-5.2 Pro, GPT-5.1 Pro, GPT-5.1 Codex, Gemini 3.1 Pro, Gemini 3 Pro, Claude Sonnet 4.6, Claude Opus 4.1 — plus any OpenRouter id.
- **Engines, plural.** API mode for reliability, browser mode (Chrome over CDP) when you don't want to pay or want the Pro tier, `--render --copy` when neither is an option.
- **Multi-model in one run.** Aggregate cost, token usage, and lineage across providers in a single command.
- **Followups + lineage.** Continue from any stored session id or `resp_…` response id; `oracle status` shows parent/child trees.
- **Sessions you can replay.** Every run is stored under `~/.oracle/sessions/<id>/`. Reattach to long browser runs without re-spending tokens.
- **Built for coding agents.** Use it from Claude Code, Codex, Cursor, or any MCP host via `oracle-mcp`. Plain stdout JSON envelopes for scripting.
- **Bundles, not chats.** Globs + excludes + size guards + `--files-report` so you know exactly what is shipped to the model.

## Pick your path

- **Trying it.** [Install](install.md) → [Quickstart](quickstart.md). Five minutes from `brew install` to your first answer.
- **Choosing a model.** The [Mythical Pro Agents](mythical-pro-agents.md) lineup covers when to reach for GPT-5.5 Pro vs. Gemini 3 Pro vs. Claude Opus, and what each costs.
- **Wiring up an agent.** [Agents](agents.md) covers Claude Code, Codex, Cursor, and the `oracle` skill. [MCP](mcp.md) plugs Oracle into any MCP-aware client.
- **Driving ChatGPT without keys.** [Browser mode](browser-mode.md) walks through manual-login profiles, attach-running, remote browsers, and Deep Research.
- **Long Pro runs.** [Sessions](sessions.md) and the [followup](followup.md) flow handle background runs, reattach, and lineage.

## Why "mythical pro agents"?

The frontier models marked "Pro" — GPT-5.5 Pro, Gemini 3 Pro, Claude Opus, OpenAI Deep Research — are slow, expensive, and gated behind ChatGPT Plus / Pro tiers, separate APIs, or per-token bills that scale fast. Oracle is the single entry point: one config, one session store, one set of flags. Bundle the right files, ask the right model, get a second opinion without remembering which provider charges for what.

## Project

Active development under MIT. The [changelog](https://github.com/steipete/oracle/blob/main/CHANGELOG.md) tracks recent releases. Source on [GitHub](https://github.com/steipete/oracle). Not affiliated with OpenAI, Google, or Anthropic.
