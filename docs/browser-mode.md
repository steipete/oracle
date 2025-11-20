# Browser Mode

`oracle --engine browser` routes the assembled prompt bundle through the ChatGPT web UI instead of the Responses API. (Legacy `--browser` still maps to `--engine browser`, but it will be removed.) If you omit `--engine`, Oracle first honors any `engine` value in `~/.oracle/config.json`, then auto-picks API when `OPENAI_API_KEY` is available and falls back to browser otherwise. The CLI writes the same session metadata/logs as API runs, but the payload is pasted into ChatGPT via a temporary Chrome profile.

`--preview` now works with `--engine browser`: it renders the composed prompt, lists which files would be uploaded vs inlined, and shows the bundle location when bundling is enabled, without launching Chrome.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. Browser mode pastes the system + user text (no special markers) into the ChatGPT composer and then uploads each resolved `--file` individually (via the hidden `<input type="file">`) before submitting the prompt.
2. **Automation stack** – code lives in `src/browserMode.ts` and is a lightly refactored version of the `oraclecheap` utility:
   - Launches Chrome via `chrome-launcher` and connects with `chrome-remote-interface`.
   - (Optional) copies cookies from the requested browser profile via Oracle’s built-in cookie reader (Keychain/DPAPI aware) so you stay signed in.
   - Navigates to `chatgpt.com`, switches the model (currently just label-matching for GPT-5.1/GPT-5 Pro), pastes the prompt, waits for completion, and copies the markdown via the built-in “copy turn” button.
   - Immediately probes `/backend-api/me` in the ChatGPT tab to verify the session is authenticated; if the endpoint returns 401/403 we abort early with a login-specific error instead of timing out waiting for the composer.
   - When files are queued, we upload them one-by-one via the hidden `<input type="file">` and wait for ChatGPT to re-enable the send button before submitting the combined system+user prompt.
   - Cleans up the temporary profile unless `--browser-keep-browser` is passed.
