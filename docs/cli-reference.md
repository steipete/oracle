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
| `oracle docs check`            | Check documented flags against CLI help metadata.                  |
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
| `--write-output <path>`           | Save the final answer to a file; multi-model runs add per-model files plus `<stem>.oracle.json`. |
| `--files-report`                  | Print per-file token usage.                                                                      |
| `--dry-run [summary\|json\|full]` | Preview without sending.                                                                         |

## Followup / lineage

| Flag                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `--followup <id\|slug\|resp_…>` | Continue a saved ChatGPT browser or OpenAI/Azure Responses API session. |
| `--followup-model <model>`      | Pick API lineage when the parent used `--models`.                       |

## Run control

| Flag                                       | Purpose                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `--wait`                                   | Keep the original CLI attached until the session completes.                            |
| `--timeout <seconds\|duration\|auto>`      | Overall API deadline. `auto` = 60m for Pro, 120s otherwise; accepts values like `10m`. |
| `--background`, `--no-background`          | Force Responses API background mode on/off.                                            |
| `--http-timeout <ms\|s\|m\|h>`             | Override the HTTP client timeout; explicit `--timeout` values are reused when omitted. |
| `--allow-partial`, `--partial <mode>`      | Accept partial multi-model success when mode is `ok`; default mode is `fail`.          |
| `--preflight`                              | Check redacted provider readiness for requested API model(s), then exit.               |
| `--perf-trace`, `--perf-trace-path <path>` | Write CLI startup / first-output timing trace JSON.                                    |
| `--heartbeat <seconds>`                    | Emit progress heartbeats; browser mode reports thinking-sidecar liveness.              |

Notes:

- `--dry-run` is mutually exclusive with `--render` / `--render-markdown`; choose the preview or rendered bundle path.
- Missing root prompts exit nonzero after help so scripts fail closed.
- Ctrl-C exits foreground API runs with code 130 and stops an attached local Pro browser worker. Unexpected foreground termination leaves the detached browser worker running so the session can still finish.
- `--perf-trace=/tmp/oracle.json` is accepted in addition to `--perf-trace-path`; `ORACLE_PERF_TRACE=1` writes a local `.oracle-perf-…json` file.

## API endpoints

| Flag                  | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `--base-url <url>`    | LiteLLM / Azure / OpenRouter / proxy.     |
| `--provider <mode>`   | API route: `auto`, `openai`, or `azure`.  |
| `--no-azure`          | Ignore Azure env/config for this run.     |
| `--route`             | Print redacted API route plan, then exit. |
| `--azure-endpoint`    | Azure OpenAI endpoint.                    |
| `--azure-deployment`  | Azure deployment name.                    |
| `--azure-api-version` | Azure API version.                        |

See [OpenAI / Azure / OpenRouter](openai-endpoints.md) and [OpenRouter](openrouter.md).

## Browser mode

