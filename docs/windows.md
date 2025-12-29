# Windows compatibility notes

Keep this in sync as we learn more. Read this before doing browser runs on Windows.

- Browser engine is enabled on Windows now, but automation is flakier than macOS. If it fails, rerun with `--engine api --wait` or use `--remote-chrome` to point at a logged-in Chrome with remote debugging.
- Cookies: cookie sync is disabled by default on Windows because ChatGPT cookies are app-bound (`v20`) and fail decryption. Use `--browser-manual-login` to reuse a persistent automation profile and sign in once (skips cookie copy entirely). Inline cookies remain available (`--browser-inline-cookies(-file)` / `ORACLE_BROWSER_COOKIES_JSON`).
- Manual login flow: run with `--browser-manual-login` and log into chatgpt.com in the opened Chrome; Oracle waits until the session is active. For initial login/setup or debugging, add `--browser-keep-browser` to keep the window open after the run; otherwise Oracle closes Chrome but preserves the profile at `~/.oracle/browser-profile` (override with `ORACLE_BROWSER_PROFILE_DIR`). If that automation Chrome is already running with remote debugging enabled (DevToolsActivePort present), reuse it instead of relaunching by pointing Oracle at it via `--remote-chrome <host:port>`.
- Cookie paths: preferred path is `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>\\Network\\Cookies`. If that errors, try the top-level `Cookies` file or supply the exact path via `--browser-cookie-path`.
- mcporter chrome-devtools: requires a valid `CHROME_DEVTOOLS_URL` from a live session; otherwise calls will fail.
- agent-scripts helpers (`runner`, `scripts/committer`) are bash-based and may fail under PowerShell/CMD; run commands directly if they misbehave.
