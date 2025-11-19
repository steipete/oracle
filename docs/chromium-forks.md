# Chromium-based browsers (Chromium, Edge, Brave variants)

Oracle’s browser engine assumes Google Chrome by default: it launches Chrome via `chrome-launcher` and copies cookies from Chrome’s profile/keychain so you stay signed in to ChatGPT. Chromium, Microsoft Edge, and other forks ship the same DevTools protocol, but they keep the executable and cookie store in different locations. Use the knobs below to point Oracle at those assets explicitly.

## 1. Point Oracle at the right executable

Either pass the CLI flag or set it once in `~/.oracle/config.json`:

- CLI: `oracle --engine browser --browser-chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" …`
- Config:
  ```json5
  {
    browser: {
      chromePath: "/Applications/Chromium.app/Contents/MacOS/Chromium"
    }
  }
  ```

`--browser-chrome-path` (also exposed in `oracle --debug-help`) controls which binary `chrome-launcher` starts. You can still keep `chromeProfile: "Default"` if you want to copy cookies from Chrome proper while launching Edge/Chromium.

## 2. Tell cookie sync where your session lives

Set the new `--browser-cookie-path` flag (or `browser.chromeCookiePath` in config) to the absolute path of the fork’s `Cookies` SQLite database. When present, Oracle passes this path directly to `chrome-cookies-secure`, skipping Chrome-only heuristics.

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
    chromeProfile: null
  }
}
```

If you omit `chromeCookiePath`, Oracle falls back to `chromeProfile` (name or explicit path). Providing both keeps things unambiguous.

## Common cookie DB paths

| Browser | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Chrome (default) | `~/Library/Application Support/Google/Chrome/Default/Cookies` | `~/.config/google-chrome/Default/Cookies` | `%LOCALAPPDATA%/Google/Chrome/User Data/Default/Network/Cookies` |
| Chromium | `~/Library/Application Support/Chromium/Default/Cookies` | `~/.config/chromium/Default/Cookies` | `%LOCALAPPDATA%/Chromium/User Data/Default/Network/Cookies` |
| Microsoft Edge | `~/Library/Application Support/Microsoft Edge/Default/Cookies` (profiles are `Profile 1`, `Profile 2`, …) | `~/.config/microsoft-edge/Default/Cookies` | `%LOCALAPPDATA%/Microsoft/Edge/User Data/Default/Network/Cookies` |

Brave and other forks work the same way—inspect `%APPDATA%`/`~/Library/Application Support`/`~/.config` for their `Cookies` file and pass its full path to `--browser-cookie-path`.

### macOS / Windows encryption caveat

`chrome-cookies-secure` currently looks up the Keychain/DPAPI secret for “Chrome Safe Storage”. Chromium reuses the same label on Linux, but Edge/Brave use their own (e.g., “Microsoft Edge Safe Storage”). On macOS/Windows, copying cookies from those forks may fail until we patch the dependency to request the alternate label. When that happens:

1. Launch the fork manually once so it registers the ChatGPT cookies.
2. Export the cookies via DevTools and feed them to Oracle with `--browser-inline-cookies[(-file)]`, **or**
3. Run ChatGPT in Chrome once so the Chrome cookie store contains a valid session, then reuse it even when launching Chromium/Edge.

We’ll broaden the Keychain support in a follow-up, but the path override already unblocks Linux users and anyone willing to provide inline cookies.

## Troubleshooting checklist

- `oracle --debug-help` lists both `--browser-chrome-path` and `--browser-cookie-path`.
- Run with `-v` to verify which cookie source Oracle is using (Chrome profile, inline payload, or explicit path).
- If cookie sync fails with “Chrome Safe Storage” prompts while using another fork, fall back to inline cookies until the fork’s password store is supported.
- `CHROME_PATH` still works as a last-resort override for the executable; config + CLI flags are preferred because they’re persisted per workspace.
