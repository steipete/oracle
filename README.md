# oracle — Whispering your tokens to the silicon sage

<p align="center">
  <img src="./README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steipete/oracle"><img src="https://img.shields.io/npm/v/@steipete/oracle?style=for-the-badge&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/steipete/oracle/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/steipete/oracle/ci.yml?branch=main&style=for-the-badge&label=tests" alt="CI Status"></a>
  <a href="https://github.com/steipete/oracle"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License"></a>
</p>

Oracle gives your agents a simple, reliable way to bundle a prompt plus the right files and hand them to another AI. It currently speaks GPT-5.1 and GPT-5 Pro; Pro runs can take up to ten minutes and often return remarkably strong answers.

## Two engines, one CLI

- **API engine** — Calls the OpenAI Responses API. Needs `OPENAI_API_KEY`.
- **Browser engine** — Automates ChatGPT in Chrome so you can use your Pro account directly. Toggle with `--engine browser`; no API key required.

If you omit `--engine`, Oracle prefers the API engine when `OPENAI_API_KEY` is present; otherwise it falls back to browser mode. Switch explicitly with `-e, --engine {api|browser}` when you want to override the auto choice. Everything else (prompt assembly, file handling, session logging) stays the same.

## Quick start

```bash
# One-off (no install)
OPENAI_API_KEY=sk-... npx @steipete/oracle --prompt "Summarize the risk register" --file docs/risk-register.md docs/risk-matrix.md

# Browser engine (no API key)
npx @steipete/oracle --engine browser --prompt "Summarize the risk register" --file docs/risk-register.md docs/risk-matrix.md

# Globs/exclusions
npx @steipete/oracle -- --prompt "Review the TS data layer" --file "src/**/*.ts" --file "!src/**/*.test.ts"
```

## How do I integrate this?

- **One-liner in CI** — `OPENAI_API_KEY=sk-... npx @steipete/oracle --prompt "Smoke-check latest PR" --file src/ docs/ --preview summary` (add to your pipeline as a non-blocking report step).
- **Package script** — In `package.json`: `"oracle": "oracle --prompt \"Review the diff\" --file ."` then run `OPENAI_API_KEY=... pnpm oracle`.
- **Git hook** — Use a pre-push or pre-commit hook to run `npx @steipete/oracle --prompt "Highlight risky changes" --file "$(git diff --name-only HEAD)"`.
- **Browser mode for Pro** — When teammates don’t have API keys, `npx @steipete/oracle --engine browser --prompt "Summarize this repo" --file .` uses the shared ChatGPT Pro login in Chrome.

## Highlights

- **Bundle once, reuse anywhere** — Prompt + files become a markdown package the model can cite.
- **Pro-friendly** — GPT-5 Pro background runs stay alive for ~10 minutes with reconnection + token/cost tracking.
- **Two paths, one UX** — API or browser, same flags and session logs.
- **Search on by default** — The model can ground answers with fresh citations.
- **File safety** — Per-file token accounting and size guards; `--files-report` shows exactly what you’re sending.
- **Readable previews** — `--preview` / `--render-markdown` let you inspect the bundle before spending.

## Flags you’ll actually use

| Flag | Purpose |
| --- | --- |
| `-p, --prompt <text>` | Required prompt. |
| `-f, --file <paths...>` | Attach files/dirs (supports globs and `!` excludes). |
| `-e, --engine <api|browser>` | Choose API or browser automation. Omitted: API when `OPENAI_API_KEY` is set, otherwise browser. |
| `-m, --model <name>` | `gpt-5-pro` (default) or `gpt-5.1`. |
| `--files-report` | Print per-file token usage. |
| `--preview [summary|json|full]` | Inspect the request without sending. |
| `--render-markdown` | Print the assembled `[SYSTEM]/[USER]/[FILE]` bundle. |
| `-v, --verbose` | Extra logging (also surfaces advanced flags with `--help`). |

More knobs (`--max-input`, cookie sync controls for browser mode, etc.) live behind `oracle --help --verbose`.

## Sessions & background runs

Every non-preview run writes to `~/.oracle/sessions/<slug>` with usage, cost hints, and logs. Use `oracle status` to list sessions, `oracle session <id>` to replay, and `oracle status --clear --hours 168` to prune. Set `ORACLE_HOME_DIR` to relocate storage.

## Testing

```bash
pnpm test
pnpm test:coverage
```

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com

---

Name credit: https://ampcode.com/news/oracle
