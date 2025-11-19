# Changelog

All notable changes to this project will be documented in this file.

## 1.3.0 — 2025-11-19

### Added
- Native Azure OpenAI support! Set `AZURE_OPENAI_ENDPOINT` (plus `AZURE_OPENAI_API_KEY` and optionally `AZURE_OPENAI_DEPLOYMENT`/`AZURE_OPENAI_API_VERSION`) or use the new CLI flags (`--azure-endpoint`, `--azure-deployment`, etc.) to switch automatically to the Azure client.
- **Gemini 3 Pro Support**: Use Google's latest model via `oracle --model gemini`. Requires `GEMINI_API_KEY`.
- Configurable API timeout: `--timeout <seconds|auto>` (default auto = 20m for gpt-5-pro, 30s for other models). Enforced for streaming and background runs.
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

## 1.2.0 — 2025-11-18

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
- gpt-5-pro API runs default to non-blocking; add `--wait` to block. `gpt-5.1` and browser runs still block by default. CLI now polls once for `in_progress` responses before failing.
- macOS notifier helper now ships signed/notarized with the Oracle icon and auto-repairs execute bits for the fallback terminal-notifier.
- Session summaries and cost displays are clearer, with zombie-session detection to avoid stale runs.
- Token estimation now uses the full request body (instructions + input text + tools/reasoning/background/store) and compares estimated vs actual tokens in the finished stats to reduce 400/413 surprises.
- Help tips now explicitly warn that Oracle cannot see your project unless you pass `--file …` to attach the necessary source.

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

## 1.1.0 — 2025-11-17

Highlights
- Markdown rendering for completed sessions (`oracle session|status <id> --render` / `--render-markdown`) with ANSI formatting in rich TTYs; falls back to raw when logs are huge or stdout isn’t a TTY.
- New `--path` flag on `oracle session <id>` prints the stored session directory plus metadata/request/log files, erroring if anything is missing. Uses soft color in rich terminals for quick scanning.

Details
### Added
- `oracle session <id> --path` now prints the on-disk session directory plus metadata/request/log files, exiting with an error when any expected file is missing instead of attaching.
- When run in a rich TTY, `--path` labels and paths are colorized for easier scanning.

### Improved
- `oracle session|status <id> --render` (alias `--render-markdown`) pretty-prints completed session markdown to ANSI in rich TTYs, falls back to raw when non-TTY or oversized logs.
## 1.0.10 — 2025-11-17

### Added
- Rich terminals that support OSC 9;4 (Ghostty 1.2+, WezTerm, Windows Terminal) now show an inline progress bar while Oracle waits for the OpenAI response; disable with `ORACLE_NO_OSC_PROGRESS=1`, force with `ORACLE_FORCE_OSC_PROGRESS=1`.

## 1.0.9 — 2025-11-16

### Added
- `oracle session|status <id> --render` (alias `--render-markdown`) pretty-prints completed session markdown to ANSI in rich TTYs, falls back to raw when non-TTY or oversized logs.
- Hidden root-level `--session <id>` alias attaches directly to a stored session (for agents/automation).
- README now recommends preferring API engine for reliability and longer uninterrupted runs when an API key is available.
- Session rendering now uses Markdansi (micromark/mdast-based), removing markdown-it-terminal and eliminating HTML leakage/crashes during replays.
- Added a local Markdansi type shim for now; switch to official types once the npm package ships them.
- Markdansi renderer now enables color/hyperlinks when TTY by default and auto-renders sessions unless the user explicitly disables it.

## 1.0.8 — 2025-11-16

### Changed
- Help tips call out that Oracle is one-shot and does not remember prior runs, so every query should include full context.
- `oracle session <id>` now logs a brief notice when extra root-only flags are present (e.g., `--render-markdown`) to make it clear those options are ignored during reattach.

## 1.0.7 — 2025-11-16

### Changed
- Browser-mode thinking monitor now emits a text-only progress bar instead of the "Pro thinking" string.
- `oracle session <id>` trims preamble/log noise and prints from the first `Answer:` line once a session is finished.
- Help tips now stress sending whole directories and richer project briefings for better answers.

## 1.0.6 — 2025-11-15

### Changed
- Colorized live run header (model/tokens/files) when a rich TTY is available.
- Added a blank line before the `Answer:` prefix for readability.
- Masked API key logging now shows first/last 4 characters (e.g., `OPENAI_API_KEY=sk-p****qfAA`).
- Suppressed duplicate session header on reattach and removed repeated background response IDs in heartbeats.

### Browser mode
- When more than 10 files are provided, automatically bundles all files into a single `attachments-bundle.txt` to stay under ChatGPT’s upload cap and logs a verbose warning when bundling occurs.

## 1.0.5 — 2025-11-15

### Added
- Logs the masked OpenAI key in use (`Using OPENAI_API_KEY=xxxx****yyyy`) so runs are traceable without leaking secrets.
- Logs a helpful tip when you run without attachments, reminding you to pass context via `--file`.

## 1.0.3 — 2025-11-15

## 1.0.2 — 2025-11-15

## 1.0.2 — 2025-11-15

### Added
- Positional prompt shorthand: `oracle "prompt here"` (and `npx -y @steipete/oracle "..."`) now maps the positional argument to `--prompt` automatically.

### Fixed
- `oracle status/session` missing-prompt guard now coexists with the positional prompt path and still shows the cleanup tip when no sessions exist.

## 1.0.1 — 2025-11-15

### Fixed
- Corrected npm binary mapping so `oracle` is installed as an executable. Published with `--tag beta`.

## 1.0.0 — 2025-11-15

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
