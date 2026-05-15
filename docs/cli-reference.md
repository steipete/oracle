---
title: CLI Reference
description: "Every flag you'll actually use, grouped by what it does. Run `oracle --help --verbose` for the full hidden list."
---

This is the curated cheatsheet. The authoritative source is always `oracle --help` (and `oracle --help --verbose` for advanced flags).

## Commands

| Command                        | What it does                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| `oracle [flags] -p "<prompt>"` | Run a consult.                                                     |
| `oracle status`                | List recent sessions (see [Sessions](sessions.md)).                |
| `oracle session <id>`          | Replay or block on a stored session.                               |
| `oracle restart <id>`          | Re-run with the same prompt + files.                               |
| `oracle serve`                 | Run the remote browser host (see [Browser Mode](browser-mode.md)). |
| `oracle bridge claude-config`  | Emit a `.mcp.json` for Claude Code (see [MCP](mcp.md)).            |
| `oracle tui`                   | Interactive TUI (humans only).                                     |
| `oracle-mcp`                   | Stdio MCP server entrypoint.                                       |

## Core consult flags

| Flag                              | Purpose                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `-p, --prompt <text>`             | Required prompt.                                                                                 |
| `-f, --file <paths...>`           | Files / dirs / globs. Repeatable. `!` prefix = exclude.                                          |
| `-e, --engine <api\|browser>`     | Force engine. Default: auto-pick.                                                                |
| `-m, --model <name>`              | Single model. See [Mythical Pro Agents](mythical-pro-agents.md).                                 |
| `--models <list>`                 | Comma-separated multi-model run (API only).                                                      |
| `--slug <name>`                   | Stable session slug.                                                                             |
| `--render`                        | Print the assembled bundle to stdout.                                                            |
| `--copy`                          | Copy the bundle to the clipboard.                                                                |
| `--json`                          | Emit a stable JSON envelope on stdout.                                                           |
| `--write-output <path>`           | Save the final answer to a file; multi-model runs add per-model files plus `<stem>.oracle.json`. |
| `--files-report`                  | Print per-file token usage.                                                                      |
| `--dry-run [summary\|json\|full]` | Preview without sending.                                                                         |

## Followup / lineage

| Flag                            | Purpose                                       |
| ------------------------------- | --------------------------------------------- |
| `--followup <id\|slug\|resp_…>` | Continue an OpenAI/Azure Responses API run.   |
| `--followup-model <model>`      | Pick lineage when the parent used `--models`. |

## Run control

| Flag                                  | Purpose                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `--wait`                              | Block on background API runs.                                                          |
| `--timeout <seconds\|duration\|auto>` | Overall API deadline. `auto` = 60m for Pro, 120s otherwise; accepts values like `10m`. |
| `--background`, `--no-background`     | Force Responses API background mode on/off.                                            |
| `--http-timeout <ms\|s\|m\|h>`        | Override the HTTP client timeout; explicit `--timeout` values are reused when omitted. |
| `--allow-partial`, `--partial <mode>` | Accept partial multi-model success when mode is `ok`; default mode is `fail`.          |
| `--heartbeat <seconds>`               | Emit progress heartbeats; browser mode reports thinking-sidecar liveness.              |

## API endpoints

| Flag                  | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `--base-url <url>`    | LiteLLM / Azure / OpenRouter / proxy.    |
| `--provider <mode>`   | API route: `auto`, `openai`, or `azure`. |
| `--no-azure`          | Ignore Azure env/config for this run.    |
| `--azure-endpoint`    | Azure OpenAI endpoint.                   |
| `--azure-deployment`  | Azure deployment name.                   |
| `--azure-api-version` | Azure API version.                       |

See [OpenAI / Azure / OpenRouter](openai-endpoints.md) and [OpenRouter](openrouter.md).

## Browser mode

