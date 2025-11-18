# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Tools

### `consult`
- Inputs: `prompt` (required), `files` (string[] globs), `model` (defaults to CLI), `engine` (`api`|`browser`, same auto-defaults as CLI), `slug?` (custom session slug).
- Behavior: starts a session, runs it using the chosen engine, and returns the final output plus metadata. No prompt preview, no advanced browser toggles. Background handling follows CLI defaults (e.g., GPT‑5 Pro requests run in background automatically); not exposed as a tool option.
- Logging: emits MCP logging notifications — line logs at `info`, chunk streams at `debug` (with byte sizes). If browser is unavailable (missing DISPLAY/CHROME_PATH or guardrails), the tool returns an error payload instead of running.

### `sessions`
- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row by default; set `detail: true` to fetch full metadata, log, and stored request body so you can reload or audit a specific session.

## Resources
- `oracle-session://{id}/{metadata|log|request}` — read-only resources that surface stored session artifacts via MCP resource reads.

## Background (how runs are scheduled)
- The CLI chooses foreground vs. background automatically based on the model/engine (e.g., GPT‑5 Pro uses background with reconnection and cost tracking). The MCP server inherits the same defaults but does **not** expose a background flag; callers get the CLI’s safe defaults without extra switches.

## Launching & usage
- Build once: `pnpm build`.
- Start the stdio server: `pnpm mcp` or `oracle-mcp` (from the repo root).
- mcporter example (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@steipete/oracle", "oracle-mcp"]
  }
  ```
- Project-scoped Claude (.mcp.json) example:
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["-y", "@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- Tools and resources operate on the same session store as `oracle status|session`.
