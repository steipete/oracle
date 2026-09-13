# Testing quickstart

Use Node 24 or 26 and the pnpm version declared in `package.json` for development. Vitest 5 excludes Node 25; Oracle's runtime requirement remains Node >=24. Run `pnpm install --frozen-lockfile` first, which also builds the CLI entrypoints used by integration tests.

CI runs the full suite on Node 24 and 26 across Linux, macOS, and Windows. The Linux Node 24 job runs `pnpm test:coverage`, producing text and LCOV reports in `coverage/`. Coverage includes covered and uncovered `src/**/*.ts` files, with the existing interactive/IPC exclusions in `vitest.config.ts`. Vitest's other generated reports and attachments live in the ignored `.vitest/` directory. See the [Vitest 5 migration guide](https://vitest.dev/guide/migration/).

- Unit/type tests: `pnpm test` (Vitest) and `pnpm run check` (typecheck).
- Gemini unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`.
- Browser smokes: `pnpm test:browser` (builds, checks DevTools port 45871, then runs headful browser smokes with GPT-5.5 for fast cases and GPT-5.5 Pro for the reattach + markdown checks). Requires a signed-in Chrome profile; runs headful but hides the window by default unless Chrome forces focus.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes OpenAI pro), `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI pro live). Expect real usage/cost.
- Gemini web (cookie) live smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`).
- MCP focused: `pnpm test:mcp` (builds then stdio smoke via mcporter).
- If browser DevTools is blocked on WSL, allow the chosen port (`ORACLE_BROWSER_PORT`/`ORACLE_BROWSER_DEBUG_PORT`, defaults to 45871); see `scripts/test-browser.ts` output for firewall hints.
