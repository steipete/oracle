# Browser Mode

Oracle’s `--engine browser` supports three different execution paths:

- **ChatGPT launcher mode** (GPT-\* models): Oracle launches Chrome itself and drives the ChatGPT web UI over CDP.
- **ChatGPT attach-running mode** (GPT-\* models): Oracle attaches to your already-running local Chrome session through Chrome’s local remote-debugging toggle, opens a dedicated tab, and leaves the browser process/profile alone.
- **Gemini web mode** (Gemini models): talks directly to `gemini.google.com` using your signed-in Chrome cookies (no ChatGPT automation).

If you’re running Gemini, also see `docs/gemini.md`.

`oracle --engine browser` routes the assembled prompt bundle through the ChatGPT web UI instead of the Responses API. (Legacy `--browser` still maps to `--engine browser`, but it will be removed.) If you omit `--engine`, Oracle first honors any `engine` value in `~/.oracle/config.json`, then auto-picks API when `OPENAI_API_KEY` is available and falls back to browser otherwise. The CLI writes the same session metadata/logs as API runs, and by default pastes the payload into ChatGPT via a temporary Chrome profile (manual-login mode can reuse a persistent automation profile).

`--preview` now works with `--engine browser`: it renders the composed prompt, lists which files would be uploaded vs inlined, and shows the bundle location when bundling is enabled, without launching Chrome.

## Quick example: browser mode with custom cookies

```bash
# Minimal inline-cookies flow: keep ChatGPT logged in without Keychain
jq '.' ~/.oracle/cookies.json  # file must contain CookieParam[]
oracle --engine browser \
  --browser-inline-cookies-file ~/.oracle/cookies.json \
  --model "GPT-5.5 Pro" \
  -p "Run the UI smoke" \
  --file "src/**/*.ts" --file "!src/**/*.test.ts"
```

`~/.oracle/cookies.json` should be a JSON array shaped like:

```json
[
  {
    "name": "__Secure-next-auth.session-token",
    "value": "<token>",
    "domain": "chatgpt.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  },
  { "name": "_account", "value": "personal", "domain": "chatgpt.com", "path": "/", "secure": true }
]
```

You can pass the same payload inline (`--browser-inline-cookies '<json or base64>'`) or via env (`ORACLE_BROWSER_COOKIES_JSON`, `ORACLE_BROWSER_COOKIES_FILE`). Cloudflare cookies (`cf_clearance`, `__cf_bm`, etc.) are only needed when you hit a challenge.

## Quick example: attach to your running Chrome

Use this when you already have a signed-in Chrome session running with DevTools access enabled and want Oracle to reuse that browser instead of launching its own copy.

```bash
oracle --engine browser \
  --browser-attach-running \
  --model "GPT-5.5 Pro" \
  -p "Summarize the last assistant response in one paragraph"
```

Notes:

- `--browser-attach-running` defaults to local attach discovery at `127.0.0.1:9222`.
- If the browser UI shows a different local endpoint, you can point Oracle at it explicitly:
  ```bash
  oracle --engine browser \
    --browser-attach-running \
    --remote-chrome 127.0.0.1:63332 \
    --model "GPT-5.5 Pro" \
    -p "Summarize the last assistant response in one paragraph"
  ```
- Oracle reads local `DevToolsActivePort` metadata, connects to the browser websocket directly, and then reuses the normal CDP automation flow.
- If Chrome shows a remote-debugging approval prompt on first attach, Oracle issues one attach request and waits briefly for you to allow it before failing.
- Attach mode always opens a fresh Oracle-owned tab and closes only that tab after a successful run.
- Cookie sync, Chrome launch flags, and profile lifecycle flags are skipped because the browser is already running.
- If Chrome is not exposing a classic `/json/version` endpoint, use `--browser-attach-running` instead of standalone `--remote-chrome`.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. Browser mode pastes the system + user text (no special markers) into the ChatGPT composer and, by default, pastes resolved file contents inline until the total pasted content reaches ~60k characters (then switches to uploads).
2. **Automation stack** – code lives under `src/browser/`:
   - Launcher mode starts Chrome via `chrome-launcher` and connects with `chrome-remote-interface`.
   - Attach-running mode reads local `DevToolsActivePort` metadata for the selected local port, connects to the browser websocket, opens a dedicated tab, and reuses the same DOM automation/capture flow against that attached browser.
   - Launcher mode can optionally copy cookies from the requested browser profile via Oracle’s built-in cookie reader (Keychain/DPAPI aware) so you stay signed in.
   - Navigates to `chatgpt.com`, switches the model to the requested GPT-5.5 / GPT-5.4 / GPT-5.2 variant, optionally activates Deep Research, pastes the prompt, waits for completion, and copies the markdown via the built-in “copy turn” button.
   - Immediately probes `/backend-api/me` in the ChatGPT tab to verify the session is authenticated; if the endpoint returns 401/403 we abort early with a login-specific error instead of timing out waiting for the composer.
   - When `--file` inputs would push the pasted composer content over ~60k characters, we switch to uploading attachments (optionally bundled) and wait for ChatGPT to re-enable the send button before submitting the combined system+user prompt.
   - Launcher mode cleans up the temporary profile unless `--browser-keep-browser` is passed.
