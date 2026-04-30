# oracle 🧿 — Whispering your tokens to the silicon sage

<p align="center">
  <img src="./README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steipete/oracle"><img src="https://img.shields.io/npm/v/@steipete/oracle?style=for-the-badge&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/steipete/oracle/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/steipete/oracle/ci.yml?branch=main&style=for-the-badge&label=tests" alt="CI Status"></a>
  <a href="https://github.com/steipete/oracle"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License"></a>
</p>

Oracle bundles your prompt and files so another AI can answer with real context. It speaks GPT-5.4 Pro (API default), GPT-5.4, GPT-5.1 Pro, GPT-5.1 Codex (API-only), GPT-5.1, GPT-5.2, Gemini 3.1 Pro (API-only), Gemini 3 Pro, Claude Sonnet 4.5, Claude Opus 4.1, and more—and it can ask one or multiple models in a single run. Browser automation supports ChatGPT GPT-5.5 Pro for signed-in subscription sessions; use `--browser-model-strategy current` to keep the active ChatGPT model (or `ignore` to skip the picker). API remains the most reliable path, and `--copy` is an easy manual fallback.

## Setting up (macOS Browser Mode)

Browser mode lets you use GPT-5.5 Pro without any API keys when your signed-in ChatGPT account has access — it automates your Chrome browser directly.

### First-time login

Run this once to create an automation profile and log into ChatGPT. The browser will stay open so you can complete the login:

```bash
oracle --engine browser --browser-manual-login \
  --browser-keep-browser --browser-input-timeout 120000 \
  -p "HI"
```

### Subsequent runs

Once logged in, the automation profile is saved. Use this for all future runs:

```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s \
  --browser-auto-reattach-interval 3s \
  --browser-auto-reattach-timeout 60s \
  -p "your prompt"
```

> **Why these flags?**
>
> - `--browser-manual-login` — Skips macOS Keychain cookie access (avoids repeated permission popups)
> - `--browser-auto-reattach-*` — Reconnects when ChatGPT redirects mid-page-load (fixes "Inspected target navigated or closed" error)
> - `--browser-keep-browser` — Keeps browser open for first-time login (not needed after)
> - `--browser-input-timeout 120000` — Gives you 2 minutes to log in on first run

## Quick start

Install globally: `npm install -g @steipete/oracle`
Homebrew: `brew install steipete/tap/oracle`

Requires Node 22+. Or use `npx -y @steipete/oracle …` (or pnpx).

```bash
# Copy the bundle and paste into ChatGPT
npx -y @steipete/oracle --render --copy -p "Review the TS data layer for schema drift" --file "src/**/*.ts,*/*.test.ts"

# Minimal API run (expects OPENAI_API_KEY in your env)
npx -y @steipete/oracle -p "Write a concise architecture note for the storage adapters" --file src/storage/README.md

# Multi-model API run
npx -y @steipete/oracle -p "Cross-check the data layer assumptions" --models gpt-5.1-pro,gemini-3-pro --file "src/**/*.ts"

# Follow up from an existing OpenAI/Azure session id
npx -y @steipete/oracle --engine api --model gpt-5.2-pro --followup release-readiness-audit --followup-model gpt-5.2-pro -p "Re-evaluate with this new context" --file "src/**/*.ts"

# Follow up directly from an OpenAI Responses API id
npx -y @steipete/oracle --engine api --model gpt-5.2-pro --followup resp_abc1234567890 -p "Continue from this response" --file docs/notes.md

# Preview without spending tokens
npx -y @steipete/oracle --dry-run summary -p "Check release notes" --file docs/release-notes.md

# Browser run (no API key, will open ChatGPT)
npx -y @steipete/oracle --engine browser -p "Walk through the UI smoke test" --file "src/**/*.ts"

# Gemini browser mode (no API key; uses Chrome cookies from gemini.google.com)
npx -y @steipete/oracle --engine browser --model gemini-3-pro --prompt "a cute robot holding a banana" --generate-image out.jpg --aspect 1:1

# Sessions (list and replay)
npx -y @steipete/oracle status --hours 72
npx -y @steipete/oracle session <id> --render
npx -y @steipete/oracle restart <id>

# TUI (interactive, only for humans)
npx -y @steipete/oracle tui
```