3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and log the Chrome PID/port so `oracle session <id>` (or `oracle status <id>`) shows a marker for the background Chrome process.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--engine browser`: enables browser mode (legacy `--browser` remains as an alias for now). Without `--engine`, Oracle chooses API when `OPENAI_API_KEY` exists, otherwise browser.
- `--browser-chrome-profile`, `--browser-chrome-path`: cookie source + binary override (defaults to the standard `"Default"` Chrome profile so existing ChatGPT logins carry over).
- `--browser-cookie-path`: explicit path to the Chrome/Chromium/Edge `Cookies` SQLite DB. Handy when you launch a fork via `--browser-chrome-path` and want to copy its session cookies; see [docs/chromium-forks.md](chromium-forks.md) for examples.
- `--chatgpt-url`: override the ChatGPT base URL. Works with the root homepage (`https://chatgpt.com/`) **or** a specific workspace/folder link such as `https://chatgpt.com/g/.../project`. `--browser-url` stays as a hidden alias.
- `--browser-timeout`, `--browser-input-timeout`: `1200s (20m)`/`30s` defaults. Durations accept `ms`, `s`, `m`, or `h` and can be chained (`1h2m10s`).
- `--browser-no-cookie-sync`, `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and the global `-v/--verbose` flag for detailed automation logs.
- `--browser-url`: override ChatGPT base URL if needed.
- `--browser-inline-files`: paste resolved files directly into the composer instead of uploading them (debug fallback; useful when the attachment button is broken).
- `--browser-bundle-files`: bundle all resolved attachments into a single temp file before uploading (useful when you want one upload even with many files).
- sqlite bindings: automatic rebuilds now require `ORACLE_ALLOW_SQLITE_REBUILD=1`. Without it, the CLI logs instructions instead of running `pnpm rebuild` on your behalf.
- `--model`: the same flag used for API runs controls the ChatGPT picker. Pass descriptive labels such as `--model "ChatGPT 5.1 Instant"` when you want a specific browser variant; canonical API names (`gpt-5.1-pro`, `gpt-5.1`) still work and map to their default picker labels.
- Cookie sync is mandatory—if we can’t copy cookies from Chrome, the run exits early. Use the hidden `--browser-allow-cookie-errors` flag only when you’re intentionally running logged out (it skips the early exit but still warns).
- Experimental cookie controls (hidden flags/env):
  - `--browser-cookie-names <comma-list>` or `ORACLE_BROWSER_COOKIE_NAMES`: allowlist which cookies to sync. Useful for “only NextAuth/Cloudflare, drop the rest.”
  - `--browser-inline-cookies <jsonOrBase64>` or `ORACLE_BROWSER_COOKIES_JSON`: skip Chrome/keychain and set cookies directly. Payload is a JSON array of DevTools `CookieParam` objects (or the same, base64-encoded). At minimum you need `name`, `value`, and either `url` or `domain`; we infer `path=/`, `secure=true`, `httpOnly=false`.
  - `--browser-inline-cookies-file <path>` or `ORACLE_BROWSER_COOKIES_FILE`: load the same payload from disk (JSON or base64 JSON). If no args/env are provided, Oracle also auto-loads `~/.oracle/cookies.json` or `~/.oracle/cookies.base64` when present.
  - Practical minimal set that keeps ChatGPT logged in and avoids the workspace picker: `__Secure-next-auth.session-token` (include `.0`/`.1` variants) and `_account` (active workspace/account). Cloudflare proofs (`cf_clearance`, `__cf_bm`/`_cfuvid`/`CF_Authorization`/`__cflb`) are only needed when a challenge is active. In practice our allowlist pulls just two cookies (session token + `_account`) and works; add the Cloudflare names if you hit a challenge.
  - Inline payload shape example (we ignore extra fields like `expirationDate`, `sameSite`, `hostOnly`):  
    ```json
    [
      { "name": "__Secure-next-auth.session-token", "value": "<token>", "domain": "chatgpt.com", "path": "/", "secure": true, "httpOnly": true, "expires": 1771295753 },
      { "name": "_account", "value": "personal", "domain": "chatgpt.com", "path": "/", "secure": true, "httpOnly": false, "expires": 1770702447 }
    ]
    ```

All options are persisted with the session so reruns (`oracle exec <id>`) reuse the same automation settings.

## Remote Chrome Sessions (headless/server workflows)

Oracle can reuse an already-running Chrome/Edge instance on another machine by tunneling over the Chrome DevTools Protocol. This is handy when:

- Your CLI runs on a headless server (Linux/macOS CI, remote mac minis, etc.) but you want the browser UI to live on a desktop where you can see uploads or respond to Captcha challenges.
- You want to keep a single signed-in profile open (e.g., Windows VM with company SSO) while sending prompts from other hosts.

### 1. Start Chrome with remote debugging enabled

On the machine that should host the browser window:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/path/to/profile \
  --profile-directory='Default'
```

Notes:

- Any Chromium flavor works (Chrome, Edge, Vivaldi, etc.)—just ensure CDP is exposed on a reachable host:port. Linux distributions often call the binary `google-chrome-stable`. On macOS you can run `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--remote-debugging-address=0.0.0.0` is required if the CLI connects from another machine. Lock it down behind a VPN or SSH tunnel if the network is untrusted.
- Keep this browser window open and signed into ChatGPT; Oracle will reuse that session and **will not** copy cookies over the wire.

### 2. Point Oracle at the remote browser

From the machine running `oracle`:

```bash
oracle --engine browser \
  --remote-chrome 192.168.1.10:9222 \
  --prompt "Summarize the latest incident doc" \
  --file docs/incidents/latest.md
```

Key behavior:

