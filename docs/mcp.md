# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Tools

### `consult`

- Inputs: `prompt` (required), `files?: string[]` (globs), `model?: string` (defaults to CLI), `engine?: "api" | "browser"` (CLI auto-defaults), `slug?: string`.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`.
- Safety preview: set `dryRun: true` to return the resolved model, token/file summary, and browser delivery plan without starting a model session.
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
      "oracle": {
        "type": "stdio",
        "command": "npx",
        "args": ["@steipete/oracle", "oracle-mcp"],
        "env": {
          "ORACLE_ENGINE": "browser",
          "ORACLE_BROWSER_PROFILE_DIR": "~/.oracle/browser-profile"
        }
      }
    }
  }
  ```
- Bridge helper snippets:
  - Codex CLI: `oracle bridge codex-config`
  - Claude Code: `oracle bridge claude-config`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from your Oracle CLI config; see `docs/configuration.md` or `~/.oracle/config.json`.

## Let Them Review: Claude Code Cross-Model Reviews

Claude Code can use `oracle-mcp` as a local stdio MCP server to ask ChatGPT browser models for a second opinion. With the browser engine and a signed-in ChatGPT profile, this lets Claude Code request GPT-5.5 Pro reviews through the user's ChatGPT subscription-backed browser session.

Use `dryRun: true` first when another agent is preparing the request. The preview shows the resolved model, token estimate, and file delivery plan without sending anything to ChatGPT:

```json
{
  "prompt": "Review this patch plan for release-blocking issues only.",
  "files": ["src/**", "!**/*.test.*"],
  "engine": "browser",
  "model": "gpt-5.5-pro",
  "dryRun": true
}
```

After the preview looks right, remove `dryRun` to start the real browser-backed consult. Treat the result as advisory and verify accepted points with code and tests.
