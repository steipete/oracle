# Windows compatibility notes

Keep this in sync as we learn more. Read this before doing browser runs on Windows.

- Browser engine is enabled on Windows now, but automation is flakier than macOS. If it fails, rerun with `--engine api --wait` or use `--remote-chrome` to point at a logged-in Chrome with remote debugging.
- Profile sync is **enabled by default** on Windows; we copy your signed-in Chrome profile (excluding locks/caches) so you stay logged in without DPAPI decrypt prompts. Use `--browser-fresh-profile` for a fresh profile, or `--browser-manual-login` if you prefer a dedicated automation profile you sign into once. Inline cookies remain available (`--browser-inline-cookies(-file)` / `ORACLE_BROWSER_COOKIES_JSON`).
- Manual login flow (optional): run with `--browser-manual-login --browser-keep-browser`, log into chatgpt.com in the opened Chrome, then rerun; the profile lives at `~/.oracle/browser-profile` by default (override with `ORACLE_BROWSER_PROFILE_DIR`). If that automation Chrome is already running with remote debugging enabled (DevToolsActivePort present), reuse it instead of relaunching by pointing Oracle at it via `--remote-chrome <host:port>`.
- DPAPI: we override `win-dpapi` to the prebuilt `@primno/dpapi`; VS Build Tools are not required.
- Cookie paths: preferred path is `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>` (or its `Network\\Cookies` DB) if you need to point profile sync at a non-default profile; pass it via `--browser-cookie-path`.
- mcporter chrome-devtools: requires a valid `CHROME_DEVTOOLS_URL` from a live session; otherwise calls will fail.
- agent-scripts helpers (`runner`, `scripts/committer`) are bash-based and may fail under PowerShell/CMD; run commands directly if they misbehave.
