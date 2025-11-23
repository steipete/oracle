# AGENTS.MD

READ ~/Projects/agent-scripts/AGENTS.MD BEFORE ANYTHING (skip if missing).

Oracle-specific notes:
- Live smoke tests: OpenAI live tests are opt-in. Run `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/openai-live.test.ts` with a real `OPENAI_API_KEY` when you need the background path; gpt-5-pro can take ~10 minutes.
- Wait defaults: gpt-5-pro API runs detach by default; use `--wait` to stay attached. gpt-5.1 and browser runs block by default; every run prints `oracle session <id>` for reattach.
- Session storage: Oracle stores session data under `~/.oracle`; delete it if you need a clean slate.
- CLI output: the first line of any top-level CLI start banner should use the oracle emoji, e.g. `🧿 oracle (<version>) ...`; keep it only for the initial command headline. Exception: the TUI exit message also keeps the emoji.
- Model access note (2025-11-23): gpt-5.1-pro and grok-4.1 are not yet available on Peter’s keys; live tests that require them will fail until access is granted.
- Before a release, skim manual smokes in `docs/manual-tests.md` and rerun any that cover your change surface (especially browser/serve paths).
- If browser smokes echo the prompt (Instant), rerun with `--browser-keep-browser --verbose` in tmux, then inspect DOM with `pnpm tsx scripts/browser-tools.ts eval ...` to confirm assistant turns exist; we fixed a case by refreshing assistant snapshots post-send.
- Browser smokes should preserve Markdown (lists, fences); if output looks flattened or echoed, inspect the captured assistant turn via `browser-tools.ts eval` before shipping.
- Working on Windows? Read and update `docs/windows-work.md` before you start.

Browser-mode debug notes (ChatGPT URL override)
- When a ChatGPT folder/workspace URL is set, Cloudflare can block automation even after cookie sync. Use `--browser-keep-browser` to leave Chrome open, solve the interstitial manually, then rerun.
- If a run stalls/looks finished but CLI didn’t stream output, check the latest session (`oracle status`) and open it (`oracle session <id> --render`) to confirm completion.
- Active Chrome port/pid live in session metadata (`~/.oracle/sessions/<id>/meta.json`). Connect with `npx tsx scripts/browser-tools.ts eval --port <port> "({ href: window.location.href, ready: document.readyState })"` to inspect the page.
- Double-hop nav is implemented (root then target URL), but Cloudflare may still need manual clearance or inline cookies.
- After finishing a feature, ask whether it matters to end users; if yes, update the changelog. Read the top ~100 lines first and group related edits into one entry instead of scattering multiple bullets.
- Beta publishing: when asked to ship a beta to npm, bump the version with a beta suffix (e.g., `0.4.4-beta.1`) before publishing; npm will not let you overwrite an existing beta tag without a new version.
