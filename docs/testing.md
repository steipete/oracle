# Testing quickstart

- Unit/type tests: `pnpm test` (Vitest) and `pnpm run check` (typecheck).
- Browser smokes: `pnpm test:browser` (builds, checks DevTools port 45871, then runs headful browser smokes for GPT-5.1/5.1-pro including inline and upload attachments). Requires a signed-in Chrome profile; runs headful but hides the window by default unless Chrome forces focus.
- Live API smokes: `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:live` (excludes OpenAI pro), `ORACLE_LIVE_TEST=1 OPENAI_API_KEY=… pnpm test:pro` (OpenAI pro live). Expect real usage/cost.
- MCP focused: `pnpm test:mcp` (builds then stdio smoke via mcporter).
- If browser DevTools is blocked on WSL, allow the chosen port (`ORACLE_BROWSER_PORT`/`ORACLE_BROWSER_DEBUG_PORT`, defaults to 45871); see `scripts/test-browser.ts` output for firewall hints.