3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and persist Chrome pid/port or websocket attach metadata plus the Oracle-owned target/tab URL for reattach.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--engine browser`: enables browser mode (legacy `--browser` remains as an alias for now). Without `--engine`, Oracle chooses API when `OPENAI_API_KEY` exists, otherwise browser.
- `--browser-chrome-profile`, `--browser-chrome-path`: cookie source + binary override (defaults to the standard `"Default"` Chrome profile so existing ChatGPT logins carry over).
- `--browser-cookie-path`: explicit path to the Chrome/Chromium/Edge `Cookies` SQLite DB. Handy when you launch a fork via `--browser-chrome-path` and want to copy its session cookies; see [docs/chromium-forks.md](chromium-forks.md) for examples.
- `--browser-attach-running`: attach to a local already-running browser instead of launching Chrome directly. Defaults to `127.0.0.1:9222`; combine with `--remote-chrome <host:port>` to use a different local attach hint.
- `--chatgpt-url`: override the ChatGPT base URL. Works with the root homepage (`https://chatgpt.com/`) **or** a specific workspace/folder link such as `https://chatgpt.com/g/.../project`. `--browser-url` stays as a hidden alias.
- `--browser-timeout`, `--browser-input-timeout`: `1200s (20m)`/`60s` defaults. Durations accept `ms`, `s`, `m`, or `h` and can be chained (`1h2m10s`).
- `--browser-recheck-delay`, `--browser-recheck-timeout`: after an assistant timeout, wait the delay, revisit the conversation, and retry capture (default recheck timeout 120s). Useful for Pro runs that finish later.
- `--browser-reuse-wait`: wait for a shared Chrome profile (DevToolsActivePort) to appear before launching a new Chrome. Helps multiple parallel runs reuse the same Chromium instance.
- `--browser-profile-lock-timeout`: wait for the shared manual-login profile lock before sending, serializing parallel runs that share a Chrome profile.
- `--browser-max-concurrent-tabs`: soft limit for simultaneous ChatGPT tabs sharing one manual-login profile (default `3`). Additional runs wait up to the browser timeout for a slot and log `[browser] Waiting for ChatGPT browser slot...`.
- `--browser-auto-reattach-delay`, `--browser-auto-reattach-interval`, `--browser-auto-reattach-timeout`: after a timeout, start periodic auto-reattach attempts (delay before first attempt, repeat interval, per-attempt timeout). This lets Oracle keep polling a finished Pro response without manual `oracle session` runs.
- `--heartbeat`: browser mode uses this interval to emit long-run ChatGPT status. When ChatGPT exposes a Thinking/Reasoning disclosure, Oracle opens it and logs only liveness metadata such as sidecar presence, UI progress percentage, elapsed time, and last-change age. It does not log the reasoning text.
- If an assistant response still times out (common with long Pro runs), the session stays running for reattach. Use `oracle session <id>` later to collect the final answer or increase `--browser-timeout`.
- `--browser-model-strategy <select|current|ignore>`: control ChatGPT model selection. `select` (default) switches to the requested model; `current` keeps the active model and logs its label; `ignore` skips the picker entirely. (Ignored for Gemini web runs.)
- `--browser-thinking-time <light|standard|extended|heavy>`: set the ChatGPT thinking-time intensity (Thinking/Pro models only). You can also set a default in `~/.oracle/config.json` via `browser.thinkingTime`.
- `--browser-research deep`: activate ChatGPT Deep Research before submitting the prompt. Use this for broad public-web research and final cited reports, not as a replacement for GPT-5.x Pro Heavy code review or pure reasoning.
- `--browser-follow-up <prompt>`: submit another prompt in the same ChatGPT conversation after the initial answer. Repeat the flag for multi-turn reviews such as “challenge your recommendation”, “compare against this constraint”, then “give the final decision”. Deep Research has its own report lifecycle, so browser follow-ups are rejected when `--browser-research deep` is enabled.
- `--browser-port <port>` (alias: `--browser-debug-port`; env: `ORACLE_BROWSER_PORT`/`ORACLE_BROWSER_DEBUG_PORT`): pin the DevTools port (handy on WSL/Windows firewalls). When omitted, a random open port is chosen.
- `--browser-no-cookie-sync`, `--browser-manual-login` (persistent automation profile + user-driven login), `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and the global `-v/--verbose` flag for detailed automation logs.
- `--browser-url`: override ChatGPT base URL if needed.
- `--browser-attachments <auto|never|always>`: control how `--file` inputs are delivered in browser mode. Default `auto` pastes file contents inline up to ~60k characters and switches to uploads above that.
- `--browser-inline-files`: alias for `--browser-attachments never` (forces inline paste; never uploads attachments).
- `--browser-bundle-files`: bundle all resolved attachments into a single temp file before uploading (only used when uploads are enabled/selected).
- sqlite bindings: automatic rebuilds now require `ORACLE_ALLOW_SQLITE_REBUILD=1`. Without it, the CLI logs instructions instead of running `pnpm rebuild` on your behalf.
- `--model`: the same flag used for API runs is accepted, but the ChatGPT automation path supports GPT-5.5, GPT-5.4, and GPT-5.2 variants. Use `gpt-5.5-pro`, `gpt-5.5`, `gpt-5.4-pro`, `gpt-5.4`, `gpt-5.2`, `gpt-5.2-thinking`, `gpt-5.2-instant`, or `gpt-5.2-pro`. Legacy Pro aliases still resolve to the latest Pro picker target.
- Cookie sync is mandatory—if we can’t copy cookies from Chrome, the run exits early. By default Oracle copies a small ChatGPT auth/Cloudflare allowlist to avoid oversized request headers; use `--browser-cookie-names` only when you need to override that set. Use the hidden `--browser-allow-cookie-errors` flag only when you’re intentionally running logged out (it skips the early exit but still warns).
- Attach-running mode is mutually exclusive with launcher-owned flags such as `--browser-manual-login`, `--browser-chrome-profile`, `--browser-cookie-path`, `--browser-hide-window`, `--browser-keep-browser`, and `--browser-port`. `--remote-chrome` is allowed in attach-running mode, but only as the local host:port hint used to find matching `DevToolsActivePort` metadata. `--browser-chrome-path` is accepted but ignored.
- Experimental cookie controls (hidden flags/env):
  - `--browser-cookie-names <comma-list>` or `ORACLE_BROWSER_COOKIE_NAMES`: override the default allowlist of cookies to sync. Useful when ChatGPT changes auth cookie names.
  - `--browser-cookie-wait <ms|s|m>`: if cookie sync fails or returns no cookies, wait once and retry (helps when macOS Keychain prompts are slow).
  - `--browser-inline-cookies <jsonOrBase64>` or `ORACLE_BROWSER_COOKIES_JSON`: skip Chrome/keychain and set cookies directly. Payload is a JSON array of DevTools `CookieParam` objects (or the same, base64-encoded). At minimum you need `name`, `value`, and either `url` or `domain`; we infer `path=/`, `secure=true`, `httpOnly=false`.
  - `--browser-inline-cookies-file <path>` or `ORACLE_BROWSER_COOKIES_FILE`: load the same payload from disk (JSON or base64 JSON). If no args/env are provided, Oracle also auto-loads `~/.oracle/cookies.json` or `~/.oracle/cookies.base64` when present.
  - Practical minimal set that keeps ChatGPT logged in and avoids the workspace picker: `__Secure-next-auth.session-token` (include `.0`/`.1` variants) and `_account` (active workspace/account). Cloudflare proofs (`cf_clearance`, `__cf_bm`/`_cfuvid`/`CF_Authorization`/`__cflb`) are only needed when a challenge is active. In practice our allowlist pulls just two cookies (session token + `_account`) and works; add the Cloudflare names if you hit a challenge.
  - Inline payload shape example (we ignore extra fields like `expirationDate`, `sameSite`, `hostOnly`):
    ```json
    [
      {
        "name": "__Secure-next-auth.session-token",
        "value": "<token>",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "expires": 1771295753
      },
      {
        "name": "_account",
        "value": "personal",
        "domain": "chatgpt.com",
        "path": "/",
        "secure": true,
        "httpOnly": false,
        "expires": 1770702447
      }
    ]
    ```

All options are persisted with the session so restarts (`oracle restart <id>`) reuse the same automation settings.

### Deep Research mode

Use `--browser-research deep` when the task needs broad web discovery, source comparison, or a cited report:

```bash
oracle --engine browser \
  --browser-manual-login \
  --browser-research deep \
  -p "Research the current browser support for WebGPU in enterprise-managed Chrome and cite sources."
