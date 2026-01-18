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

Oracle bundles your prompt and files so another AI can answer with real context. It speaks GPT-5.1 Pro (default alias to GPT-5.2 Pro on the API), GPT-5.1 Codex (API-only), GPT-5.1, GPT-5.2, Gemini 3 Pro, Claude Sonnet 4.5, Claude Opus 4.1, and more—and it can ask one or multiple models in a single run. Browser automation is available; use `--browser-model-strategy current` to keep the active ChatGPT model (or `ignore` to skip the picker). API remains the most reliable path, and `--copy` is an easy manual fallback.

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

# Preview without spending tokens
npx -y @steipete/oracle --dry-run summary -p "Check release notes" --file docs/release-notes.md

# Browser run (no API key, will open ChatGPT)
npx -y @steipete/oracle --engine browser -p "Walk through the UI smoke test" --file "src/**/*.ts"

# Gemini browser mode (no API key; uses Chrome cookies from gemini.google.com)
npx -y @steipete/oracle --engine browser --model gemini-3-pro --prompt "a cute robot holding a banana" --generate-image out.jpg --aspect 1:1

# Sessions (list and replay)
npx -y @steipete/oracle status --hours 72
npx -y @steipete/oracle session <id> --render

# TUI (interactive, only for humans)
npx -y @steipete/oracle tui
```

Engine auto-picks API when `OPENAI_API_KEY` is set, otherwise browser; browser is stable on macOS and works on Linux and Windows. On Linux pass `--browser-chrome-path/--browser-cookie-path` if detection fails; on Windows prefer `--browser-manual-login` or inline cookies if decryption is blocked.

## Integration

**CLI**
- API mode expects API keys in your environment: `OPENAI_API_KEY` (GPT-5.x), `GEMINI_API_KEY` (Gemini 3 Pro), `ANTHROPIC_API_KEY` (Claude Sonnet 4.5 / Opus 4.1).
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
- Azure endpoints supported via `--azure-endpoint/--azure-deployment/--azure-api-version` or `AZURE_OPENAI_*` envs.
- File safety: globs/excludes, size guards, `--files-report`.
- Sessions you can replay (`oracle status`, `oracle session <id> --render`).
- Session logs and bundles live in `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).

## Flags you’ll actually use

| Flag | Purpose |
| --- | --- |
| `-p, --prompt <text>` | Required prompt. |
| `-f, --file <paths...>` | Attach files/dirs (globs + `!` excludes). |
| `-e, --engine <api\|browser>` | Choose API or browser (browser is experimental). |
| `-m, --model <name>` | Built-ins (`gpt-5.1-pro` default, `gpt-5-pro`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.2`, `gpt-5.2-instant`, `gpt-5.2-pro`, `gemini-3-pro`, `claude-4.5-sonnet`, `claude-4.1-opus`) plus any OpenRouter id (e.g., `minimax/minimax-m2`, `openai/gpt-4o-mini`). |
| `--models <list>` | Comma-separated API models (mix built-ins and OpenRouter ids) for multi-model runs. |
| `--base-url <url>` | Point API runs at LiteLLM/Azure/OpenRouter/etc. |
| `--chatgpt-url <url>` | Target a ChatGPT workspace/folder (browser). |
| `--browser-model-strategy <select\|current\|ignore>` | Control ChatGPT model selection in browser mode (current keeps the active model; ignore skips the picker). |
| `--browser-manual-login` | Skip cookie copy; reuse a persistent automation profile and wait for manual ChatGPT login. |
| `--browser-thinking-time <light\|standard\|extended\|heavy>` | Set ChatGPT thinking-time intensity (browser; Thinking/Pro models only). |
| `--browser-port <port>` | Pin the Chrome DevTools port (WSL/Windows firewall helper). |
| `--browser-inline-cookies[(-file)] <payload|path>` | Supply cookies without Chrome/Keychain (browser). |
| `--browser-timeout`, `--browser-input-timeout` | Control overall/browser input timeouts (supports h/m/s/ms). |
| `--render`, `--copy` | Print and/or copy the assembled markdown bundle. |
| `--wait` | Block for background API runs (e.g., GPT‑5.1 Pro) instead of detaching. |
| `--timeout <seconds\|auto>` | Overall API deadline (auto = 60m for pro, 120s otherwise). |
| `--background`, `--no-background` | Force Responses API background mode (create + retrieve) for API runs. |
| `--http-timeout <ms\|s\|m\|h>` | HTTP client timeout (default 20m). |
| `--zombie-timeout <ms\|s\|m\|h>` | Override stale-session cutoff used by `oracle status`. |
| `--zombie-last-activity` | Use last log activity to detect stale sessions. |
| `--write-output <path>` | Save only the final answer (multi-model adds `.<model>`). |
| `--files-report` | Print per-file token usage. |
| `--dry-run [summary\|json\|full]` | Preview without sending. |
| `--remote-host`, `--remote-token` | Use a remote `oracle serve` host (browser). |
| `--remote-chrome <host:port>` | Attach to an existing remote Chrome session (browser). |
| `--youtube <url>` | YouTube video URL to analyze (Gemini browser mode). |
| `--generate-image <file>` | Generate image and save to file (Gemini browser mode). |
| `--edit-image <file>` | Edit existing image with `--output` (Gemini browser mode). |
| `--azure-endpoint`, `--azure-deployment`, `--azure-api-version` | Target Azure OpenAI endpoints (picks Azure client automatically). |

## Configuration

Put defaults in `~/.oracle/config.json` (JSON5). Example:
```json5
{
  model: "gpt-5.1-pro",
  engine: "api",
  filesReport: true,
  browser: {
    chatgptUrl: "https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project"
  }
}
```
Use `browser.chatgptUrl` (or the legacy alias `browser.url`) to target a specific ChatGPT workspace/folder for browser automation.
See [docs/configuration.md](docs/configuration.md) for precedence and full schema.

Advanced flags

| Area | Flags |
| --- | --- |
| Browser | `--browser-manual-login`, `--browser-thinking-time`, `--browser-timeout`, `--browser-input-timeout`, `--browser-cookie-wait`, `--browser-inline-cookies[(-file)]`, `--browser-attachments`, `--browser-inline-files`, `--browser-bundle-files`, `--browser-keep-browser`, `--browser-headless`, `--browser-hide-window`, `--browser-no-cookie-sync`, `--browser-allow-cookie-errors`, `--browser-chrome-path`, `--browser-cookie-path`, `--chatgpt-url` |
| Run control | `--background`, `--no-background`, `--http-timeout`, `--zombie-timeout`, `--zombie-last-activity` |
| Azure/OpenAI | `--azure-endpoint`, `--azure-deployment`, `--azure-api-version`, `--base-url` |

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
