# Local configuration (JSON5)

Oracle reads an optional per-user config from `~/.oracle/config.json`, then layers
project configs from `.oracle/config.json` files discovered from your working
directory upward, stopping before your home directory. All config files use
JSON5 parsing, so trailing commas and comments are allowed.

## Example (`~/.oracle/config.json`)

```json5
{
  // Default engine when neither CLI flag nor env decide
  engine: "api", // or "browser"
  model: "gpt-5.5-pro", // older gpt-5.x-pro aliases → gpt-5.5-pro
  search: "on", // "on" | "off"

  notify: {
    enabled: true, // default notifications (still auto-mutes in CI/SSH unless forced on)
    sound: false, // play a sound on completion
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
    debugPort: null, // fixed DevTools port (env: ORACLE_BROWSER_PORT / ORACLE_BROWSER_DEBUG_PORT)
    timeoutMs: 1200000,
    inputTimeoutMs: 30000,
    attachmentTimeoutMs: 90000, // wait for file upload/readiness before clicking Send (default: 45s)
    cookieSyncWaitMs: 0, // wait (ms) before retrying cookie sync when Chrome cookies are empty/locked
    assistantRecheckDelayMs: 0, // wait this long after timeout, then retry capture (0 = disabled)
    assistantRecheckTimeoutMs: 120000, // time budget for the recheck attempt (default: 2m)
    reuseChromeWaitMs: 10000, // wait for a shared Chrome profile to appear before launching (parallel runs)
    profileLockTimeoutMs: 300000, // wait for the manual-login profile lock before sending (parallel runs)
    maxConcurrentTabs: 1, // serialize ChatGPT runs using one manual-login profile (or set ORACLE_BROWSER_MAX_CONCURRENT_TABS)
    queueTimeoutMs: 0, // independent FIFO queue wait budget; 0 waits indefinitely (or set ORACLE_BROWSER_QUEUE_TIMEOUT)
    autoReattachDelayMs: 0, // delay before starting periodic auto-reattach attempts (0 = disabled)
    autoReattachIntervalMs: 0, // interval between auto-reattach attempts (0 = disabled)
    autoReattachTimeoutMs: 120000, // time budget per auto-reattach attempt (default: 2m)
    modelStrategy: "select", // select | current | ignore (ChatGPT only; ignored for Gemini web)
    thinkingTime: "extended", // light | standard | extended | heavy (ChatGPT Thinking/Pro models)
    researchMode: "off", // off | deep (ChatGPT Deep Research; browser only)
    manualLogin: false, // set true to reuse a persistent automation profile and sign in once (Windows defaults to true when unset)
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
    apiVersion: "2025-04-01-preview", // optional legacy knob; Azure v1 Responses runs do not require it
  },

  heartbeatSeconds: 30, // default heartbeat interval
  maxFileSizeBytes: 2097152, // raise/lower the per-file attachment guard (bytes)
  filesReport: false, // default per-file token report
  background: true, // default background mode for API runs
  sessionRetentionHours: 72, // prune cached sessions older than 72h before each run (0 disables)
  promptSuffix: "// signed-off by me", // appended to every prompt
  apiBaseUrl: "https://api.openai.com/v1", // override for LiteLLM / custom gateways
  // API-only, user-config-only overrides for known model keys.
  modelOverrides: {
    "gpt-5.5": {
      apiModel: "gateway-model", // on-wire id exposed by the gateway
      reasoning: { effort: "xhigh" }, // or null to clear the bundled effort
      inputLimit: 1050000,
      pricing: { inputPerToken: 0.000005, outputPerToken: 0.00003 },
    },
  },
}
```

## Project configs

Put a project-level config at `.oracle/config.json` inside any project folder:

```json5
{
  engine: "browser",
  model: "gpt-5.5-pro",
  browser: {
    chatgptUrl: "https://chatgpt.com/g/g-p-example/project",
    modelStrategy: "current",
    archiveConversations: "never",
  },
}
```

Oracle discovers every `.oracle/config.json` from the current directory upward
until your home directory, then applies them from parent to child after the user
config. Nested objects are merged, while scalars and arrays replace earlier
values. This lets a parent folder set broad defaults and override a specific
ChatGPT Project URL in a package subdirectory.

Project configs intentionally support only workflow defaults. They cannot set
provider routing or secret/executable fields such as `apiBaseUrl`, `modelOverrides`, `azure`,
`browser.remoteHost`, `browser.remoteToken`, `browser.chromePath`, or
`browser.chromeCookiePath`. Keep tokens and machine-local executable/profile
paths in `~/.oracle/config.json`, environment variables, or explicit CLI flags.

## Precedence

CLI flags and explicit override environment variables → effective config (project `.oracle/config.json` files over `~/.oracle/config.json`) → auto-detected environment → built-in defaults.