```

Oracle activates ChatGPT Deep Research through the composer `/Deepresearch` command and falls back to the composer tools menu when the slash flow is not available. It waits for the research plan to auto-confirm, logs high-level progress, then captures the final report from the Deep Research report surface instead of trusting the assistant tool-call wrapper.

If ChatGPT initially exposes only `Called tool` / `Used tool`, Oracle treats that as an incomplete capture for Deep Research rather than a final answer. Reattach the existing session with `oracle session <id> --render` so Oracle can recover the lazy-loaded report from the existing Chrome tab; do not rerun the research unless the browser session is unrecoverable.

Deep Research is browser-only. It does not use connected apps in v1; give it public-web scope, uploaded files, and any domain/source guidance in the prompt. For deep thinking over code or architecture without web search, prefer a normal browser run with a Pro/Thinking model and `--browser-thinking-time heavy`.

Completed browser sessions also save durable artifacts under `~/.oracle/sessions/<id>/artifacts/`. Deep Research writes the extracted report to `deep-research-report.md`, and every browser run writes `transcript.md` with the prompt, final answer, conversation URL, and saved artifact references. Use `--write-output <path>` when you also need a copy of just the final answer at a specific path.

### Multi-turn browser consults

Use browser follow-ups when a one-shot review would be too easy for the model to answer shallowly. Oracle keeps the same ChatGPT conversation open, waits for each answer, then submits the next follow-up:

```bash
oracle --engine browser \
  --model gpt-5.5-pro \
  --browser-thinking-time heavy \
  -p "Review this migration plan and identify the top risks." \
  --file docs/migration-plan.md \
  --browser-follow-up "Challenge your previous recommendation. What would fail in production?" \
  --browser-follow-up "Now give the final decision with the smallest safe next step."