| Flag                                                                           | Purpose                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `--chatgpt-url <url>`                                                          | Target a ChatGPT workspace / project folder.                                                                                 |
| `--browser-model-strategy <select\|current\|ignore>`                           | Control ChatGPT model picker.                                                                                                |
| `--browser-manual-login`                                                       | Use persistent profile + manual login (no Keychain).                                                                         |
| `--browser-cookie-sync`                                                        | Explicitly copy cookies from live Chrome; prefer manual login because token rotation can invalidate the live session.        |
| `--browser-attach-running`                                                     | Attach to your already-running Chrome via DevTools.                                                                          |
| `--browser-tab <ref>`                                                          | Reuse an existing tab (`current`, id, URL, title substring).                                                                 |
| `--browser-thinking-time <light\|standard\|extended\|extra-high\|pro\|heavy>`  | Effort intensity; `pro` selects the Pro tier and fails closed if unconfirmed, other unmatched tiers keep the current effort. |
| `--browser-research deep`                                                      | Activate Deep Research mode.                                                                                                 |
| `--browser-follow-up <prompt>`                                                 | Multi-turn in the same ChatGPT conversation.                                                                                 |
| `--browser-port <port>`                                                        | Pin Chrome DevTools port.                                                                                                    |
| `--browser-inline-cookies[(-file)] <…>`                                        | Supply cookies inline (no Keychain / Chrome).                                                                                |
| `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout` | Overall / input / attachment readiness timeouts (h/m/s/ms).                                                                  |
| `--browser-recheck-delay`, `--browser-recheck-timeout`                         | Delayed retry after a timeout.                                                                                               |
| `--browser-auto-reattach-delay/-interval/-timeout`                             | Poll the existing tab when ChatGPT redirects mid-load.                                                                       |
| `--browser-reuse-wait`                                                         | Wait for shared Chrome profile before launching.                                                                             |
| `--browser-profile-lock-timeout`                                               | Wait for the manual-login profile lock.                                                                                      |
| `--browser-max-concurrent-tabs`                                                | Soft limit for shared-profile parallel runs (default 3).                                                                     |
| `--browser-keep-browser`                                                       | Keep the browser open after the run.                                                                                         |
| `--browser-headless`, `--browser-hide-window`                                  | Visibility controls.                                                                                                         |
| `--browser-attachments <auto\|never\|always>`                                  | Attach files inline vs upload.                                                                                               |
| `--browser-bundle-files`, `--browser-bundle-format <auto\|text\|zip>`          | Bundle browser uploads as text or byte-preserving ZIP.                                                                       |
| `--browser-chrome-path`, `--browser-cookie-path`                               | Override Chrome / cookie store discovery (Linux / Windows).                                                                  |

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

## Conversation export

`oracle conversation export [ref]` is read-only: it never sends a prompt or navigates the tab, it only reads. `ref` may be a full ChatGPT URL (a project-prefixed URL like `.../g/g-p-.../c/<id>` works too) or a bare conversation id.

| Flag                | Purpose                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--source <source>` | `api` (default) or `dom` (legacy). See below. (Not the root `--engine` flag.)                                  |
| `--format <format>` | `json` (default), `markdown`, `raw`, or `obsidian` (`raw`/`obsidian` are `api` source only).                   |
| `--host <host>`     | Chrome DevTools host (default `127.0.0.1`).                                                                    |
| `--port <port>`     | Chrome DevTools port (default `9222`).                                                                         |
| `--out <path>`      | Write the export to a file (`json`/`markdown`/`raw`) or a vault root directory (`obsidian`) instead of stdout. |
| `--omit-text`       | Omit message text; ids, hashes, and structure remain (provenance, not anonymization).                          |
| `--timezone <iana>` | `obsidian` only: calendar timezone for filenames/frontmatter dates (default: this machine's local timezone).   |
| `--captured <date>` | `obsidian` only: `YYYY-MM-DD` capture date recorded in frontmatter (default: today in `--timezone`).           |
| `--folder <name>`   | `obsidian` only: vault subfolder name (default: `ChatGPT-<first 8 chars of conversation id>`).                 |
| `--force`           | `obsidian` only: write into the target folder even if it already exists and is not empty.                      |

Two sources:

- **`api` (default)**: reads ChatGPT's own `/backend-api/conversation/<id>` JSON directly from the attached tab (via two read-only `fetch()` calls the tab already has cookies/token for: `/api/auth/session` for a bearer token, then the conversation body). This sees the canonical message graph in one shot — branches, `create_time`, model slugs, canvas (`canmore`) documents, and thoughts-only assistant turns that render nothing in the DOM — so it never needs to scroll, never reports a false "incomplete", and `complete` is always `true`. Records are `version: 2`: one record per turn, with `messageIds`, `segments` (visible assistant content blocks), `hiddenNodes` (skipped thoughts/tool-call/reasoning-recap nodes, labelled `role:content_type[:recipient]`), `attachments` (non-text parts like images), `createTime`, and `model`. The `api` source only needs _some_ logged-in ChatGPT tab reachable on the CDP endpoint — not necessarily a tab already open on that exact conversation; if the given `ref` doesn't match a live tab, Oracle retries against any live ChatGPT tab before giving up.
- **`dom` (legacy, `--source dom`)**: the original virtualized-scroll DOM crawl. Kept for compatibility; `version: 1` records, gap-checked `complete`/`missingTurnIndices`, but structurally blind to thoughts-only turns, branches, and canvas documents.

`--format raw` (api source only) writes the untouched backend-api response body instead of Oracle's normalized record shape — useful for inspecting fields Oracle doesn't yet surface.

### `--format obsidian`: archive into an Obsidian vault / knowledge repo

`--format obsidian` (api source only, requires `--out <dir>`) writes a raw-first note per Q/A exchange plus an `INDEX.md`, under `<out>/<folder>/`. This is Oracle's primary intended use for `conversation export`: letting a coding agent (Codex, Claude Code, ...) archive a ChatGPT conversation into a Git-tracked Obsidian vault as durable, greppable, wikilinked source material.

- **Exchange** = one user turn plus every assistant turn that follows it up to the next user turn. A leading assistant-only run (no user before it) becomes its own "answer only" note; a trailing user turn with no assistant reply becomes a "query only" note.
- **File name**: `NNN-YYYY-MM-DD-turn-TTT.md` — `NNN` is the 1-based exchange number, the date is the query's `createTime` converted to `--timezone`'s calendar date (or `unknown`), `TTT` is the query's turn index (or the first answer's, for an answer-only note).
- **Raw-first**: query text and every visible assistant segment are stored byte-exact (only CRLF → LF is normalized, and recorded per-record in `normalization`); nothing is summarized at capture time. Each note's frontmatter carries `query_sha256`/`answer_sha256` so integrity is checkable later, plus `conversation_id`, `source_url`, `query_turn`/`query_turn_id`, `answer_turns`/`answer_turn_ids`, and `query_attachments` (images etc.). The body has a `## 元のクエリ` block (`<!-- QUERY_RAW_START/END -->` markers) and, per assistant turn, a `### Assistant turn N` field table plus one `#### Segment k` block per visible content block (text, or a `canmore` canvas document) with its own `message_id`/`content_type`/`model`/`sha256`/`created_at`. A thoughts-only assistant turn (nothing rendered in the ChatGPT UI) still gets a note, marked `<!-- ANSWER_EMPTY -->`, so it's distinguishable from a turn that failed to export.
- **`INDEX.md`**: frontmatter with the conversation's date range/title/timestamps, a plain-language summary line (turn/exchange counts, query-only/thoughts-only/empty counts, segment and CRLF-normalization counts, mapping node and branch-node counts), and one `NNN. [[folder/file|date — kind]]` wikilink per exchange.
- Refuses to write into an existing non-empty `<out>/<folder>` unless `--force` is passed.

