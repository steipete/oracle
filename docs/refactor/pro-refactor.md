# Oracle Pro Refactor Plan

Comprehensive refactor roadmap following GPT-5 Pro's review. Each section lists the goal, concrete actions, success criteria, dependencies, and open design decisions/options to finalize with the team.

## 1. File Attachments: Ignore + Size Guardrails
- **Goal**: prevent runaway uploads/token blow-ups when `--file` targets large trees.
- **Actions**:
  1. Add a `files.ignore` config (CLI flag + env var + `.oracleignore` file) applied before `readFiles` expands paths.
  2. Add size + count limits (configurable). Warn/abort when per-file or aggregate MB thresholds exceed defaults.
  3. Surface skipped/blocked files in CLI output and session metadata (`filesIgnored`, `filesExceededLimit`).
  4. Extend unit tests covering mixed allow/deny rules and size enforcement.
- **Success Criteria**: Browser/API runs never silently upload `node_modules`/build artifacts; user sees clear messages when limits trigger.
- **Design Options**:
  - `.oracleignore` syntax (gitignore vs JSON). Suggested: gitignore-style with CLI overrides.
  - Hard vs soft limits: fail by default when limits hit, with `--allow-large-files` escape hatch.

## 2. Unified Error Semantics (API + Browser)
- **Goal**: consistent failure types, clearer CLI messaging, richer session metadata.
- **Actions**:
  1. Create typed error classes (`FileValidationError`, `BrowserAutomationError`, etc.) deriving from existing `OracleResponseError`/`OracleTransportError`.
  2. Refactor `runOracle` and `performSessionRun` so every thrown error is normalized before surfacing/logging.
  3. Update session metadata writer to store structured `error.category`, `error.details`, `transport.reason`.
  4. Add tests simulating API transport failures and browser automation failures, asserting metadata + CLI output.
- **Success Criteria**: CLI output distinguishes “validation” vs “browser automation” vs “OpenAI” issues; sessions show the same classification.
- **Design Options**:
  - Should browser failures be retried automatically? If so, add retry config + exponential backoff.
  - Where to hook normalization (wrapper around `runBrowserSessionExecution` or inside `performSessionRun`).

## 3. Browser Automation Resilience
- **Goal**: reduce selector drift bugs, improve observability when DOM flows break.
- **Actions**:
  1. Move *all* selectors/attribute names into `constants.ts`. Stringified DOM scripts import from a helper that injects constants.
  2. When key automation steps fail, capture DOM snapshots + log to session (reuse `logConversationSnapshot`).
  3. Gate sqlite auto-rebuild behind `ORACLE_ALLOW_SQLITE_REBUILD`. Emit clearer log before attempting rebuild.
  4. Add smoke tests compiling the runtime expressions to ensure they reference constants (e.g., via template injection).
- **Success Criteria**: Single source of truth for selectors; failure logs include context; cookie sync behavior predictable.
- **Design Options**:
  - Snapshot format (HTML snippet vs JSON summary).
  - Where to store snapshots (session log vs temp file path logged to user).

## 4. Version Source-of-Truth
- **Goal**: same version string everywhere (CLI banners, browser header, session metadata).
- **Actions**:
  1. Export a tiny helper (e.g., `getCliVersion()`) that reads `package.json` once and caches.
  2. Use helper in `bin/oracle-cli.ts`, `src/oracle/run.ts`, browser session header, session metadata writer.
  3. Add regression test asserting `oracle --version` matches `package.json`.
- **Success Criteria**: No hard-coded version strings.
- **Design Options**: allow overriding via env (`ORACLE_VERSION_OVERRIDE`) for custom builds?

## 5. Stronger Type Boundaries
- **Goal**: eliminate `unknown` casts for CDP clients and FS adapters.
- **Actions**:
  1. Define interfaces for CDP domains (`RuntimeDomain`, `PageDomain`, etc.) and wrap `chrome-remote-interface` to conform.
  2. Replace `unknown` usage in `waitForAssistantResponse`, `readConversationDebugExpression`, etc., with explicit `interface` definitions + guards.
  3. Provide a concrete `createFsAdapter(fs)` instead of `fs as unknown as MinimalFsModule`.
  4. Update tests/mocks accordingly.
- **Success Criteria**: `tsc --noImplicitAny --strictNullChecks` passes with zero `unknown` casts (except intentionally typed helper boundaries).
- **Design Options**: whether to auto-generate CDP types (import `devtools-protocol` types) or maintain minimal local interfaces.

## 6. Accurate Browser Token Estimates
- **Goal**: header token estimate matches what actually enters ChatGPT.
- **Actions**:
  1. When inline files are active, include file sections in tokenizer input.
  2. When attachments are used, label output as “System+prompt tokens only; attachments excluded” to avoid misinterpretation.
  3. Optionally calculate attachment sizes and mention them in verbose logs.
- **Success Criteria**: Users see realistic token counts; docs explain the distinction.
- **Design Options**: Provide a `--browser-token-estimate full|prompt` flag to switch behavior?

## 7. CLI Ergonomics & Preview Mode
- **Goal**: smoother UX for validation/dry runs.
- **Actions**:
  1. Convert prompt requirement into Commander validation (using `.requiredOption` or `.argument`).
  2. Add `--dry-run` that executes file ingestion, ignore rules, token stats, and prints the header + file summary without hitting API/browser.
  3. Ensure `--dry-run` works with `--engine browser` to show which attachments would upload.
- **Success Criteria**: Users can validate inputs quickly; errors surface before expensive work.
- **Design Options**: Should `--dry-run` imply `--preview full`? Probably yes to reuse logic.

## 8. Integration-Level Tests
- **Goal**: cover orchestration paths end-to-end.
- **Actions**:
  1. Add CLI integration tests invoking `node dist/bin/oracle-cli.js` with stubbed API client (e.g., custom env that injects fake client factory).
  2. Add tests covering `performSessionRun` browser branch with mocked `runBrowserSessionExecution` that throws typed errors; assert session metadata updates.
  3. Create fixtures for session metadata files to ensure new fields (`filesIgnored`, `error.category`, etc.) serialize as expected.
- **Success Criteria**: Tests fail if CLI/session orchestration regresses.
- **Design Options**: Use Vitest’s `runInNewContext` vs spawning child processes; trade-off is speed vs fidelity.

---

## Next Steps
1. Confirm open options (ignore syntax, snapshot format, retry policy).
2. Implement sections in roughly the order above (1–4 unblock user experience quickly, 5–8 improve robustness).
3. Track each section as its own PR for easier review.
