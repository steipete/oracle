---
title: Quickstart
description: "From install to first Oracle consult in five minutes — pick API or browser mode, send a bundle, replay the session."
---

This walks through the minimum to get a useful answer back. If you haven't installed Oracle yet, start with [Install](install.md).

## 1. Pick a mode

| Mode    | When to use it                                                     | What you need                             |
| ------- | ------------------------------------------------------------------ | ----------------------------------------- |
| API     | You have an API key and want reliability + multi-model.            | `OPENAI_API_KEY` (or Gemini / Anthropic). |
| Browser | You have a ChatGPT Plus/Pro account and want GPT-5.5 Pro for free. | Chrome on macOS / Linux / Windows.        |
| Render  | Air-gapped review, paste into the model of your choice.            | Just Oracle.                              |

If both are available Oracle picks API by default (cheaper to short-circuit). Override per-run with `--engine browser`.

## 2. Your first run

### API mode

```bash
export OPENAI_API_KEY=sk-...
oracle -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts" \
  --file "!**/*.test.ts"
```

Oracle prints the assistant's reply on stdout and stores the run under `~/.oracle/sessions/<id>/`.

### Browser mode (no API key)

First run — log in once, browser stays open:

```bash
oracle --engine browser --browser-manual-login \
  --browser-keep-browser --browser-input-timeout 120000 \
  -p "HI"
```

Subsequent runs reuse the saved profile:

```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s \
  --browser-auto-reattach-interval 3s \
  --browser-auto-reattach-timeout 60s \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

`--browser-manual-login` skips Keychain cookie copy (no permission popups) and reuses a persistent automation profile under `~/.oracle/browser/`.

### Render and copy

```bash
oracle --render --copy -p "Architecture review" --file "src/**/*.ts"
```

The bundle is on your clipboard. Paste it into ChatGPT, Claude, Gemini, AI Studio, or wherever you want the answer.

## 3. Preview before you spend

```bash
oracle --dry-run summary --files-report \
  -p "Audit the storage layer for race conditions" \
  --file "src/**/*.ts"
```

`--dry-run summary` lists token counts per file plus the assembled prompt size. Use it to spot a runaway directory before sending. `--dry-run full` prints the entire bundle; `--dry-run json` is structured for tools.

## 4. Multi-model cross-check

Check keys/routes first:

```bash
oracle doctor --providers --models gpt-5.5-pro,gemini-3-pro,claude-4.6-sonnet
```

```bash
oracle -p "Cross-check the data layer assumptions" \
  --models gpt-5.5-pro,gemini-3-pro,claude-4.6-sonnet \
  --allow-partial --write-output /tmp/oracle-panel.md \
  --file "src/**/*.ts"
```

One command, three providers. Oracle aggregates cost and token usage per model, writes per-model output files, and can keep successful answers when one provider fails auth or quota. See [Multi-model](multimodel.md) for output formats and [Mythical Pro Agents](mythical-pro-agents.md) for picking the right combo.

Need startup proof for a slow CLI path?

```bash
oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "Quick smoke"
```

## 5. Reattach to a long run

GPT-5.x Pro replies can take 10 minutes to over an hour. API runs detach by default; reattach later:

```bash
oracle status --hours 24
oracle session <id> --render
```

For browser runs, `--browser-auto-reattach-*` polls the existing ChatGPT tab when the page redirects mid-load. See [Sessions](sessions.md) for the full lifecycle.

## 6. Wire it into your coding agent

Drop this in `AGENTS.md` or `CLAUDE.md`:

```
- Oracle bundles a prompt plus the right files so a Pro model (GPT-5.5 Pro, Gemini 3 Pro, Claude Opus) can answer. Use when stuck, debugging, or reviewing.
- Run `npx -y @steipete/oracle --help` once per session before first use.
```

Or wire MCP — see [MCP](mcp.md) and [Agents](agents.md).

## Where to go next

- [Mythical Pro Agents](mythical-pro-agents.md) — model lineup, costs, when to use which.
- [Browser Mode](browser-mode.md) — full reference for `--engine browser`.
- [Configuration](configuration.md) — defaults in `~/.oracle/config.json`.
- [Followups](followup.md) — continue an existing run with new files.