See [Archive ChatGPT conversations into an Obsidian vault](../README.md#archive-chatgpt-conversations-into-an-obsidian-vault--knowledge-repo) in the README for the end-to-end workflow.

## Stale session detection

| Flag                     | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `--zombie-timeout <…>`   | Cutoff for "stale" sessions.                 |
| `--zombie-last-activity` | Use last log entry instead of session start. |

## Environment variables

| Var                                 | Effect                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`                    | Enables OpenAI API mode.                                |
| `AZURE_OPENAI_API_KEY` etc.         | Enables Azure mode (paired with endpoint / deployment). |
| `GEMINI_API_KEY`                    | Enables Gemini API mode.                                |
| `ANTHROPIC_API_KEY`                 | Enables Claude API mode.                                |
| `OPENROUTER_API_KEY`                | Enables OpenRouter ids.                                 |
| `ORACLE_HOME_DIR`                   | Override `~/.oracle/` root.                             |
| `ORACLE_MAX_FILE_SIZE_BYTES`        | Per-file size cap (default 1 MB).                       |
| `ORACLE_BROWSER_COOKIES_JSON`       | Inline ChatGPT cookies (JSON / base64).                 |
| `ORACLE_BROWSER_COOKIES_FILE`       | Path to cookies JSON.                                   |
| `ORACLE_BROWSER_ATTACHMENT_TIMEOUT` | Attachment upload/readiness timeout for browser mode.   |
| `ORACLE_CHATGPT_ACCOUNT_EMAIL`      | Exact saved account for the Welcome back picker.        |

## See also

- `oracle --help` — short usage.
- `oracle --help --verbose` — every flag, including hidden ones.
- [Configuration](configuration.md) — `~/.oracle/config.json` and project `.oracle/config.json` defaults.
