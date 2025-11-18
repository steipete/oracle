# Changelog

All notable changes to this project will be documented in this file.

## 1.2.0 — unreleased

### Added
- `oracle-mcp` stdio server (bin) with `consult` and `sessions` tools plus read-only session resources at `oracle-session://{id}/{metadata|log|request}`.
- MCP logging notifications for consult streaming (info/debug with byte sizes); browser engine guardrails now check Chrome availability before a browser run starts.
- Hidden root-level aliases `--message` (prompt) and `--include` (files) to mirror common agent calling conventions.

### Changed
- `sessions` tool now returns a summary row for `id` lookups by default; pass `detail: true` to fetch full metadata/log/request to avoid large accidental payloads.

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
