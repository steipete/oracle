# Changelog

All notable changes to this project will be documented in this file.

## 0.4.6 — unreleased

### Fixed
- CLI/TUI now print the intro banner only once; forced TUI launches (`ORACLE_FORCE_TUI` or no args in a TTY) no longer show duplicate 🧿 header lines.
- TUI session list cleans up separators, removing the `__disabled__ (Disabled)` placeholder and `(Disabled)` tag on the header row.

## 0.4.5 — 2025-11-22

### Fixed
- MCP/API responses now report 404/405 from `/v1/responses` as “unsupported-endpoint” with guidance to fix base URLs/gateways or use browser engine; avoids silent failures when proxies lack the Responses API.

## 0.4.4 — 2025-11-22

### Fixed
- MCP/API runs now surface 404/405 Responses API failures as “unsupported-endpoint” with actionable guidance (check OPENAI_BASE_URL/Azure setup or use the browser engine) instead of a generic transport error.
- Publish metadata now declares Node >=20 (engines/devEngines) and drops the implicit bun runtime so `npx @steipete/oracle` no longer fails with EBADDEVENGINES on newer Node versions.

## 0.4.3 — 2025-11-22

### Added
- xAI Grok 4.1 API support (`--model grok-4.1` / alias `grok`): defaults to `https://api.x.ai/v1`, uses `XAI_API_KEY`, maps search to `web_search`, and includes docs + live smoke.
- Per-model search tool selection so Grok can use `web_search` while OpenAI models keep `web_search_preview`.
- Multi-model coverage now includes Grok in orchestrator tests.
- Grok “thinking”/non-fast variant is not available via API yet; Oracle aliases `grok` to the fast reasoning model to match what xAI ships today.
- PTY-driven CLI/TUI harness landed for e2e coverage (browser guard, TUI exit path); PTY suites are opt-in via `ORACLE_ENABLE_PTY_TESTS=1` and stub tokenizers to stay lightweight.

### Fixed
- MCP (global installs): keep the stdio transport alive until the client closes it so `oracle-mcp` doesn’t exit right after `connect()`; npm -g / host-spawned MCP clients now handshake successfully (tarball regression in 0.4.2).

## 0.4.2 — 2025-11-21

### Fixed
- MCP: `npx @steipete/oracle oracle-mcp` now routes directly to the MCP server (even when npx defaults to the CLI binary) and keeps stdout JSON-only for Cursor/other MCP hosts.
- Added the missing `@anthropic-ai/tokenizer` runtime dependency so `npx @steipete/oracle oracle-mcp` starts cleanly.

## 0.4.1 — 2025-11-21

### Fixed
- Removed duplicate MCP release note entry; no code changes (meta cleanup only).

## 0.4.0 — 2025-11-21

### Added
- Remote Chrome + remote browser service: `oracle serve` launches Chrome with host/token defaults for cross-machine runs, requires the host profile to be signed in, and supports reusing an existing Chrome via `--remote-chrome <host:port>` (IPv6 with `[host]:port`), including remote attachment uploads and clearer validation errors.
- Linux browser support: Chrome/Chromium/Edge runs now work on Linux (including snap-installed Chromium) with cookie sync picking up the snap profile paths. See [docs/linux.md](docs/linux.md) for paths and display guidance.
- Browser engine can target Chromium/Edge by pairing `--browser-chrome-path` with the new `--browser-cookie-path` (also configurable via `browser.chromePath` / `browser.chromeCookiePath`). See [docs/chromium-forks.md](docs/chromium-forks.md) for OS-specific paths and setup steps.
- Markdown bundles render better in the CLI and ChatGPT: each attached file now appears as `### File: <path>` followed by a fenced code block (language inferred), across API bundles, browser bundles (including inline mode), and render/dry-run output; ANSI highlighting still applies on rich TTYs.
- `--render-plain` forces plain markdown output (no ANSI/highlighting) even in a rich TTY; takes precedence when combined with `--render` / `--render-markdown`.
- `--write-output <path>` saves just the final assistant message to disk (adds `.<model>` per file for multi-model runs), with safe path guards and non-fatal write failures.
- Browser engine: `--chatgpt-url` (alias `--browser-url`) and `browser.chatgptUrl` config let you target specific ChatGPT workspace/folder URLs while keeping API `--base-url` separate.
- Multi-model API runner orchestrates multiple API models in one command and aggregates usage/cost; browser engine stays single-model.
- GPT-5.1 Pro API support (new default) and `gpt-5-pro` alias for earlier Pro rollout; GPT-5.1 Codex (API-only) now works end-to-end with high reasoning and auto-forces the API engine. GPT-5.1 Codex Max isn’t available via API yet; the CLI rejects that model until OpenAI ships it.
- Duplicate prompt guard remains active: Oracle blocks a second run when the exact prompt is already running.

