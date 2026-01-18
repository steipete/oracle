# Local configuration (JSON5)

Oracle reads an optional per-user config from `~/.oracle/config.json`. The file uses JSON5 parsing, so trailing commas and comments are allowed.

## Example (`~/.oracle/config.json`)

```json5
{
  // Default engine when neither CLI flag nor env decide
  engine: "api",           // or "browser"
  model: "gpt-5.1-pro",    // API alias → gpt-5.2-pro
  search: "on",            // "on" | "off"

  notify: {
    enabled: true,          // default notifications (still auto-mutes in CI/SSH unless forced on)
    sound: false,           // play a sound on completion
    muteIn: ["CI", "SSH"], // auto-disable when these env vars are set
  },

  browser: {
    chromeProfile: "Default",
    chromePath: null,
    chromeCookiePath: null,
    chatgptUrl: "https://chatgpt.com/", // root is fine; folder URLs also work
    url: null, // alias for chatgptUrl (kept for back-compat)
    // Remote browser bridge (preferred place to store remote host settings)
    remoteHost: "127.0.0.1:9473",
    remoteToken: "…", // written by `oracle bridge client` (kept private; not printed by default)
    remoteViaSshReverseTunnel: { ssh: "user@linux-host", remotePort: 9473 }, // optional metadata
    debugPort: null,          // fixed DevTools port (env: ORACLE_BROWSER_PORT / ORACLE_BROWSER_DEBUG_PORT)
    timeoutMs: 1200000,
    inputTimeoutMs: 30000,
    cookieSyncWaitMs: 0,      // wait (ms) before retrying cookie sync when Chrome cookies are empty/locked
    modelStrategy: "select", // select | current | ignore (ChatGPT only; ignored for Gemini web)
    thinkingTime: "extended", // light | standard | extended | heavy (ChatGPT Thinking/Pro models)
    manualLogin: false,        // set true to reuse a persistent automation profile and sign in once (Windows defaults to true when unset)
    manualLoginProfileDir: null, // override profile dir (or set ORACLE_BROWSER_PROFILE_DIR)
    headless: false,
    hideWindow: false,
    keepBrowser: false,
    manualLoginCookieSync: false, // allow cookie sync even in manual-login mode
  },

  // Azure OpenAI defaults (only used when endpoint is set)
  azure: {
    endpoint: "https://your-resource-name.openai.azure.com/",
    deployment: "gpt-5-1-pro",
    apiVersion: "2024-02-15-preview"
  },

  heartbeatSeconds: 30,     // default heartbeat interval
  filesReport: false,       // default per-file token report
  background: true,         // default background mode for API runs
  sessionRetentionHours: 72, // prune cached sessions older than 72h before each run (0 disables)
  promptSuffix: "// signed-off by me", // appended to every prompt
  apiBaseUrl: "https://api.openai.com/v1" // override for LiteLLM / custom gateways
}
```

## Precedence

CLI flags → `config.json` → environment → built-in defaults.

- `engine`, `model`, `search`, `filesReport`, `heartbeatSeconds`, and `apiBaseUrl` in `config.json` override the auto-detected values unless explicitly set on the CLI.
- `ORACLE_ENGINE=api|browser` is a global override for engine selection (useful for MCP/Codex setups); it wins over `config.json`.
- If `azure.endpoint` (or `--azure-endpoint`) is set, Oracle reads `AZURE_OPENAI_API_KEY` first and falls back to `OPENAI_API_KEY` for GPT models.
- Remote browser defaults follow the same order: `--remote-host/--remote-token` win, then `browser.remoteHost` / `browser.remoteToken` in the config, then `ORACLE_REMOTE_HOST` / `ORACLE_REMOTE_TOKEN` if still unset.
- `OPENAI_API_KEY` only influences engine selection when neither the CLI nor `config.json` specify an engine (API when present, otherwise browser).
- `ORACLE_NOTIFY*` env vars still layer on top of the config’s `notify` block.
- `sessionRetentionHours` controls the default value for `--retain-hours`. When unset, `ORACLE_RETAIN_HOURS` (if present) becomes the fallback, and the CLI flag still wins over both.
- `browser.chatgptUrl` accepts either the root ChatGPT URL (`https://chatgpt.com/`) or a folder/workspace URL (e.g., `https://chatgpt.com/g/.../project`); `browser.url` remains as a legacy alias.
- Browser automation defaults can be set under `browser.*`, including `browser.manualLogin`, `browser.manualLoginProfileDir`, and `browser.thinkingTime` (CLI override: `--browser-thinking-time`). On Windows, `browser.manualLogin` defaults to `true` when omitted.

If the config is missing or invalid, Oracle falls back to defaults and prints a warning for parse errors.

Chromium-based browsers usually need both `chromePath` (binary) and `chromeCookiePath` (cookie DB) set so automation can launch the right executable and reuse your login. See [docs/chromium-forks.md](chromium-forks.md) for detailed paths per browser/OS.

## Session retention

Each invocation can optionally prune cached sessions before starting new work:

- `--retain-hours <n>` deletes sessions older than `<n>` hours right before the run begins. Use `0` (or omit the flag) to skip pruning.
- In `config.json`, set `sessionRetentionHours` to apply pruning automatically for every CLI/TUI/MCP invocation.
- Set `ORACLE_RETAIN_HOURS` in the environment to override the config on shared machines without editing the JSON file.

Under the hood, pruning removes entire session directories (metadata + logs). The command-line cleanup command (`oracle session --clear`) still exists when you need to wipe everything manually.

## API timeouts

- `--timeout <seconds|auto>` controls the overall API deadline for a run.
- `--http-timeout <ms|s|m|h>` overrides the HTTP client timeout for API requests (default 20m).
- Defaults: `auto` = 60 m for `gpt-5.1-pro`; non-pro API models use `120s` if you don’t set a value.
- Heartbeat messages print the live remaining time so you can see when the client-side deadline will fire.

## Zombie/session staleness

- `--zombie-timeout <ms|s|m|h>` overrides the stale-session cutoff used by `oracle status`.
- `--zombie-last-activity` uses last log activity instead of start time to detect stale sessions.
