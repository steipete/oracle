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

Oracle gives your agents a simple, reliable way to **bundle a prompt plus the right files and hand them to another AI**. It currently speaks GPT-5.1 and GPT-5 Pro; Pro runs can take up to ten minutes and often return remarkably strong answers.

## Two engines, one CLI

- **API engine** — Calls the OpenAI Responses API. Needs `OPENAI_API_KEY`.
- **Browser engine** — Automates ChatGPT in Chrome so you can use your Pro account directly. Toggle with `--engine browser`; no API key required.

If you omit `--engine`, Oracle prefers the API engine when `OPENAI_API_KEY` is present; otherwise it falls back to browser mode. Switch explicitly with `-e, --engine {api|browser}` when you want to override the auto choice. Everything else (prompt assembly, file handling, session logging) stays the same.

Note: Browser engine is considered experimental, requires an OpenAI Pro account and only works on macOS with Chrome.
Your system password is needed to copy cookies. API engine is stable and should be preferred.

## Quick start

```bash
# One-off (no install)
OPENAI_API_KEY=sk-... npx -y @steipete/oracle -p "Summarize the risk register" --file docs/risk-register.md docs/risk-matrix.md

# Browser engine (no API key)
npx -y @steipete/oracle --engine browser -p "Summarize the risk register" --file docs/risk-register.md docs/risk-matrix.md

# Globs/exclusions
npx -y @steipete/oracle -p "Review the TS data layer" --file "src/**/*.ts" --file "!src/**/*.test.ts"

# Mixed glob + single file
npx -y @steipete/oracle -p "Audit data layer" --file "src/**/*.ts" --file README.md

# Alternate base URL (LiteLLM, Azure, self-hosted gateways)
OPENAI_API_KEY=sk-... oracle --base-url https://litellm.example.com/v1 -p "Summarize the risk register"

# Inspect past sessions
oracle status --clear --hours 168   # prune a week of cached runs
oracle status                       # list runs; grab an ID
oracle session <id>                 # replay a run locally
```

## How do I integrate this?

**CLI** (direct calls; great for CI or scripted tasks)
- One-liner in CI: `OPENAI_API_KEY=sk-... npx -y @steipete/oracle --prompt "Smoke-check latest PR" --file src/ docs/ --preview summary`.
- Package script: add `"oracle": "oracle --prompt \"Review the diff\" --file ."` to `package.json`, then run `OPENAI_API_KEY=... pnpm oracle`.
- Don’t want to export the key? Inline works: `OPENAI_API_KEY=sk-... oracle -p "Quick check" --file src/`.

**MCP** (tools + resources; mix-and-match with the CLI sessions)
- Run the bundled stdio server: `pnpm mcp` (or `oracle-mcp`) after `pnpm build`. Tools: `consult`, `sessions`; resources: `oracle-session://{id}/{metadata|log|request}`. Details in [docs/mcp.md](docs/mcp.md).
- mcporter config (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@steipete/oracle", "oracle-mcp"]
  }
  ```
- You can call the MCP tools against sessions created by the CLI (shared `~/.oracle/sessions`), and vice versa.

## Highlights

- **Bundle once, reuse anywhere** — Prompt + files become a markdown package the model can cite.
- **Flexible file selection** — Glob patterns and `!` excludes let you scoop up or skip files without scripting.
- **Pro-friendly** — GPT-5 Pro background runs stay alive for ~10 minutes with reconnection + token/cost tracking.
- **Two paths, one UX** — API or browser, same flags and session logs.
- **Search on by default** — The model can ground answers with fresh citations.
- **File safety** — Per-file token accounting and size guards; `--files-report` shows exactly what you’re sending.
- **Readable previews** — `--preview` / `--render-markdown` let you inspect the bundle before spending.

## Configuration

Put per-user defaults in `~/.oracle/config.json` (parsed as JSON5, so comments/trailing commas are fine). Example settings cover default engine/model, notifications, browser defaults, and prompt suffixes. See `docs/configuration.md` for a complete example and precedence.

## Flags you’ll actually use

| Flag | Purpose |
| --- | --- |
| `-p, --prompt <text>` | Required prompt. |
| `-f, --file <paths...>` | Attach files/dirs (supports globs and `!` excludes). |
| `-e, --engine <api\|browser>` | Choose API or browser automation. Omitted: API when `OPENAI_API_KEY` is set, otherwise browser. |
| `-m, --model <name>` | `gpt-5-pro` (default) or `gpt-5.1`. |
| `--base-url <url>` | Point the API engine at any OpenAI-compatible endpoint (LiteLLM, Azure, etc.). |
| `--files-report` | Print per-file token usage. |
| `--preview [summary\|json\|full]` | Inspect the request without sending. |
| `--render-markdown` | Print the assembled `[SYSTEM]/[USER]/[FILE]` bundle. |
| `--wait` / `--no-wait` | Block until completion. Default: `wait` for gpt-5.1/browser; `no-wait` for gpt-5-pro API (reattach later). |
| `-v, --verbose` | Extra logging (also surfaces advanced flags with `--help`). |

More knobs (`--max-input`, cookie sync controls for browser mode, etc.) live behind `oracle --help --verbose`.

## Sessions & background runs

Every non-preview run writes to `~/.oracle/sessions/<slug>` with usage, cost hints, and logs. Use `oracle status` to list sessions, `oracle session <id>` to replay, and `oracle status --clear --hours 168` to prune. Set `ORACLE_HOME_DIR` to relocate storage.
Add `--render` (alias `--render-markdown`) when attaching to pretty-print the stored markdown if your terminal supports color; falls back to raw text otherwise.

**Recommendation:** Prefer the API engine when you have an API key (`--engine api` or just set `OPENAI_API_KEY`). The API delivers more reliable results and supports longer, uninterrupted runs than the browser engine in most cases.

**Wait vs no-wait:** gpt-5-pro API runs default to detaching (shows a reattach hint); add `--wait` to stay attached. gpt-5.1 and browser runs block by default. You can reattach anytime via `oracle session <id>`.

## Testing

```bash
pnpm test
pnpm test:coverage
```

---

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com

Name inspired by: https://ampcode.com/news/oracle
