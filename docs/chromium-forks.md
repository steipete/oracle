# Chromium-based browsers (Chromium, Edge, Brave variants)

Oracle’s browser engine assumes Google Chrome by default: it launches Chrome via `chrome-launcher` and syncs your Chrome profile (excluding locks/caches) so you stay signed in to ChatGPT without Keychain prompts. Chromium, Microsoft Edge, and other forks ship the same DevTools protocol, but they keep the executable and profile directories in different locations. Use the knobs below to point Oracle at those assets explicitly.

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

## 2. Point profile sync at your session

Set `--browser-cookie-path` (or `browser.chromeCookiePath` in config) to the absolute path of the fork’s profile directory (or its `Cookies` DB). Oracle treats either as the profile-sync source, skipping Chrome-only heuristics and profile-name guesses.

```bash
oracle --engine browser \
  --browser-chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --browser-cookie-path "$HOME/Library/Application Support/Microsoft Edge/Profile 1" \
  --prompt "Summarize the release notes"
```

Config example (JSON5):

```json5
{
  browser: {
    chromePath: "/usr/bin/chromium",
    chromeCookiePath: "/home/you/.config/chromium/Default",
    chromeProfile: null
  }
}
```

If you omit `chromeCookiePath`, Oracle falls back to `chromeProfile` (name or explicit path). Providing both keeps things unambiguous.

## Common profile roots

| Browser | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Chrome (default) | `~/Library/Application Support/Google/Chrome/Default` | `~/.config/google-chrome/Default` | `%LOCALAPPDATA%/Google/Chrome/User Data/Default` |
| Chromium | `~/Library/Application Support/Chromium/Default` | `~/.config/chromium/Default` | `%LOCALAPPDATA%/Chromium/User Data/Default` |
| Microsoft Edge | `~/Library/Application Support/Microsoft Edge/Profile 1` (Profile 2, …) | `~/.config/microsoft-edge/Default` | `%LOCALAPPDATA%/Microsoft/Edge/User Data/Profile 1` |

Brave and other forks work the same way—inspect `%APPDATA%`/`~/Library/Application Support`/`~/.config` for their profile directory and pass that path (or its `Cookies` file) to `--browser-cookie-path`.

### macOS / Windows encryption caveat

Profile sync copies the encrypted cookies intact, so you shouldn’t see Keychain/DPAPI prompts. If you intentionally rely on inline cookies instead, those still need valid payloads; fall back to `--browser-inline-cookies[(-file)]` when you can’t access the signed-in profile.

## Troubleshooting checklist

- `oracle --debug-help` lists both `--browser-chrome-path` and `--browser-cookie-path`.
- Run with `-v` to verify which cookie source Oracle is using (Chrome profile, inline payload, or explicit path).
- If profile sync fails to pick up your signed-in session, fall back to inline cookies until you can log in once via that fork.
- `CHROME_PATH` still works as a last-resort override for the executable; config + CLI flags are preferred because they’re persisted per workspace.