### Changed
- Cookie sync covers Chrome, Chromium, Edge, Brave, and Vivaldi profiles; targets chatgpt.com, chat.openai.com, and atlas.openai.com. Windows browser automation is still partial—prefer API or clipboard fallback there.
- Reject prompts shorter than 10 characters with a friendly hint for pro-tier models (`gpt-5.1-pro`) only (prevents accidental costly runs while leaving cheaper models unblocked). Override via ORACLE_MIN_PROMPT_CHARS for automated environments.
- Browser engine default timeout bumped from 15m (900s) to 20m (1200s) so long GPT-5.x Pro responses don’t get cut off; CLI docs/help text now reflect the new ceiling.
- Duration flags such as `--browser-timeout`/`--browser-input-timeout` now accept chained units (`1h2m10s`, `3m10s`, etc.) plus `h`, `m`, `s`, or `ms` suffixes, matching the formats we already log.
- GPT-5.1 Pro and GPT-5 Pro API runs now default to a 60-minute timeout (was 20m) and the “zombie” detector waits the same hour before marking sessions as `error`; CLI messaging/docs updated accordingly so a single “auto” limit covers both behaviors.
- Browser-to-API coercion now happens automatically for GPT-5.1 Codex and Gemini (with a console hint) instead of failing when `--engine browser` is set.
- Browser engine now fails fast (with guidance) when explicitly requested alongside non-GPT models such as Grok, Claude, or Gemini; pick `--engine api` for those.
- Multi-model output is easier to scan: aggregate header/summary, deduped per-model headings, and on-demand OSC progress when replaying combined logs.
- `--write-output` adds stricter path safety, rejecting unsafe destinations while keeping writes non-fatal to avoid breaking runs.
- Session slugs now trim individual words to 10 characters to keep auto-generated IDs readable when prompts include very long tokens.
- CLI: `--mode` is now a silent alias for `--engine` for backward compatibility with older docs/scripts; prefer `--engine`.
- CLI guardrail: if a session with the same prompt is already running, new runs abort with guidance to reattach unless `--force` is provided (prevents unintended duplicate API/browser runs).

### Fixed
- Browser assistant capture is more resilient: markdown cleanup no longer drops real answers and prompt-echo recovery keeps the assistant text intact.
- Browser cookie sync on Windows now copies the profile DB into a named temp directory with the expected `Cookies` filename so `chrome-cookies-secure` can read it reliably during browser fallbacks.
- Streaming runs in `--render-plain` mode now send chunks directly to stdout and keep the log sink newline-aligned, preventing missing or double-printed output in TTY and background runs.
- CLI output is consistent again: final answers always print to stdout (even when a log sink is active) and inline runs once more echo the assistant text to stdout.
- MCP: stdout is now muted during MCP runs, preventing non-JSON logs from breaking hosts like Cursor.

## 0.3.0 — 2025-11-19

### Added
- Native Azure OpenAI support! Set `AZURE_OPENAI_ENDPOINT` (plus `AZURE_OPENAI_API_KEY` and optionally `AZURE_OPENAI_DEPLOYMENT`/`AZURE_OPENAI_API_VERSION`) or use the new CLI flags (`--azure-endpoint`, `--azure-deployment`, etc.) to switch automatically to the Azure client.
- **Gemini 3 Pro Support**: Use Google's latest model via `oracle --model gemini`. Requires `GEMINI_API_KEY`.
- Configurable API timeout: `--timeout <seconds|auto>` (auto = 20m for most models, 60m for pro models such as gpt-5.1-pro as of 0.4.0). Enforced for streaming and background runs.
- OpenAI-compatible base URL override: `--base-url` (or `apiBaseUrl` in config / `OPENAI_BASE_URL`) lets you target LiteLLM proxies, Azure gateways, and other compatible hosts.
- Help text tip: best results come from 6–30 sentences plus key source files; very short prompts tend to be generic.
- Browser inline cookies: `--browser-inline-cookies[(-file)]` (or env) accepts JSON/base64 payloads, auto-loads `~/.oracle/cookies.{json,base64}`, adds a cookie allowlist (`--browser-cookie-names`), and dry-run now reports whether cookies come from Chrome or inline sources.
- Inline runs now print a single completion line (removed duplicate “Finished” summary), keeping output concise.
- Gemini runs stay on API (no browser detours), and the CLI logs the resolved model id alongside masked keys when it differs.
- `--dry-run [summary|json|full]` is now the single preview flag; `--preview` remains as a hidden alias for compatibility.