```

The CLI output and saved `transcript.md` include each captured turn. For PR validation, compare a one-shot run with the same initial prompt against a two-turn run that asks the model to challenge itself; record concrete differences such as additional failure modes, test cases, or rollback steps rather than claiming a fixed quality percentage.

### ChatGPT generated images

When ChatGPT returns downloadable generated images in browser mode, Oracle downloads them using the active browser cookies and records them as session artifacts. To choose an output path, pass `--generate-image <file>`:

```bash
oracle --engine browser \
  --browser-manual-login \
  --model "GPT-5.5 Pro" \
  --generate-image /tmp/oracle-image.png \
  -p "Create a simple product icon on a transparent background."
```

If ChatGPT returns multiple images, the first image saves to the requested path and the rest save as numbered siblings. Without `--generate-image`, Oracle writes images to the session `artifacts/` directory.

### Manual login mode (persistent profile, no cookie copy)

Use `--browser-manual-login` when cookie decrypt is blocked (e.g., Windows app-bound cookies) or you prefer to sign in explicitly. You can also make it the default via `browser.manualLogin` in `~/.oracle/config.json`.

```bash
oracle --engine browser \
  --browser-manual-login \
  --browser-keep-browser \
  --model "GPT-5.5 Pro" \
  -p "Say hi"
