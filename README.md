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

Oracle gives your agents a simple, reliable way to **bundle a prompt plus the right files and hand them to another AI**. It currently speaks GPT-5.1 Pro (new default), GPT-5.1 Codex (API-only), and GPT-5.1; Pro and Codex Max runs can take up to an hour and often return remarkably strong answers.

## Two engines, one CLI

- **API engine** — Calls the OpenAI Responses API. Needs `OPENAI_API_KEY`.
- **Browser engine** — Automates ChatGPT in Chrome so you can use your Pro account directly. Toggle with `--engine browser`; no API key required.
  - Duration flags such as `--browser-timeout` / `--browser-input-timeout` accept `ms`, `s`, `m`, or `h` (and you can chain them: `1h2m10s`). Defaults are 20 m / 30 s.
  - Point browser runs at either the root ChatGPT homepage (`https://chatgpt.com/`) or a specific workspace/folder with `--chatgpt-url https://chatgpt.com/g/.../project` (config: `browser.chatgptUrl`).
  - Remote service: run `oracle serve` on a Mac that’s already signed into ChatGPT; it will exit and open chatgpt.com if the host profile isn’t logged in. Remote clients (`--remote-host/--remote-token`, or `remote.host` / `remote.token` in config) reuse the host session; cookies never transfer from the client.
  - **GPT-5.1 Codex** — `gpt-5.1-codex` (high reasoning) is available today via API. Codex Max isn’t exposed via API yet; once OpenAI flips the switch we’ll wire it up here. Codex models require `--engine api`.

If you omit `--engine`, Oracle prefers the API engine when `OPENAI_API_KEY` is present; otherwise it falls back to browser mode. Switch explicitly with `-e, --engine {api|browser}` when you want to override the auto choice. Everything else (prompt assembly, file handling, session logging) stays the same.

Note: Browser engine is considered experimental, requires an OpenAI Pro account and only works on macOS with Chrome.
Windows/Linux browser support is in progress; until then, use `--engine api` or bundle files and paste manually.
Your system password is needed to copy cookies. To skip Chrome/Keychain entirely, pass inline cookies via
`--browser-inline-cookies <json|base64>` or `--browser-inline-cookies-file <path>` (fallback files at
`~/.oracle/cookies.json` or `~/.oracle/cookies.base64`). API engine is stable and should be preferred.

### Chromium-based browsers

Want to launch Chromium or Microsoft Edge instead of Chrome? Override the executable with `--browser-chrome-path` (or `browser.chromePath` in config) and point cookie sync at the fork’s `Cookies` database via `--browser-cookie-path`. The full walkthrough—including sample paths for macOS/Linux/Windows—is in [docs/chromium-forks.md](docs/chromium-forks.md).

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

# Dry-run (no API call) with summary estimate
oracle --dry-run summary -p "Check release notes" --file docs/release-notes.md

# Alternate base URL (LiteLLM, Azure, self-hosted gateways)
OPENAI_API_KEY=sk-... oracle --base-url https://litellm.example.com/v1 -p "Summarize the risk register"

# Inspect past sessions
oracle status --clear --hours 168   # prune a week of cached runs
oracle status                       # list runs; grab an ID
oracle session <id>                 # replay a run locally
# Sessions (list + reattach)
npx -y @steipete/oracle status
npx -y @steipete/oracle session <id>

# TUI (interactive, for humans only)
npx -y @steipete/oracle
```

## Remote browser service (`oracle serve`)

Keep Chrome running on a signed-in host and drive it from another machine without shipping cookies:

1. On the host Mac, run `oracle serve` (or `oracle serve --port 9473 --token abc...`). It launches Chrome, prints `Listening at <host>:<port>` plus an access token, and exits if ChatGPT isn’t logged in so you can sign in and restart.
2. On the client, run `oracle --engine browser --remote-host <host:port> --remote-token <token> -p "..." --file <paths>`.
3. To skip flags, set defaults in `~/.oracle/config.json`:
   ```json5
   {
     remote: { host: "192.168.64.2:9473", token: "c4e5f9..." }
   }
   ```
   Env vars (`ORACLE_REMOTE_HOST`, `ORACLE_REMOTE_TOKEN`) still override the config.

Notes:
- Cookies never cross the wire; the host Chrome profile must stay signed in. If not, `oracle serve` opens chatgpt.com and exits.
- Remote mode requires `--engine browser` (or an auto-selected browser engine). Background/detached runs are disabled so logs can stream.

## How do I integrate this?
**Recommendation:** Prefer API (default) or manual bundle/copy flows. Full browser automation is experimental (macOS + Chrome only today) and may be blocked by login/Cloudflare challenges. (for humans) - preview first.
Keys are loaded automatically from provider env vars (OpenAI, Gemini, Claude, Azure/LiteLLM); pass them inline only if you must.

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
- **Pro-friendly** — GPT-5.1 Pro background runs stay alive for ~10 minutes with reconnection + token/cost tracking.
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
| `-m, --model <name>` | `gpt-5.1-pro` (default), `gpt-5.1`, `gpt-5.1-codex` (API-only), `claude-4.5-sonnet` (API id `claude-sonnet-4-5`), `claude-4.1-opus` (API id `claude-opus-4-1`) (API-only). |
| `--base-url <url>` | Point the API engine at any OpenAI-compatible endpoint (LiteLLM, Azure, etc.). |
| `--chatgpt-url <url>` | Point the browser engine at the ChatGPT root or a workspace/folder URL. |
| `--azure-endpoint <url>` | Use Azure OpenAI (switches client automatically). |
| `--files-report` | Print per-file token usage. |
| `--write-output <path>` | Write only the completed answer to `<path>`; multi-model runs append `.<model>` before the extension. |
| `--dry-run [summary\|json\|full]` | Inspect the request without sending (alias: `--preview`). |

See [docs/openai-endpoints.md](docs/openai-endpoints.md) for advanced Azure/LiteLLM configuration.

## Sessions & background runs

Every non-preview run writes to `~/.oracle/sessions/<slug>` with usage, cost hints, and logs. Use `oracle status` to list sessions, `oracle session <id>` to replay, and `oracle status --clear --hours 168` to prune. Set `ORACLE_HOME_DIR` to relocate storage.
Add `--render` (alias `--render-markdown`) when attaching to pretty-print the stored markdown if your terminal supports color; falls back to raw text otherwise.
Need a ready-made answer file? Add `--write-output path/to/file.md` to save just the final assistant message (multi-model writes one file per model by inserting `.<model>` before the extension; overwrites targets).

**Recommendation:** Prefer the API engine when you have an API key (`--engine api` or just set `OPENAI_API_KEY`). The API delivers more reliable results and supports longer, uninterrupted runs than the browser engine in most cases.

**Wait vs no-wait:** gpt-5.1-pro API runs default to detaching (shows a reattach hint); add `--wait` to stay attached. gpt-5.1, gpt-5.1-codex, and browser runs block by default. You can reattach anytime via `oracle session <id>`.

**Duplicate prompt guard:** If a session with the exact same prompt is already running, new runs are blocked with a reminder to reattach. Use `--force` only when you truly want a second run of the same prompt (e.g., to compare settings).

## Testing

```bash
pnpm test
pnpm test:coverage
```

---

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com

Name inspired by: https://ampcode.com/news/oracle