Engine auto-picks API when `OPENAI_API_KEY` is set, otherwise browser; browser is stable on macOS and works on Linux and Windows. On Linux pass `--browser-chrome-path/--browser-cookie-path` if detection fails; on Windows prefer `--browser-manual-login` or inline cookies if decryption is blocked.

## Integration

**CLI**

- API mode expects API keys in your environment: `OPENAI_API_KEY` (GPT-5.x), `GEMINI_API_KEY` (Gemini 3.1 Pro / Gemini 3 Pro), `ANTHROPIC_API_KEY` (Claude Sonnet 4.5 / Opus 4.1).
- Gemini browser mode uses Chrome cookies instead of an API key—just be logged into `gemini.google.com` in Chrome (no Python/venv required).
- If your Gemini account can’t access “Pro”, Oracle auto-falls back to a supported model for web runs (and logs the fallback in verbose mode).
- Prefer API mode or `--copy` + manual paste; browser automation is experimental.
- Browser support: stable on macOS; works on Linux (add `--browser-chrome-path/--browser-cookie-path` when needed) and Windows (manual-login or inline cookies recommended when app-bound cookies block decryption).
- Remote browser service: `oracle serve` on a signed-in host; clients use `--remote-host/--remote-token`.
- AGENTS.md/CLAUDE.md:
  ```
  - Oracle bundles a prompt plus the right files so another AI (GPT 5 Pro + more) can answer. Use when stuck/bugs/reviewing.
  - Run `npx -y @steipete/oracle --help` once per session before first use.
  ```
- Tip: set `browser.chatgptUrl` in config (or `--chatgpt-url`) to a dedicated ChatGPT project folder so browser runs don’t clutter your main history.

**Codex skill**

- Copy the bundled skill from this repo to your Codex skills folder:
  - `mkdir -p ~/.codex/skills`
  - `cp -R skills/oracle ~/.codex/skills/oracle`
- Then reference it in your `AGENTS.md`/`CLAUDE.md` so Codex loads it.

**MCP**

