# Chromium-based browsers (Chromium, Edge, Brave variants)

Oracle’s browser engine assumes Google Chrome by default: it launches Chrome via `chrome-launcher` and copies cookies from Chrome’s profile/keychain so you stay signed in to ChatGPT. Chromium, Microsoft Edge, and other forks ship the same DevTools protocol, but they keep the executable and cookie store in different locations. Use the knobs below to point Oracle at those assets explicitly.

## 1. Point Oracle at the right executable

Either pass the CLI flag or set it once in `~/.oracle/config.json`:

- CLI: `oracle --engine browser --browser-chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" …`
- Config:
  ```json5
  {
    browser: {
      chromePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
  }
  ```

`--browser-chrome-path` (also exposed in `oracle --debug-help`) controls which binary `chrome-launcher` starts. You can still keep `chromeProfile: "Default"` if you want to copy cookies from Chrome proper while launching Edge/Chromium.

To launch the selected binary headlessly, add `--browser-headless` or set `browser.headless: true`:

```bash
oracle --engine browser \
  --browser-chrome-path "/path/to/chromium" \
  --browser-headless \
  --prompt "Summarize the release notes"
```

Headless mode is opt-in; Oracle remains headful by default because some sites reject stock headless Chrome. The selected Chromium binary must provide any compatibility those sites require. Headless is a launch-only option: an explicit `--browser-headless` flag cannot be combined with `--browser-attach-running`, a saved `browser.headless` preference is ignored in attach-running mode (matching other launch-only defaults), and standalone `--remote-chrome` continues to warn and ignore headless.

## 2. Tell cookie sync where your session lives

Set the new `--browser-cookie-path` flag (or `browser.chromeCookiePath` in config) to the absolute path of the fork’s `Cookies` SQLite database. When present, Oracle feeds this path straight into the internal cookie reader, skipping Chrome-only heuristics and profile-name guesses.

```bash
oracle --engine browser \
  --browser-chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --browser-cookie-path "$HOME/Library/Application Support/Microsoft Edge/Profile 1/Cookies" \
  --prompt "Summarize the release notes"
```

Config example (JSON5):

```json5
{
  browser: {
    chromePath: "/usr/bin/chromium",
    chromeCookiePath: "/home/you/.config/chromium/Default/Cookies",
    chromeProfile: null,
  },
}
```

If you omit `chromeCookiePath`, Oracle falls back to `chromeProfile` (name or explicit path). Providing both keeps things unambiguous.

## Common cookie DB paths

| Browser          | macOS                                                                                                     | Linux                                      | Windows                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Chrome (default) | `~/Library/Application Support/Google/Chrome/Default/Cookies`                                             | `~/.config/google-chrome/Default/Cookies`  | `%LOCALAPPDATA%/Google/Chrome/User Data/Default/Network/Cookies`  |
| Chromium         | `~/Library/Application Support/Chromium/Default/Cookies`                                                  | `~/.config/chromium/Default/Cookies`       | `%LOCALAPPDATA%/Chromium/User Data/Default/Network/Cookies`       |
| Microsoft Edge   | `~/Library/Application Support/Microsoft Edge/Default/Cookies` (profiles are `Profile 1`, `Profile 2`, …) | `~/.config/microsoft-edge/Default/Cookies` | `%LOCALAPPDATA%/Microsoft/Edge/User Data/Default/Network/Cookies` |

Brave and other forks work the same way—inspect `%APPDATA%`/`~/Library/Application Support`/`~/.config` for their `Cookies` file and pass its full path to `--browser-cookie-path`.

### macOS / Windows encryption caveat

Oracle now detects the right Keychain/DPAPI label based on the cookie path (`Chrome Safe Storage`, `Chromium Safe Storage`, `Microsoft Edge Safe Storage`, etc.) and pulls the key automatically. If macOS asks for Keychain access, approve it. When the system doesn’t expose that secret (e.g., the browser hasn’t stored any cookies yet), fall back to `--browser-inline-cookies[(-file)]` until you can sign in once via the target browser.

## Troubleshooting checklist

- `oracle --debug-help` lists both `--browser-chrome-path` and `--browser-cookie-path`.
- Run with `-v` to verify which cookie source Oracle is using (Chrome profile, inline payload, or explicit path).
- If cookie sync fails with “Chrome Safe Storage” prompts while using another fork, fall back to inline cookies until the fork’s password store is supported.
- `CHROME_PATH` still works as a last-resort override for the executable; config + CLI flags are preferred because they’re persisted per workspace.
