# oracle

Oracle is a one-shot CLI for GPT-5 Pro / GPT-5.1 when you need deep reasoning plus lots of local context. Point it at your prompt and the relevant files (code, logs, docs); Oracle bundles everything into either the Responses API (needs `OPENAI_API_KEY`) or the ChatGPT web UI (no key required), keeps the run alive in the background, and records a searchable transcript.

## Quick start

```bash
pnpm install

# Responses API path (requires an OPENAI_API_KEY)
OPENAI_API_KEY=sk-... pnpm run oracle -- \
  --prompt "Summarize the risk register" \
  --file docs/risk-register.md docs/risk-matrix.md

# Browser path (no API key needed)
pnpm run oracle -- --engine browser --prompt "Summarize the risk register" \
  --file docs/risk-register.md docs/risk-matrix.md

# Globs/exclusions (skip tests, only TypeScript sources)
pnpm run oracle -- --prompt "Review the TS data layer" \
  --file "src/**/*.ts" --file "!src/**/*.test.ts"
```

Prefer the compiled binary? `pnpm run build && node dist/bin/oracle.js --prompt ...` works too. Whether you hit the API or the browser, attach the files/directories that explain the issue and run `--files-report` to stay within the ~196k-token window (legacy `--browser` still works but is deprecated in favor of `--engine browser`).

## Highlights

- **Streaming Responses API client** for GPT-5 Pro (default) or GPT-5.1 (auto high-reasoning effort).
- **Web search tool** on by default so the model can cite fresh information.
- **File attachments with Markdown wrapping** and per-file token accounting via `--files-report`.
- **Preview & render modes** (`--preview`, `--render-markdown`) help inspect the assembled bundle before spending API credits.
- **Detached sessions + disk logs** under `~/.oracle/sessions/<slug>` with cost + usage metadata.
- **Browser mode** (`--engine browser`) automates ChatGPT in Chrome—no API key required—while mirroring the same session/usage tracking you get from the Responses API path (legacy `--browser` still maps to `--engine browser` for now).
- **Advanced flags on demand** – run `oracle --help --verbose` (or `oracle --debug-help`) to reveal the less common search/token/browser toggles without cluttering the primary help output.

## Everyday flags

| Flag | Description |
| ---- | ----------- |
| `-p, --prompt <text>` | **Required** for new runs/preview. User instruction sent to GPT-5. |
| `-f, --file <paths...>` | Attach files or directories (repeat flag or use space/comma lists). Directories expand recursively. |
| `-m, --model <name>` | `gpt-5-pro` (default) or `gpt-5.1` (high reasoning mode). |
| `-s, --slug <words>` | Force a memorable 3–5 word session slug (`release-risk-review`). Duplicates get `-2`, `-3`, ... |
| `--files-report` | Show per-file token usage (auto-enabled when you exceed the token budget). |
| `--preview [mode]` | Inspect token counts (and optionally JSON/markdown) without hitting the API. |
| `--render-markdown` | Print the `[SYSTEM]`, `[USER]`, `[FILE: ...]` bundle to stdout (no API call). |
| `-e, --engine <mode>` | Choose `api` (default) or `browser`. Legacy `--browser` still toggles the browser engine but will be removed. |
| `-v, --verbose` | Emit verbose logs (and, when paired with `--help`, list the advanced option set). |

Need search toggles, token overrides, or Chrome tweaks? `oracle --help --verbose` lists the advanced/debug-only flags, and `oracle --debug-help` prints the same summary without the rest of the help text.

## Browser mode in a nutshell

`oracle --engine browser ...` launches a temporary Chrome profile, optionally copies cookies from your main browser, pastes the assembled `[SYSTEM]/[USER]/[FILE]` bundle into ChatGPT, waits for the answer, and logs the output just like an API run. Key points:

- Same session workflow (`oracle status`, `oracle session <id>`) with extra metadata (Chrome PID/port/profile dir).
- No streaming output (ChatGPT returns a full answer once the copy button fires).
- Hidden flags control headless mode, timeouts, cookie sync, etc. View them via `oracle --debug-help` or `docs/browser-mode.md`.

## Sessions & background execution

Every non-preview run spawns a detached worker and logs to `~/.oracle/sessions/<slug>`. You can:

- `oracle session <sessionId>` / `oracle status <sessionId>` – replay and follow a specific session.
- `oracle session` / `oracle status` – list recent runs (24 h window by default; tweak with `--hours/--limit/--all`).
- `oracle status --clear --hours 168` – prune logs older than a week (or `--all` for a full reset).

Set `ORACLE_HOME_DIR` if you want to store logs somewhere other than your home directory.

## How it works

1. Collects the prompt + files, converts them into markdown sections (`### File n: path`), and counts tokens using the GPT-5/GPT-5 Pro encoders.
2. Fails fast if the estimated input exceeds the per-model budget (default 196k) and prints per-file breakdowns when needed.
3. Sends a single Responses API request with the system prompt, user prompt, files, and optional search tool—or, in browser mode, drives the ChatGPT UI with Chrome DevTools.
4. Streams output (API runs) or prints the captured markdown (browser runs), then records elapsed time, usage numbers, and cost estimates.
5. GPT-5 Pro API runs automatically opt into Responses API background mode, so the CLI can reconnect and poll for up to 30 minutes if the transport drops mid-run.

## Testing

```bash
pnpm test        # Vitest unit/integration suite (no network)
pnpm test:coverage
```

Tests cover prompt assembly, preview/token enforcement, CLI session plumbing, and the browser helper modules.