### Changed
 - Browser engine is now macOS-only; Windows and Linux runs fail fast with guidance to re-run via `--engine api`. Cross-platform browser support is in progress.
 - Browser fallback tips focus on `--browser-bundle-files`, making it clear users can drag the single bundled file into ChatGPT when automation fails.
 - Sessions TUI separates recent vs older runs, adds an Older/Newer action, keeps headers aligned with rows, and avoids separator crashes while preserving an always-selectable “ask oracle” entry.
- CLI output is tidier and more resilient: graceful Ctrl+C, shorter headers/footers, clearer verbose token labels, and reduced trailing spacing.
- File discovery is more reliable on Windows thanks to normalized paths, native-fs glob handling, and `.gitignore` respect across platforms.

## 0.2.0 — 2025-11-18

### Added
- `oracle-mcp` stdio server (bin) with `consult` and `sessions` tools plus read-only session resources at `oracle-session://{id}/{metadata|log|request}`.
- MCP logging notifications for consult streaming (info/debug with byte sizes); browser engine guardrails now check Chrome availability before a browser run starts.
- Hidden root-level aliases `--message` (prompt) and `--include` (files) to mirror common agent calling conventions.
- `--preview` now works with `--engine browser`, emitting the composed browser payload (token estimate, attachment list, optional JSON/full dumps) without launching Chrome or requiring an API key.
- New `--browser-bundle-files` flag to opt into bundling all attachments into a single upload; bundling is still auto-applied when more than 10 files are provided.
- Desktop session notifications (default on unless CI/SSH) with `--[no-]notify` and optional `--notify-sound`; completed runs announce session name, API cost, and character count via OS-native toasts.
- Per-user JSON5 config at `~/.oracle/config.json` to set default engine/model, notification prefs (including sound/mute rules), browser defaults, heartbeat, file-reporting, background mode, and prompt suffixes. CLI/env still override config.
- Session lists now show headers plus a cost column for quick scanning.

### Changed
- Browser model picker is now more robust: longer menu-open window, richer tokens/testids for GPT-5.1 and GPT-5 Pro, fallback snapshot logging, and best-effort selection to reduce “model not found” errors.
- MCP consult honors notification settings so the macOS Swift notifier fires for MCP-triggered runs.
- `sessions` tool now returns a summary row for `id` lookups by default; pass `detail: true` to fetch full metadata/log/request to avoid large accidental payloads.
- Directory/glob expansions now honor `.gitignore` files and skip dotfiles by default; explicitly matching patterns (e.g., `--file "src/**/.keep"`) still opt in.
- Default ignores when crawling project roots now drop common build/cache folders (`node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp`) unless the path is passed explicitly. Oracle logs each skipped path for transparency.
- Browser engine now logs a one-line warning before cookie sync, noting macOS may prompt for a Keychain password and how to bypass via `--browser-no-cookie-sync` or `--browser-allow-cookie-errors`.
- gpt-5.1-pro API runs default to non-blocking; add `--wait` to block. `gpt-5.1` and browser runs still block by default. CLI now polls once for `in_progress` responses before failing.
- macOS notifier helper now ships signed/notarized with the Oracle icon and auto-repairs execute bits for the fallback terminal-notifier.
- Session summaries and cost displays are clearer, with zombie-session detection to avoid stale runs.
- Token estimation now uses the full request body (instructions + input text + tools/reasoning/background/store) and compares estimated vs actual tokens in the finished stats to reduce 400/413 surprises.
- Help tips now explicitly warn that Oracle cannot see your project unless you pass `--file …` to attach the necessary source.
- Help tips/examples now call out project/platform/version requirements and show how to label cross-repo attachments so the model has the right context.

