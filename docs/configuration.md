# Local configuration (JSON5)

Oracle reads an optional per-user config from `~/.oracle/config.json`. The file uses JSON5 parsing, so trailing commas and comments are allowed.

## Example (`~/.oracle/config.json`)

```json5
{
  // Default engine when neither CLI flag nor env decide
  engine: "api",           // or "browser"
  model: "gpt-5-pro",
  search: "on",            // "on" | "off"

  notify: {
    enabled: true,          // default notifications (still auto-mutes in CI/SSH unless forced on)
    sound: false,           // play a sound on completion
    muteIn: ["CI", "SSH"], // auto-disable when these env vars are set
  },

  browser: {
    chromeProfile: "Default",
    chromePath: null,
    url: null,
    timeoutMs: 900000,
    inputTimeoutMs: 30000,
    headless: false,
    hideWindow: false,
    keepBrowser: false,
  },

  heartbeatSeconds: 30,     // default heartbeat interval
  filesReport: false,       // default per-file token report
  background: true,         // default background mode for API runs
  promptSuffix: "// signed-off by me", // appended to every prompt
  apiBaseUrl: "https://api.openai.com/v1" // override for LiteLLM / custom gateways
}
```

## Precedence

CLI flags → `config.json` → environment → built-in defaults.

- `engine`, `model`, `search`, `filesReport`, `heartbeatSeconds`, and `apiBaseUrl` in `config.json` override the auto-detected values unless explicitly set on the CLI.
- `OPENAI_API_KEY` only influences engine selection when neither the CLI nor `config.json` specify an engine (API when present, otherwise browser).
- `ORACLE_NOTIFY*` env vars still layer on top of the config’s `notify` block.

If the config is missing or invalid, Oracle falls back to defaults and prints a warning for parse errors.
