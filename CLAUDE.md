# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Oracle (`@steipete/oracle`) is a CLI tool that wraps OpenAI's Responses API to query multiple AI models (GPT-5.x, Gemini 3.x, Claude 4.x) with file context. It supports API mode, browser automation (ChatGPT/Gemini via Chrome DevTools Protocol), MCP server integration, and remote bridge execution.

## Commands

```bash
# Package manager: pnpm (10.23.0)
pnpm install              # Install dependencies

# Build
pnpm run build            # TypeScript compile + copy vendor files

# Lint & Format (oxlint + oxfmt, NOT ESLint/Prettier)
pnpm run check            # format:check + lint (runs in CI)
pnpm run lint             # typecheck + oxlint
pnpm run lint:fix         # oxlint --fix + oxfmt
pnpm run format           # oxfmt --write
pnpm run typecheck        # tsc --noEmit

# Tests (Vitest)
pnpm test                 # Run all unit tests
pnpm vitest run tests/oracle/run.test.ts          # Single test file
pnpm vitest run -t "test name pattern"            # Single test by name
pnpm test:coverage        # Unit tests with v8 coverage
pnpm test:mcp             # Build + MCP unit + mcporter integration
pnpm test:browser         # Browser automation smokes (needs Chrome on port 45871)
ORACLE_LIVE_TEST=1 pnpm test:live                 # Live API tests (costs real tokens)
ORACLE_LIVE_TEST=1 pnpm test:pro                  # Pro model tests (10+ min)
```

## Architecture

```
bin/
  oracle-cli.ts          # CLI entry point (commander-based, 1700+ lines)
  oracle-mcp.ts          # MCP server entry point

src/
  oracle/                # Core engine
    run.ts               # Main orchestrator — assembles prompt, calls API, streams response
    client.ts            # API client factory (OpenAI, Azure, Gemini, custom endpoints)
    modelResolver.ts     # Model name → provider routing logic
    files.ts             # File globbing + token estimation
    multiModelRunner.ts  # Parallel multi-model execution
    gemini.ts / claude.ts  # Provider-specific adapters

  browser/               # Chrome DevTools Protocol automation
    index.ts             # Core browser orchestrator (largest file)
    chromeLifecycle.ts   # Chrome launch/teardown via chrome-launcher
    cookies.ts           # Cookie sync (sweet-cookie for macOS Keychain)
    reattach.ts          # Session recovery on navigation/crash
    actions/             # DOM interaction modules
      assistantResponse.ts   # Capture AI response from page
      attachments.ts         # File/image upload automation
      promptComposer.ts      # Type prompt into chat input
      modelSelection.ts      # Pick model from ChatGPT dropdown
      navigation.ts          # URL/iframe handling
    providers/           # DOM selector definitions per site
      chatgptDomProvider.ts
      geminiDeepThinkDomProvider.ts

  cli/                   # CLI layer
    options.ts           # Commander option definitions
    sessionRunner.ts     # Executes a single oracle run
    sessionDisplay.ts    # Terminal output rendering
    browserConfig.ts     # Browser flag aggregation
    tui/                 # Interactive terminal UI (excluded from coverage)

  gemini-web/            # Browser-based Gemini client (no API key needed)
  remote/                # Remote Chrome bridge (server + client)
  bridge/                # MCP/Codex bridge connection
  mcp/                   # Model Context Protocol server + tools
  sessionManager.ts      # Session CRUD (stored in ~/.oracle/sessions/)
  config.ts              # Global config (~/.oracle/config.json, JSON5)
```

### Key Patterns

- **Engine selection**: API (default when `OPENAI_API_KEY` set) vs Browser (Chrome automation). Controlled by `--engine api|browser` or `ORACLE_ENGINE` env var.
- **Model routing**: `modelResolver.ts` maps model strings to providers. Supports OpenAI, Azure OpenAI, Gemini (API + web), Claude, OpenRouter, Grok, and custom endpoints.
- **Session persistence**: Every run creates a session under `~/.oracle/sessions/<id>/` with metadata, prompt, and response. Sessions can be listed (`oracle status`), replayed (`oracle session <id>`), or restarted (`oracle restart <id>`).
- **Path aliases**: `@src/*` → `src/*`, `@tests/*` → `tests/*` (configured in tsconfig.json and vitest.config.ts).

## Code Style

- **Formatter**: oxfmt — 2 spaces, 100 char width, double quotes, trailing commas, semicolons.
- **Linter**: oxlint with plugins: unicorn, typescript, oxc. Categories correctness/perf/suspicious = error.
- **TypeScript**: Strict mode, ES2022 target, ESNext modules, bundler resolution.
- **Module system**: ESM (`"type": "module"` in package.json). Use `.ts` extensions in imports.

## Testing Notes

- Test setup (`tests/setup-env.ts`) injects fake API keys and isolates session storage to `/tmp/oracle-tests-{pid}`. Non-live tests never hit real APIs.
- Live tests are opt-in via `ORACLE_LIVE_TEST=1` env var and require real API keys.
- Browser smoke tests expect Chrome on DevTools port 45871.
- MCP tests require building first (`pnpm run build`).

## AGENTS.md Highlights

- CLI banner uses the oracle emoji: `🧿 oracle (<version>) ...` — only on initial headline and TUI exit.
- Browser Pro runs: never click "Answer now" — wait for the real response (up to 10 min).
- Before release, check `docs/manual-tests.md` for relevant smoke tests.
- After finishing a feature, update CHANGELOG if it affects end users (read top ~100 lines first, group related edits).
