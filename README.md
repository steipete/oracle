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

Oracle bundles your prompt and files so another AI can answer with real context. It speaks GPT-5.1 Pro (default), GPT-5.1 Codex (API-only), GPT-5.1, Gemini 3 Pro, Claude Sonnet 4.5, Claude Opus 4.1, and more—and it can ask one or multiple models in a single run. Browser automation exists but is **experimental**; prefer API or `--copy` and paste into ChatGPT yourself.

## Quick start

Install globally: `npm install -g @steipete/oracle`

```bash
# Copy the bundle and paste into ChatGPT
npx -y @steipete/oracle --render --copy -p "Review the TS data layer for schema drift" --file "src/**/*.ts,*/*.test.ts"

# Minimal API run (expects OPENAI_API_KEY in your env)
npx -y @steipete/oracle -p "Write a concise architecture note for the storage adapters" --file src/storage/README.md

# Multi-model API run
npx -y @steipete/oracle -p "Cross-check the data layer assumptions" --models gpt-5.1-pro,gemini-3-pro --file "src/**/*.ts"

# Experimental browser run (no API key, will open ChatGPT)
npx -y @steipete/oracle --engine browser -p "Walk through the UI smoke test" --file "src/**/*.ts"

# Sessions (list and replay)
npx -y @steipete/oracle status --hours 72
npx -y @steipete/oracle session <id> --render

# TUI (interactive, only for humans)
npx -y @steipete/oracle
```

## Integration

**CLI**
- API mode expects API keys in your environment: `OPENAI_API_KEY` (GPT-5.x), `GEMINI_API_KEY` (Gemini 3 Pro), `ANTHROPIC_API_KEY` (Claude Sonnet 4.5 / Opus 4.1).
- Prefer API mode or `--copy` + manual paste; browser automation is experimental.
- Remote browser service: `oracle serve` on a signed-in host; clients use `--remote-host/--remote-token`.
- AGENTS.md/CLAUDE.md:
  ```
  - Oracle bundles a prompt plus the right files so another AI (GPT 5 Pro + more) can answer. Use when stuck/bugs/reviewing.
  - Run `npx -y @steipete/oracle --help` once per session before first use.
  ```

**MCP**
- `pnpm mcp` (or `oracle-mcp`) after building to run the stdio server.
- Configure clients via `config/mcporter.json` or `.mcp.json`; see [docs/mcp.md](docs/mcp.md) for connection examples and scope options.
```bash
npx -y @steipete/oracle oracle-mcp
```

## Highlights

- Bundle once, reuse anywhere (API or experimental browser).
- Multi-model API runs with aggregated cost/usage.
- Render/copy bundles for manual paste into ChatGPT when automation is blocked.
- File safety: globs/excludes, size guards, `--files-report`.
- Sessions you can replay (`oracle status`, `oracle session <id> --render`).

## Flags you’ll actually use

| Flag | Purpose |
| --- | --- |
| `-p, --prompt <text>` | Required prompt. |
| `-f, --file <paths...>` | Attach files/dirs (globs + `!` excludes). |
| `-e, --engine <api\|browser>` | Choose API or browser (browser is experimental). |
| `-m, --model <name>` | `gpt-5.1-pro` (default), `gpt-5-pro`, `gpt-5.1`, `gpt-5.1-codex` (API-only), `gemini-3-pro`, `claude-4.5-sonnet`, `claude-4.1-opus`, plus documented aliases. |
| `--models <list>` | Comma-separated API models for multi-model runs. |
| `--base-url <url>` | Point API runs at LiteLLM/Azure/etc. |
| `--chatgpt-url <url>` | Target a ChatGPT workspace/folder (browser). |
| `--render`, `--copy` | Print and/or copy the assembled markdown bundle. |
| `--write-output <path>` | Save only the final answer (multi-model adds `.<model>`). |
| `--files-report` | Print per-file token usage. |
| `--dry-run [summary\|json\|full]` | Preview without sending. |
| `--remote-host`, `--remote-token` | Use a remote `oracle serve` host (browser). |
| `--remote-chrome <host:port>` | Attach to an existing remote Chrome session (browser). |

## Configuration

Put defaults in `~/.oracle/config.json` (JSON5). Example:
```json5
{
  model: "gpt-5.1-pro",
  engine: "api",
  filesReport: true
}
```
See `docs/configuration.md` for precedence and full schema.

## More docs
- Browser mode & forks: [docs/browser-mode.md](docs/browser-mode.md) (includes `oracle serve` remote service), [docs/chromium-forks.md](docs/chromium-forks.md), [docs/linux.md](docs/linux.md)
- MCP: [docs/mcp.md](docs/mcp.md)
- OpenAI/Azure endpoints: [docs/openai-endpoints.md](docs/openai-endpoints.md)
- Manual smokes: [docs/manual-tests.md](docs/manual-tests.md)
- Releasing: [docs/RELEASING.md](docs/RELEASING.md)

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com  
Name inspired by: https://ampcode.com/news/oracle