```

- Oracle launches Chrome headful with a persistent automation profile at `~/.oracle/browser-profile` (override with `ORACLE_BROWSER_PROFILE_DIR` or `browser.manualLoginProfileDir` in `~/.oracle/config.json`).
- Log into chatgpt.com in that window the first time; Oracle polls until the session is active, then proceeds.
- Reuse the same profile on subsequent runs (no re-login unless the session expires).
- Add `--browser-keep-browser` (or config `browser.keepBrowser=true`) when doing the initial login/setup or debugging so the Chrome window stays open after the run. When omitted, Oracle closes Chrome but preserves the profile on disk.
- Cookie copy is skipped by default in this mode. To automate manual-login runs, set `browser.manualLoginCookieSync=true` in `~/.oracle/config.json` to seed the persistent profile from your existing Chrome cookies; inline cookies apply when cookie sync is enabled.
- If Chrome is already running with that profile and DevTools remote debugging enabled (see `DevToolsActivePort` in the profile dir), you can reuse it instead of relaunching by pointing Oracle at it with `--remote-chrome <host:port>`.
- Remote Chrome runs also participate in tab-slot coordination when paired with `--browser-manual-login` and a shared manual-login profile.

### Concurrent agents and long Pro runs

When Codex, Claude Code, or another Oracle caller share the same manual-login profile, each browser run now acquires a tab slot before opening a ChatGPT tab. The default allows three simultaneous ChatGPT tabs; the fourth caller waits instead of failing because another agent is already using the browser. This is most useful for long Pro/Thinking runs where one agent may wait for a response while another agent needs to start a separate consult.

Use `--browser-max-concurrent-tabs <n>` or `browser.maxConcurrentTabs` to tune the soft limit. Keep the value modest: too many concurrent ChatGPT tabs can make the UI unstable or trigger account-side throttling. Oracle also serializes manual-login Chrome startup for the shared profile, then reuses the first reachable DevTools session instead of racing multiple Chrome launches against the same `user-data-dir`. The short profile lock still serializes the send/upload moment so separate agents do not type into the same composer.

For live concurrency smoke, the most stable path is one already-running signed-in Chrome with remote debugging enabled, plus `--remote-chrome <host:port>`. Direct parallel launch is supported defensively, but a persistent shared Chrome gives clearer ownership and avoids account/login churn across agents.

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
- Oracle opens a dedicated CDP target (new tab) for each run and closes it afterward so your existing tabs stay untouched.
- When remote runs are served by an Oracle host with a manual-login profile, the host-side tab lease registry applies the same concurrent tab limit.
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
   Listening at 0.0.0.0:9473
   Access token: c4e5f9...
   ```

   Use `--host`, `--port`, or `--token` to override the defaults if needed.
   If the host Chrome profile is not signed into ChatGPT, the service opens chatgpt.com for login and exits—sign in, then restart `oracle serve`.

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
   - You can also set defaults in `~/.oracle/config.json` (`browser.remoteHost`, `browser.remoteToken`) so you don’t need the flags; env vars still override those when present.
   - Cookies are **not** transferred from your laptop. The service requires the host Chrome profile to be signed in; if not, it opens chatgpt.com and exits so you can log in, then restart `oracle serve`.

3. **What happens**
   - The CLI assembles the composed prompt + file bundle locally, sends them to the VM, and streams log lines/answer text back through the same HTTP connection.
   - The remote host runs Chrome locally, pulls ChatGPT cookies from its own Chrome profile, and reuses them across runs while the service is up. If cookies are missing, the service exits after opening chatgpt.com so you can sign in before restarting.
   - Background/detached sessions (`--no-wait`) are disabled in remote mode so the CLI can keep streaming output.
   - `oracle serve` logs the DevTools port of the manual-login Chrome (e.g., `Manual-login Chrome DevTools port: 54371`). Runs automatically attach to that logged-in Chrome; you can use the printed port/JSON URL for debugging if needed.

4. **Stop the host**
   - `Ctrl+C` on the VM shuts down the HTTP server and Chrome. Restart `oracle serve` whenever you need a new session; omit `--token` to let it rotate automatically.

This mode is ideal when you have a macOS VM (or spare Mac mini) logged into ChatGPT and you just want to run the CLI from another machine without ever copying profiles or keeping Chrome visible locally.

## Limitations / Follow-Up Plan

- **Attachment lifecycle** – in `auto` mode we prefer inlining files into the composer (fewer moving parts). When we do upload, each `--file` path is uploaded separately (or bundled) so ChatGPT can ingest filenames/content. The automation waits for uploads to finish (send button enabled, upload chips visible) before submitting. When inline paste is rejected by ChatGPT (too large), Oracle retries automatically with uploads.
- **Model picker drift** – we rely on heuristics to pick GPT-5.5 / GPT-5.4 / GPT-5.2 variants. If OpenAI changes the DOM we need to refresh the selectors quickly. Consider snapshot tests or a small “self check” command.
- **Non-mac platforms** – window hiding uses AppleScript today; Linux/Windows just ignore the flag. We should detect platforms explicitly and document the behavior.
- **Streaming UX** – browser runs cannot stream tokens, so we emit heartbeat/status logs while waiting. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- ChatGPT automation smoke: `pnpm test:browser`
- Gemini web (cookie) smoke: `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts` (requires a signed-in Chrome profile at `gemini.google.com`)
- `pnpm test --filter browser` does not exist yet; manual runs with `--engine browser -v` are the current validation path.
- Most of the heavy lifting lives in `src/browserMode.ts`. If you change selectors or the mutation observer logic, run a local `oracle --engine browser --browser-keep-browser` session so you can inspect DevTools before cleanup.
