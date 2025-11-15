# Changelog

## 2025-11-15

- **Debug help shortcut** – Added `--help --verbose`/`--debug-help` output so hidden search/token/browser flags are documented without overwhelming the primary help text.
- **Engine flag** – Introduced `--engine <api|browser>` (default `api`) so mode selection is explicit; legacy `--browser` now just aliases `--engine browser`.
- **CLI helper refactor** – Extracted reusable CLI utilities (option parsing, session execution, prompt assembly) and expanded automated test coverage for those helpers.
- **Transport metadata logging** – CLI now records transport errors and response metadata in session logs to make flaky network/API issues easier to diagnose.
- **Browser helper modules + tests** – Split the browser automation stack into focused modules (`chromeLifecycle`, `cookies`, `pageActions`, `prompt`, `sessionRunner`, etc.) with targeted tests.
- **Browser mode refactor** – Deprecated the monolithic `browserMode.ts` file in favor of the modular implementation, improving readability and maintainability.