#### MCP configuration (quick reference)
- Local stdio (mcporter): add to `config/mcporter.json`
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@steipete/oracle", "oracle-mcp"]
  }
  ```
- Claude Code (global/user scope):  
  `claude mcp add --scope user --transport stdio oracle -- oracle-mcp`
- Project-scoped Claude: drop `.mcp.json` next to the repo root with
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["-y", "@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- The MCP `consult` tool honors `~/.oracle/config.json` defaults (engine/model/search/prompt suffix/heartbeat/background/filesReport) unless the caller overrides them.

## 0.1.1 — 2025-11-20

### Added
- Hidden `--files`, `--path`, and `--paths` aliases for `--file`, so all path inputs (including `--include`) merge cleanly; commas still split within a single flag.
- CLI path-merging helper now has unit coverage for alias ordering and comma splitting.
- New `--copy-markdown` flag (alias `--copy`) assembles the markdown bundle and copies it to the clipboard, printing a one-line summary; combine with `--render-markdown` to both print and copy. Clipboard handling now uses `clipboardy` for macOS/Windows/Linux/Wayland/Termux/WSL with graceful failure messaging.

## 0.1.0 — 2025-11-17

Highlights
- Markdown rendering for completed sessions (`oracle session|status <id> --render` / `--render-markdown`) with ANSI formatting in rich TTYs; falls back to raw when logs are huge or stdout isn’t a TTY.
- New `--path` flag on `oracle session <id>` prints the stored session directory plus metadata/request/log files, erroring if anything is missing. Uses soft color in rich terminals for quick scanning.

Details
### Added
- `oracle session <id> --path` now prints the on-disk session directory plus metadata/request/log files, exiting with an error when any expected file is missing instead of attaching.
- When run in a rich TTY, `--path` labels and paths are colorized for easier scanning.

### Improved
- `oracle session|status <id> --render` (alias `--render-markdown`) pretty-prints completed session markdown to ANSI in rich TTYs, falls back to raw when non-TTY or oversized logs.
## 0.0.10 — 2025-11-17

### Added
- Rich terminals that support OSC 9;4 (Ghostty 1.2+, WezTerm, Windows Terminal) now show an inline progress bar while Oracle waits for the OpenAI response; disable with `ORACLE_NO_OSC_PROGRESS=1`, force with `ORACLE_FORCE_OSC_PROGRESS=1`.

## 0.0.9 — 2025-11-16

### Added
- `oracle session|status <id> --render` (alias `--render-markdown`) pretty-prints completed session markdown to ANSI in rich TTYs, falls back to raw when non-TTY or oversized logs.
- Hidden root-level `--session <id>` alias attaches directly to a stored session (for agents/automation).
- README now recommends preferring API engine for reliability and longer uninterrupted runs when an API key is available.
- Session rendering now uses Markdansi (micromark/mdast-based), removing markdown-it-terminal and eliminating HTML leakage/crashes during replays.
- Added a local Markdansi type shim for now; switch to official types once the npm package ships them.
- Markdansi renderer now enables color/hyperlinks when TTY by default and auto-renders sessions unless the user explicitly disables it.

## 0.0.8 — 2025-11-16

### Changed
- Help tips call out that Oracle is one-shot and does not remember prior runs, so every query should include full context.
- `oracle session <id>` now logs a brief notice when extra root-only flags are present (e.g., `--render-markdown`) to make it clear those options are ignored during reattach.

## 0.0.7 — 2025-11-16

### Changed
- Browser-mode thinking monitor now emits a text-only progress bar instead of the "Pro thinking" string.
- `oracle session <id>` trims preamble/log noise and prints from the first `Answer:` line once a session is finished.
- Help tips now stress sending whole directories and richer project briefings for better answers.

## 0.0.6 — 2025-11-15

### Changed
- Colorized live run header (model/tokens/files) when a rich TTY is available.
- Added a blank line before the `Answer:` prefix for readability.
- Masked API key logging now shows first/last 4 characters (e.g., `OPENAI_API_KEY=sk-p****qfAA`).
- Suppressed duplicate session header on reattach and removed repeated background response IDs in heartbeats.

### Browser mode
- When more than 10 files are provided, automatically bundles all files into a single `attachments-bundle.txt` to stay under ChatGPT’s upload cap and logs a verbose warning when bundling occurs.

## 0.0.5 — 2025-11-15

### Added
- Logs the masked OpenAI key in use (`Using OPENAI_API_KEY=xxxx****yyyy`) so runs are traceable without leaking secrets.
- Logs a helpful tip when you run without attachments, reminding you to pass context via `--file`.

## 0.0.3 — 2025-11-15

## 0.0.2 — 2025-11-15

### Added
- Positional prompt shorthand: `oracle "prompt here"` (and `npx -y @steipete/oracle "..."`) now maps the positional argument to `--prompt` automatically.

### Fixed
- `oracle status/session` missing-prompt guard now coexists with the positional prompt path and still shows the cleanup tip when no sessions exist.

## 0.0.1 — 2025-11-15

### Fixed
- Corrected npm binary mapping so `oracle` is installed as an executable. Published with `--tag beta`.

## 0.0.0 — 2025-11-15

### Added
- Dual-engine support (API and browser) with automatic selection: defaults to API when `OPENAI_API_KEY` is set, otherwise falls back to browser mode.
- Session-friendly prompt guard that allows `status`/`session` commands to run without a prompt while still enforcing prompts for normal runs, previews, and dry runs.
- Browser mode uploads each `--file` individually and logs Chrome PID/port for detachable runs.
- Background GPT-5 Pro runs with heartbeat logging and reconnect support for long responses.
- File token accounting (`--files-report`) and dry-run summaries for both engines.
- Comprehensive CLI and browser automation test suites, including engine selection and prompt requirement coverage.

### Changed
- Help text, README, and browser-mode docs now describe the auto engine fallback and the deprecated `--browser` alias.
- CLI engine resolution is centralized to keep legacy flags, model inference, and environment defaults consistent.

### Fixed
- `oracle status` and `oracle session` no longer demand `--prompt` when used directly.