- Run the stdio server via `oracle-mcp`.
- Configure clients via [steipete/mcporter](https://github.com/steipete/mcporter) or `.mcp.json`; see [docs/mcp.md](docs/mcp.md) for connection examples.

```bash
npx -y @steipete/oracle oracle-mcp
```

- Cursor setup (MCP): drop a `.cursor/mcp.json` like below, then pick “oracle” in Cursor’s MCP sources. See https://cursor.com/docs/context/mcp for UI steps.
  [![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en-US/install-mcp?name=oracle&config=eyJjb21tYW5kIjoibnB4IC15IEBzdGVpcGV0ZS9vcmFjbGUgb3JhY2xlLW1jcCJ9)

```json
{
  "oracle": {
    "command": "oracle-mcp",
    "args": []
  }
}
```

## Highlights

- Bundle once, reuse anywhere (API or experimental browser).
- Multi-model API runs with aggregated cost/usage, including OpenRouter IDs alongside first-party models.
- Render/copy bundles for manual paste into ChatGPT when automation is blocked.
- GPT‑5 Pro API runs detach by default; reattach via `oracle session <id>` / `oracle status` or block with `--wait`.
- OpenAI/Azure follow-up API runs can continue from `--followup <sessionId|responseId>`; for multi-model parents, add `--followup-model <model>`.
- Azure endpoints supported via `--azure-endpoint/--azure-deployment/--azure-api-version` or `AZURE_OPENAI_*` envs.
- File safety: globs/excludes, size guards, `--files-report`.
- Sessions you can replay (`oracle status`, `oracle session <id> --render`).
- Session logs and bundles live in `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).

## Follow-up and lineage

Use `--followup` to continue an existing OpenAI/Azure Responses API run with additional context/files:

```bash
oracle \
  --engine api \
  --model gpt-5.2-pro \
  --followup <existing-session-id-or-resp_id> \
  --followup-model gpt-5.2-pro \
  --slug "my-followup-run" \
  --wait \
  -p "Follow-up: re-evaluate the previous recommendation with the attached files." \
  --file "server/src/strategy/plan.ts" \
  --file "server/src/strategy/executor.ts"
```

When the parent session used `--models`, `--followup-model` picks which model's response id to chain from.
Custom `--base-url` providers plus Gemini/Claude API runs are excluded here because they do not preserve `previous_response_id` in Oracle.

`oracle status` shows parent/child lineage in tree form:

```text
Recent Sessions
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.2-pro   api     03/01/2026 09:00 AM  1800  $2.110  architecture-review-parent
completed gpt-5.2-pro   api     03/01/2026 09:14 AM  2200  $2.980  ├─ architecture-review-followup
running   gpt-5.2-pro   api     03/01/2026 09:22 AM  1400       -  │  └─ architecture-review-implementation-pass
pending   gpt-5.2-pro   api     03/01/2026 09:25 AM   900       -  └─ architecture-review-risk-check
```

## Browser auto-reattach (long Pro runs)

When browser runs time out (common with long GPT‑5.x Pro responses), Oracle can keep polling the existing ChatGPT tab and capture the final answer without manual `oracle session <id>` commands.

Enable auto-reattach by setting a non-zero interval:

- `--browser-auto-reattach-delay` — wait before the first retry (e.g. `30s`)
- `--browser-auto-reattach-interval` — how often to retry (e.g. `2m`)
- `--browser-auto-reattach-timeout` — per-attempt budget (default `2m`)

```bash
oracle --engine browser \
  --browser-timeout 6m \
  --browser-auto-reattach-delay 30s \
  --browser-auto-reattach-interval 2m \
  --browser-auto-reattach-timeout 2m \
  -p "Run the long UI audit" --file "src/**/*.ts"
```

## Flags you’ll actually use

| Flag                                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-p, --prompt <text>`                                           | Required prompt.                                                                                                                                                                                                                                                                                                                                                               |
| `-f, --file <paths...>`                                         | Attach files/dirs (globs + `!` excludes).                                                                                                                                                                                                                                                                                                                                      |
| `-e, --engine <api\|browser>`                                   | Choose API or browser (browser is experimental).                                                                                                                                                                                                                                                                                                                               |
| `-m, --model <name>`                                            | Built-ins (`gpt-5.4-pro` API default, `gpt-5.4`, `gpt-5.1-pro`, `gpt-5-pro`, `gpt-5.1`, `gpt-5.1-codex` API-only, `gpt-5.2`, `gpt-5.2-instant`, `gpt-5.2-pro`, `gemini-3.1-pro` API-only, `gemini-3-pro`, `claude-4.5-sonnet`, `claude-4.1-opus`) plus browser labels like `gpt-5.5-pro` / `gpt-5.5` and any OpenRouter id (e.g., `minimax/minimax-m2`, `openai/gpt-4o-mini`). |
| `--models <list>`                                               | Comma-separated API models (mix built-ins and OpenRouter ids) for multi-model runs.                                                                                                                                                                                                                                                                                            |
| `--followup <sessionId\|responseId>`                            | Continue an OpenAI/Azure Responses API run from a stored oracle session or `resp_...` response id.                                                                                                                                                                                                                                                                             |
| `--followup-model <model>`                                      | For multi-model OpenAI/Azure parent sessions, choose which model response to continue from.                                                                                                                                                                                                                                                                                    |
| `--base-url <url>`                                              | Point API runs at LiteLLM/Azure/OpenRouter/etc.                                                                                                                                                                                                                                                                                                                                |
| `--chatgpt-url <url>`                                           | Target a ChatGPT workspace/folder (browser).                                                                                                                                                                                                                                                                                                                                   |
| `--browser-model-strategy <select\|current\|ignore>`            | Control ChatGPT model selection in browser mode (current keeps the active model; ignore skips the picker).                                                                                                                                                                                                                                                                     |
| `--browser-manual-login`                                        | Skip cookie copy; reuse a persistent automation profile and wait for manual ChatGPT login.                                                                                                                                                                                                                                                                                     |
| `--browser-thinking-time <light\|standard\|extended\|heavy>`    | Set ChatGPT thinking-time intensity (browser; available levels depend on the selected ChatGPT model, e.g. GPT-5.5 Pro may appear as Pro Extended and exposes Standard/Extended while Thinking 5.5 may appear as Thinking Heavy).                                                                                                                                               |
| `--browser-port <port>`                                         | Pin the Chrome DevTools port (WSL/Windows firewall helper).                                                                                                                                                                                                                                                                                                                    |
| `--browser-inline-cookies[(-file)] <payload \| path>`           | Supply cookies without Chrome/Keychain (browser).                                                                                                                                                                                                                                                                                                                              |
| `--browser-timeout`, `--browser-input-timeout`                  | Control overall/browser input timeouts (supports h/m/s/ms).                                                                                                                                                                                                                                                                                                                    |
| `--browser-recheck-delay`, `--browser-recheck-timeout`          | Delayed recheck for long Pro runs: wait then retry capture after timeout (supports h/m/s/ms).                                                                                                                                                                                                                                                                                  |
| `--browser-reuse-wait`                                          | Wait for a shared Chrome profile before launching (parallel browser runs).                                                                                                                                                                                                                                                                                                     |
| `--browser-profile-lock-timeout`                                | Wait for the shared manual-login profile lock before sending (serializes parallel runs).                                                                                                                                                                                                                                                                                       |
| `--render`, `--copy`                                            | Print and/or copy the assembled markdown bundle.                                                                                                                                                                                                                                                                                                                               |
| `--wait`                                                        | Block for background API runs (e.g., GPT‑5.1 Pro) instead of detaching.                                                                                                                                                                                                                                                                                                        |
| `--timeout <seconds\|auto>`                                     | Overall API deadline (auto = 60m for pro, 120s otherwise).                                                                                                                                                                                                                                                                                                                     |
| `--background`, `--no-background`                               | Force Responses API background mode (create + retrieve) for API runs.                                                                                                                                                                                                                                                                                                          |
| `--http-timeout <ms\|s\|m\|h>`                                  | HTTP client timeout (default 20m).                                                                                                                                                                                                                                                                                                                                             |
| `--zombie-timeout <ms\|s\|m\|h>`                                | Override stale-session cutoff used by `oracle status`.                                                                                                                                                                                                                                                                                                                         |
| `--zombie-last-activity`                                        | Use last log activity to detect stale sessions.                                                                                                                                                                                                                                                                                                                                |
| `--write-output <path>`                                         | Save only the final answer (multi-model adds `.<model>`).                                                                                                                                                                                                                                                                                                                      |
| `--files-report`                                                | Print per-file token usage.                                                                                                                                                                                                                                                                                                                                                    |
| `--dry-run [summary\|json\|full]`                               | Preview without sending.                                                                                                                                                                                                                                                                                                                                                       |
| `--remote-host`, `--remote-token`                               | Use a remote `oracle serve` host (browser).                                                                                                                                                                                                                                                                                                                                    |
| `--remote-chrome <host:port>`                                   | Attach to an existing remote Chrome session (browser).                                                                                                                                                                                                                                                                                                                         |
| `--youtube <url>`                                               | YouTube video URL to analyze (Gemini browser mode).                                                                                                                                                                                                                                                                                                                            |
| `--generate-image <file>`                                       | Generate image and save to file (Gemini browser mode).                                                                                                                                                                                                                                                                                                                         |
| `--edit-image <file>`                                           | Edit existing image with `--output` (Gemini browser mode).                                                                                                                                                                                                                                                                                                                     |
| `--azure-endpoint`, `--azure-deployment`, `--azure-api-version` | Target Azure OpenAI endpoints (picks Azure client automatically).                                                                                                                                                                                                                                                                                                              |

## Configuration

Put defaults in `~/.oracle/config.json` (JSON5). Example:

```json5
{
  model: "gpt-5.4-pro",
  engine: "api",
  filesReport: true,
  browser: {
    chatgptUrl: "https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project",
  },
}
```

Use `browser.chatgptUrl` (or the legacy alias `browser.url`) to target a specific ChatGPT workspace/folder for browser automation.
See [docs/configuration.md](docs/configuration.md) for precedence and full schema.

Advanced flags

| Area         | Flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser      | `--browser-manual-login`, `--browser-thinking-time`, `--browser-timeout`, `--browser-input-timeout`, `--browser-recheck-delay`, `--browser-recheck-timeout`, `--browser-reuse-wait`, `--browser-profile-lock-timeout`, `--browser-auto-reattach-delay`, `--browser-auto-reattach-interval`, `--browser-auto-reattach-timeout`, `--browser-cookie-wait`, `--browser-inline-cookies[(-file)]`, `--browser-attachments`, `--browser-inline-files`, `--browser-bundle-files`, `--browser-keep-browser`, `--browser-headless`, `--browser-hide-window`, `--browser-no-cookie-sync`, `--browser-allow-cookie-errors`, `--browser-chrome-path`, `--browser-cookie-path`, `--chatgpt-url` |
| Run control  | `--background`, `--no-background`, `--http-timeout`, `--zombie-timeout`, `--zombie-last-activity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Azure/OpenAI | `--azure-endpoint`, `--azure-deployment`, `--azure-api-version`, `--base-url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Remote browser example

```bash
# Host (signed-in Chrome): launch serve
oracle serve --host 0.0.0.0:9473 --token secret123

# Client: target that host
oracle --engine browser --remote-host 192.168.1.10:9473 --remote-token secret123 -p "Run the UI smoke" --file "src/**/*.ts"

# If cookies can’t sync, pass them inline (JSON/base64)
oracle --engine browser --browser-inline-cookies-file ~/.oracle/cookies.json -p "Run the UI smoke" --file "src/**/*.ts"
```

Session management

```bash
# Prune stored sessions (default path ~/.oracle/sessions; override ORACLE_HOME_DIR)
oracle status --clear --hours 168
```

## More docs

- Bridge (Windows host → Linux client): [docs/bridge.md](docs/bridge.md)
- Browser mode & forks: [docs/browser-mode.md](docs/browser-mode.md) (includes `oracle serve` remote service), [docs/chromium-forks.md](docs/chromium-forks.md), [docs/linux.md](docs/linux.md)
- MCP: [docs/mcp.md](docs/mcp.md)
- OpenAI/Azure/OpenRouter endpoints: [docs/openai-endpoints.md](docs/openai-endpoints.md), [docs/openrouter.md](docs/openrouter.md)
- Manual smokes: [docs/manual-tests.md](docs/manual-tests.md)
- Testing: [docs/testing.md](docs/testing.md)

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com  
Name inspired by: https://ampcode.com/news/oracle

## More free stuff from steipete

- ✂️ [Trimmy](https://trimmy.app) — “Paste once, run once.” Flatten multi-line shell snippets so they paste and run.
- 🟦🟩 [CodexBar](https://codexbar.app) — Keep Codex token windows visible in your macOS menu bar.
- 🧳 [MCPorter](https://mcporter.dev) — TypeScript toolkit + CLI for Model Context Protocol servers.