| Flag                                                            | Purpose                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `--chatgpt-url <url>`                                           | Target a ChatGPT workspace / project folder.                 |
| `--browser-model-strategy <select\|current\|ignore>`            | Control ChatGPT model picker.                                |
| `--browser-manual-login`                                        | Use persistent profile + manual login (no Keychain).         |
| `--browser-attach-running`                                      | Attach to your already-running Chrome via DevTools.          |
| `--browser-tab <ref>`                                           | Reuse an existing tab (`current`, id, URL, title substring). |
| `--browser-thinking-time <light\|standard\|extended\|heavy>`    | Pro / Thinking model intensity.                              |
| `--browser-research deep`                                       | Activate Deep Research mode.                                 |
| `--browser-follow-up <prompt>`                                  | Multi-turn in the same ChatGPT conversation.                 |
| `--browser-port <port>`                                         | Pin Chrome DevTools port.                                    |
| `--browser-inline-cookies[(-file)] <…>`                         | Supply cookies inline (no Keychain / Chrome).                |
| `--browser-timeout`, `--browser-input-timeout`                  | Overall / input timeouts (h/m/s/ms).                         |
| `--browser-recheck-delay`, `--browser-recheck-timeout`          | Delayed retry after a timeout.                               |
| `--browser-auto-reattach-delay/-interval/-timeout`              | Poll the existing tab when ChatGPT redirects mid-load.       |
| `--browser-reuse-wait`                                          | Wait for shared Chrome profile before launching.             |
| `--browser-profile-lock-timeout`                                | Wait for the manual-login profile lock.                      |
| `--browser-max-concurrent-tabs`                                 | Soft limit for shared-profile parallel runs (default 3).     |
| `--browser-keep-browser`                                        | Keep the browser open after the run.                         |
| `--browser-headless`, `--browser-hide-window`                   | Visibility controls.                                         |
| `--browser-attachments <auto\|never\|always>`                   | Attach files inline vs upload.                               |
| `--browser-bundle-files`, `--browser-bundle-format <text\|zip>` | Bundle browser uploads as text or ZIP.                       |
| `--browser-chrome-path`, `--browser-cookie-path`                | Override Chrome / cookie store discovery (Linux / Windows).  |

See [Browser Mode](browser-mode.md) for usage.

## Remote browser

| Flag                          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `--remote-host <host:port>`   | Use a remote `oracle serve` host.            |
| `--remote-token <secret>`     | Auth for the remote host.                    |
| `--remote-chrome <host:port>` | Attach to an existing remote Chrome session. |

## Image / media (browser)

| Flag                      | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `--generate-image <file>` | Save generated image (Gemini browser; ChatGPT also saves artifacts). |
| `--edit-image <file>`     | Edit an image (Gemini browser).                                      |
| `--aspect <ratio>`        | Aspect ratio for image gen.                                          |
| `--youtube <url>`         | Analyze a YouTube video (Gemini browser).                            |

## Stale session detection

| Flag                     | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `--zombie-timeout <…>`   | Cutoff for "stale" sessions.                 |
| `--zombie-last-activity` | Use last log entry instead of session start. |

## Environment variables

| Var                           | Effect                                                  |
| ----------------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`              | Enables OpenAI API mode.                                |
| `AZURE_OPENAI_API_KEY` etc.   | Enables Azure mode (paired with endpoint / deployment). |
| `GEMINI_API_KEY`              | Enables Gemini API mode.                                |
| `ANTHROPIC_API_KEY`           | Enables Claude API mode.                                |
| `OPENROUTER_API_KEY`          | Enables OpenRouter ids.                                 |
| `ORACLE_HOME_DIR`             | Override `~/.oracle/` root.                             |
| `ORACLE_MAX_FILE_SIZE_BYTES`  | Per-file size cap (default 1 MB).                       |
| `ORACLE_BROWSER_COOKIES_JSON` | Inline ChatGPT cookies (JSON / base64).                 |
| `ORACLE_BROWSER_COOKIES_FILE` | Path to cookies JSON.                                   |

## See also

- `oracle --help` — short usage.
- `oracle --help --verbose` — every flag, including hidden ones.
- [Configuration](configuration.md) — `~/.oracle/config.json` defaults.
