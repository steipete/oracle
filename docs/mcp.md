# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Tools

### `consult`
- Inputs: `prompt` (required), `files?: string[]` (globs), `model?: string` (defaults to CLI), `engine?: "api" | "browser"` (CLI auto-defaults), `slug?: string`.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`.
- Behavior: starts a session, runs it with the chosen engine, returns final output + metadata. Background/foreground follows the CLI (e.g., GPT‑5 Pro detaches by default).
- Logging: emits MCP logs (`info` per line, `debug` for streamed chunks with byte sizes). If browser prerequisites are missing, returns an error payload instead of running.

### `sessions`
- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status` / `oracle session`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row; set `detail: true` to fetch full metadata, log, and stored request body.

## Resources
- `oracle-session://{id}/{metadata|log|request}` — read-only resources that surface stored session artifacts via MCP resource reads.

## Background / detach behavior
- Same as the CLI: heavy models (e.g., GPT‑5 Pro) detach by default; reattach via `oracle session <id>` / `oracle status`. MCP does not expose extra background flags.

## Launching & usage
- Installed from npm:
  - One-off: `npx @steipete/oracle oracle-mcp`
  - Global: `oracle-mcp`
- From the repo (contributors):
  - `pnpm build`
  - `pnpm mcp` (or `oracle-mcp` in the repo root)
- mcporter example (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["@steipete/oracle", "oracle-mcp"]
  }
  ```
- Project-scoped Claude (.mcp.json) example:
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- Bridge helper snippets:
  - Codex CLI: `oracle bridge codex-config`
  - Claude Code: `oracle bridge claude-config`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from your Oracle CLI config; see `docs/configuration.md` or `~/.oracle/config.json`.
