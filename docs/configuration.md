# Local configuration (JSON5)

Oracle reads an optional per-user config from `~/.oracle/config.json`. The file uses JSON5 parsing, so trailing commas and comments are allowed.

## Example (`~/.oracle/config.json`)

```json5
{
  // Default engine when neither CLI flag nor env decide
  engine: "api",           // or "browser"
  model: "gpt-5.1-pro",
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
    timeoutMs: 1200000,
    inputTimeoutMs: 30000,
    headless: false,
    hideWindow: false,
    keepBrowser: false,
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
- `OPENAI_API_KEY` only influences engine selection when neither the CLI nor `config.json` specify an engine (API when present, otherwise browser).
- `ORACLE_NOTIFY*` env vars still layer on top of the config’s `notify` block.
- `sessionRetentionHours` controls the default value for `--retain-hours`. When unset, `ORACLE_RETAIN_HOURS` (if present) becomes the fallback, and the CLI flag still wins over both.
- `browser.chatgptUrl` accepts either the root ChatGPT URL (`https://chatgpt.com/`) or a folder/workspace URL (e.g., `https://chatgpt.com/g/.../project`); `browser.url` remains as a legacy alias.

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
- Defaults: `auto` = 60 m for `gpt-5.1-pro`; non-pro API models use `120s` if you don’t set a value.
- Heartbeat messages print the live remaining time so you can see when the client-side deadline will fire.