- Use IPv6 by wrapping the host in brackets, e.g. `--remote-chrome "[2001:db8::1]:9222"`.
- Local-only flags like `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and `--browser-chrome-path` are ignored because Oracle no longer launches Chrome. You still get verbose logging, model switching, attachment uploads, and markdown capture.
- Cookie sync is skipped automatically (the remote browser already has cookies). If you need inline cookies, use them on the machine that’s actually running Chrome.
- Attachments are transferred via CDP: Oracle reads each file locally, base64-encodes it, and uses `DataTransfer` inside the remote browser to populate the upload field. Files larger than 20 MB are rejected to keep CDP messages reasonable.
- When the remote WebSocket disconnects, Oracle errors with “Remote Chrome connection lost…” so you can re-run after restarting the browser.

### 3. Troubleshooting

- Run `scripts/test-remote-chrome.ts <host> [port]` to sanity-check connectivity (`npx tsx scripts/test-remote-chrome.ts my-host 9222`).
- If you target IPv6 without brackets (e.g., `2001:db8::1:9222`), the CLI rejects it—wrap the address like `[2001:db8::1]:9222`.
- Ensure firewalls allow inbound TCP to the debugging port and that you’re not behind a captive proxy stripping WebSocket upgrades.
- Because we do not control the remote lifecycle, Chrome stays running after the session. Shut it down manually when you’re done or remove `--remote-debugging-port` to stop exposing CDP.

### Remote Service Mode (`oracle serve`)

Prefer to keep Chrome entirely on the remote Mac (no DevTools tunneling, no manual cookie shuffling)? Use the built-in service:

1. **Start the host**
   ```bash
   oracle serve
   ```
   Oracle picks a free port, launches Chrome, starts an HTTP/SSE API, and prints:
   ```
   Remote Oracle listening at 0.0.0.0:9473
   Access token: c4e5f9...
   ```
   Use `--host`, `--port`, or `--token` to override the defaults if needed.

2. **Run from your laptop**
   ```bash
   oracle --engine browser \
     --remote-host 192.168.64.2:9473 \
     --remote-token c4e5f9... \
     --prompt "Summarize the incident doc" \
     --file docs/incidents/latest.md
   ```
   - `--remote-host` points the CLI at the VM.
   - `--remote-token` matches the token printed by `oracle serve` (set `ORACLE_REMOTE_TOKEN` to avoid repeating it).
   - Cookies are **not** transferred from your laptop. The remote host will reuse its own ChatGPT cookies; if none exist, the service opens ChatGPT in a browser window so you can sign in once, then reuses that session for subsequent runs.

3. **What happens**
   - The CLI assembles the composed prompt + file bundle locally, sends them to the VM, and streams log lines/answer text back through the same HTTP connection.
   - The remote host runs Chrome locally, pulls ChatGPT cookies from its own Chrome profile, and reuses them across runs while the service is up. If cookies are missing, it prompts you to sign in once on the host.
   - Background/detached sessions (`--no-wait`) are disabled in remote mode so the CLI can keep streaming output.

4. **Stop the host**
   - `Ctrl+C` on the VM shuts down the HTTP server and Chrome. Restart `oracle serve` whenever you need a new session; omit `--token` to let it rotate automatically.

This mode is ideal when you have a macOS VM (or spare Mac mini) logged into ChatGPT and you just want to run the CLI from another machine without ever copying profiles or keeping Chrome visible locally.

## Limitations / Follow-Up Plan

- **Attachment lifecycle** – every `--file` path is uploaded separately so ChatGPT can ingest the original filenames/content. The automation waits for the uploads to finish (send button enabled, no upload indicators) before hitting submit. Follow-up work: expose upload status in session logs. When upload automation flakes, use `--browser-inline-files` to fall back to pasting file contents directly.
- **Model picker drift** – we currently rely on heuristics to pick GPT-5.1/GPT-5 Pro. If OpenAI changes the DOM we need to refresh the selectors quickly. Consider snapshot tests or a small “self check” command.
- **Non-mac platforms** – window hiding uses AppleScript today; Linux/Windows just ignore the flag. We should detect platforms explicitly and document the behavior.
- **Streaming UX** – browser runs cannot stream tokens, so we log a warning before launching Chrome. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- `pnpm test --filter browser` does not exist yet; manual runs with `--engine browser -v` are the current validation path.
- Most of the heavy lifting lives in `src/browserMode.ts`. If you change selectors or the mutation observer logic, run a local `oracle --engine browser --browser-keep-browser` session so you can inspect DevTools before cleanup.
