# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

## Let Them Fight

Claude Code can call `oracle-mcp` and ask a subscription-backed ChatGPT browser session for a second opinion. Use the `chatgpt-pro-heavy` preset when you want a compact MCP request that targets ChatGPT browser mode, the current Pro picker alias, and Pro Extended thinking time. The preset is intentionally boring at the API layer: it is a shortcut for existing browser-mode fields, not a new model id.

## Tools

### `chatgpt_image`

- Inputs: `prompt` (required), `files?: string[]` for reference images/assets, `outputPath?: string`, `aspectRatio?: string`, `model?: string`, plus browser controls such as `browserThinkingTime`, `browserModelLabel`, `browserModelStrategy`, `browserArchive`, `browserKeepBrowser`, and `dryRun`.
- Behavior: convenience wrapper for ChatGPT browser image generation. It forces `engine:"browser"`, sets `generateImage` for the existing image-aware wait/download path, and defaults `browserAttachments:"always"` when files are provided so reference images are uploaded instead of pasted.
- Output: returns the normal session metadata plus `requestedOutputPath` and `structuredContent.images[]` with saved local paths, MIME type, size, dimensions, and ChatGPT file id when available. Signed source/download URLs are not returned. If `outputPath` is omitted, Oracle picks a unique file under `ORACLE_HOME_DIR/generated/`.
- Output path safety: agent-supplied `outputPath` must resolve under `ORACLE_HOME_DIR/generated` by default; traversal and symlink escapes are rejected. This keeps MCP writes away from Oracle config, session metadata, and browser profile state. Set `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` to allow writing elsewhere as an explicit operator decision. Omit `outputPath` to use the safe default.
- Local browser only: image output is unsupported when a remote browser service is configured (`ORACLE_REMOTE_HOST`); the image would be written on the remote host and not transferred back, so `chatgpt_image`/`consult` image runs fail closed with a clear error rather than returning empty `structuredContent.images`. Run on the local browser to generate images.

```json
{
  "prompt": "Create a 9:16 App Store screenshot background for a focus timer.",
  "files": ["./reference-screen.png"],
  "aspectRatio": "9:16"
}
```

### `consult`

- Inputs: `prompt` (required), `files?: string[]` (globs), `model?: string` (defaults to CLI), `engine?: "api" | "browser"` (optional; Oracle follows CLI defaults: `ORACLE_ENGINE` and the effective config first, then API when `OPENAI_API_KEY` is set, otherwise browser), `slug?: string`.
- Presets: `preset?: "chatgpt-pro-heavy"` applies browser mode + current Pro model alias + extended thinking, unless the request overrides those fields.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserBundleFormat?: "auto"|"text"|"zip"`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserResearchMode?: "deep"`, `browserFollowUps?: string[]`, `browserArchive?: "auto"|"always"|"never"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`, `browserModelStrategy?: "select"|"current"|"ignore"`, `generateImage?: string`, `outputPath?: string`.
- Dry runs: set `dryRun: true` to preview the resolved request without creating a session or touching the browser.
- Behavior: starts a session, runs it with the chosen engine, returns final output + metadata. Background/foreground follows the CLI (e.g., GPT‑5 Pro detaches by default). If API mode fails because `OPENAI_API_KEY` is missing and you have ChatGPT Pro, retry with `engine: "browser"` or `preset: "chatgpt-pro-heavy"` to use your signed-in ChatGPT session instead of an API key.
- Logging: emits MCP logs (`info` per line, `debug` for streamed chunks with byte sizes). If browser prerequisites are missing, returns an error payload instead of running.
- Research mode: set `browserResearchMode:"deep"` for broad public-web research and cited reports. Use normal browser runs with `gpt-5.5-pro` + `browserThinkingTime:"extended"` for Pro Extended code review, or `gpt-5.5` + `browserThinkingTime:"heavy"` when you explicitly want Thinking Heavy.
- Multi-turn consults: set `browserFollowUps:["Challenge your recommendation", "Give the final decision"]` to keep one ChatGPT browser conversation open and ask sequential follow-up prompts. Use one-shot calls for narrow bugs and exact file-set reviews; use multi-turn for ambiguous architecture/product decisions where a challenge pass and final recommendation are useful; use Deep Research for broad public-web work with citations. Oracle never invents follow-ups automatically.
- Archiving: set `browserArchive:"auto"|"always"|"never"` to control ChatGPT conversation cleanup. `auto` archives only successful browser one-shots after local artifacts are saved, and skips project, Deep Research, multi-turn, failed, and incomplete sessions.
- ChatGPT image generation: set `engine:"browser"` and `generateImage` to a path under `ORACLE_HOME_DIR/generated` to use the same image-aware wait/download path as CLI `--generate-image`. Saved files are returned in `structuredContent.images` and recorded as session artifacts; multiple images save as numbered siblings. Agent-supplied `generateImage` / `outputPath` are constrained to that generated-output directory by default (set `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` to allow external paths).

#### Long browser consults from agents

Browser-backed GPT-5.5 Pro consults can legitimately run for many minutes. Some MCP clients show little progress while a tool call is active, so agents should treat a long Oracle call as a running browser job, not as a failed step. Start with `dryRun:true` when configuring a new agent, prefer `preset:"chatgpt-pro-heavy"` or `engine:"browser"` explicitly, and use the shared session store (`sessions`, `oracle status`, or `oracle session <id>`) before retrying a prompt. If the browser control plan says Oracle will launch visible Chrome, use attach/remote Chrome when the operator is actively using the computer.

#### ChatGPT images from agents

For generated images, pass an explicit `generateImage` path. That opt-in is important because it switches the browser wait loop to watch for ChatGPT image artifacts instead of only assistant text. The path must resolve under `ORACLE_HOME_DIR/generated` unless `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` is set.

```json
{
  "engine": "browser",
  "model": "gpt-5.5-pro",
  "prompt": "Create a 9:16 App Store screenshot background for a focus timer.",
  "generateImage": "${ORACLE_HOME_DIR}/generated/focus-timer-bg.png"
}
```

The MCP response includes `structuredContent.images[]` with the saved file path, MIME type, size, dimensions, and ChatGPT file id when available. Signed source/download URLs remain internal.

### `sessions`

- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status` / `oracle session`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row; set `detail: true` to fetch full metadata, log, and stored request body.

### `project_sources`

- Inputs: `operation: "list"|"add"`, `chatgptUrl?: string`, `files?: string[]`, `dryRun?: boolean`, `confirmMutation?: boolean`, `browserKeepBrowser?: boolean`.
- Behavior: manages the ChatGPT Project Sources tab through local browser automation. v1 is intentionally append-only: it can list existing sources and add files, but it cannot delete, replace, or sync.
- Safety: `add` requires `confirmMutation: true` unless `dryRun: true`. This keeps agent callers from mutating a persistent ChatGPT Project by accident.
- Workflow: use this when Claude Code, Codex, or another MCP host needs a durable shared context file in a ChatGPT Project. Use `consult` when you want an actual model answer.

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
  - Claude Code with local macOS Chrome: `oracle bridge claude-config --local-browser > .mcp.json`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from the effective Oracle CLI config; see `docs/configuration.md`, `~/.oracle/config.json`, and project `.oracle/config.json` files.