- The effective config starts with `~/.oracle/config.json`, then layers project `.oracle/config.json` files from parent to child. `engine`, `model`, `search`, `filesReport`, `heartbeatSeconds`, `maxFileSizeBytes`, and `apiBaseUrl` in the effective config override auto-detected values unless explicitly set on the CLI or through a supported override environment variable.
- Project `.oracle/config.json` files can override safe workflow defaults such as `engine`, `model`, `search`, `filesReport`, `heartbeatSeconds`, `maxFileSizeBytes`, `promptSuffix`, and allowed `browser.*` workflow settings.
- Provider routing and machine-local fields (`apiBaseUrl`, `modelOverrides`, `azure`, remote browser host/token defaults, Chrome binary/profile paths, cookie DB paths, and session retention cleanup) are ignored in project configs and are read only from the user config, environment variables, or explicit CLI flags.
- `ORACLE_ENGINE=api|browser` is a global override for engine selection (useful for MCP/Codex setups); it wins over `config.json`.
- If `azure.endpoint` (or `--azure-endpoint`) is set, Oracle reads `AZURE_OPENAI_API_KEY` first and falls back to `OPENAI_API_KEY` for GPT models.
- Remote browser defaults follow the same order: `--remote-host/--remote-token` win, then `browser.remoteHost` / `browser.remoteToken` in the config, then `ORACLE_REMOTE_HOST` / `ORACLE_REMOTE_TOKEN` if still unset.
- `OPENAI_API_KEY` only influences engine selection when neither the CLI nor `config.json` specify an engine (API when present, otherwise browser).
- `modelOverrides` applies only to API runs and existing built-in model keys. It can replace the on-wire `apiModel`, reasoning effort, input limit, and per-token pricing; unspecified fields and the bundled tokenizer remain unchanged. Invalid override values are ignored. Project configs cannot set this field.
- `ORACLE_NOTIFY*` env vars still layer on top of the config’s `notify` block.
- `sessionRetentionHours` controls the default value for `--retain-hours`. When unset, `ORACLE_RETAIN_HOURS` (if present) becomes the fallback, and the CLI flag still wins over both.
- `ORACLE_MAX_FILE_SIZE_BYTES` overrides `maxFileSizeBytes` when set. Oracle validates it as a positive integer number of bytes before reading any `--file` inputs.
- `browser.chatgptUrl` accepts either the root ChatGPT URL (`https://chatgpt.com/`) or a folder/workspace URL (e.g., `https://chatgpt.com/g/.../project`); `browser.url` remains as a legacy alias.
- Browser automation defaults can be set under `browser.*`, including `browser.manualLogin`, `browser.manualLoginProfileDir`, `browser.attachRunning`, `browser.thinkingTime` (CLI override: `--browser-thinking-time`), and `browser.researchMode` (CLI override: `--browser-research`). On Windows, `browser.manualLogin` defaults to `true` when omitted.

If the config is missing or invalid, Oracle falls back to defaults and prints a warning for parse errors.

Chromium-based browsers usually need both `chromePath` (binary) and `chromeCookiePath` (cookie DB) set so automation can launch the right executable and reuse your login. See [docs/chromium-forks.md](chromium-forks.md) for detailed paths per browser/OS.

## Session retention

Each invocation can optionally prune cached sessions before starting new work:

- `--retain-hours <n>` deletes sessions older than `<n>` hours right before the run begins. Use `0` (or omit the flag) to skip pruning.
- In `config.json`, set `sessionRetentionHours` to apply pruning automatically for every CLI/TUI/MCP invocation.
- Set `ORACLE_RETAIN_HOURS` in the environment to override the config on shared machines without editing the JSON file.

Under the hood, pruning removes entire session directories (metadata + logs). The command-line cleanup command (`oracle session --clear`) still exists when you need to wipe everything manually.

## Follow-up chaining

`--followup` and `--followup-model` are CLI run flags (not persisted defaults in `config.json`).

- `--followup <sessionId|responseId>` continues a saved ChatGPT browser conversation or an OpenAI/Azure Responses API run. Browser followup reopens the exact conversation and inherits the parent's browser profile, configuration, and model; API followup accepts a stored Oracle session id or a `resp_...` Responses API id.
- For multi-model OpenAI/Azure parent sessions, add `--followup-model <model>` to choose which parent model response to chain from.
- Gemini/Claude API runs and custom `--base-url` providers are intentionally excluded because Oracle cannot preserve `previous_response_id` through those adapters.
- If the session id is wrong, Oracle now prints actionable guidance and suggests close matches from local session history.

Example:

```bash
oracle \
  --engine api \
  --model gpt-5.2-pro \
  --followup release-readiness-audit \
  --followup-model gpt-5.2-pro \
  -p "Follow-up: revise the plan with these files." \
  --file "src/**/*.ts"
```

## API timeouts

- `--timeout <seconds|duration|auto>` controls the overall API deadline for a run. Bare numbers are seconds; duration values such as `10m` and `2h` are supported.
- `--http-timeout <ms|s|m|h>` overrides the HTTP client timeout for API requests. If omitted, explicit `--timeout` values are reused for transport.
- Explicit `--timeout` values also set the stale-session cutoff unless `--zombie-timeout` is provided.
- Defaults: `auto` = 60 m for Pro models; non-pro API models use `120s` if you don’t set a value.
- Heartbeat messages print the live remaining time so you can see when the client-side deadline will fire.

## Zombie/session staleness

- `--zombie-timeout <ms|s|m|h>` overrides the stale-session cutoff used by `oracle status`.
- `--zombie-last-activity` uses last log activity instead of start time to detect stale sessions.

## Performance traces

- `--perf-trace` writes a JSON timing trace with startup, first output, root command, and exit marks.
- `--perf-trace-path /tmp/oracle.json` or `--perf-trace=/tmp/oracle.json` writes to an explicit path.
- `ORACLE_PERF_TRACE=1` writes `.oracle-perf-<timestamp>-<pid>.json` in the current directory.
- `ORACLE_PERF_TRACE=/tmp/oracle.json` writes to an explicit path.
- Trace args are secret-safe: prompt text, tokens, cookie payloads, inline cookies, and API key-like values are redacted.
- Detached API runs write a session-suffixed child trace beside the requested trace path so startup and background execution can be inspected separately.
- Useful events: `cli-module-ready`, `pre-action`, `root-command-start`, `first-output`, `command-action-complete`, and `exit`.
