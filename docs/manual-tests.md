# Manual Test Suite (Browser Mode + Live API)

These checks validate the real Chrome automation path and the optional live
Responses API smoke suite. Run the browser steps whenever you touch Chrome
automation (lifecycle, cookie sync, prompt injection, Markdown capture, etc.),
and run the live API suite before shipping major transport changes.

## Prerequisites

- macOS with Chrome installed (default profile signed in to ChatGPT Pro).
- `pnpm install` already completed, and native deps rebuilt as needed via  
  `PYTHON=/usr/bin/python3 npm_config_build_from_source=1 pnpm rebuild chrome-cookies-secure sqlite3 keytar --workspace-root`.
- Headful display access (no `--browser-headless`).
- When debugging, add `--browser-keep-browser` so Chrome stays open after Oracle exits, then connect with `pnpm exec tsx scripts/browser-tools.ts ...` (screenshot, eval, DOM picker, etc.).
- Ensure no Chrome instances are force-terminated mid-run; let Oracle clean up once you’re done capturing state.
- Clipboard checks (`browser-tools.ts eval "navigator.clipboard.readText()"`) trigger a permission dialog in Chrome—approve it for debugging, but remember that we can’t rely on readText in unattended runs.

## Test Cases

### Lightweight Browser CLI (manual exploration)

Before running any agent-driven debugging, you can rely on the TypeScript CLI in `scripts/browser-tools.ts`:

```bash
# Show help / available commands
pnpm tsx scripts/browser-tools.ts --help

# Launch Chrome with your normal profile so you stay logged in
pnpm tsx scripts/browser-tools.ts start --profile

# Drive the active tab
pnpm tsx scripts/browser-tools.ts nav https://example.com
pnpm tsx scripts/browser-tools.ts eval 'document.title'
pnpm tsx scripts/browser-tools.ts screenshot
pnpm tsx scripts/browser-tools.ts pick "Select checkout button"
pnpm tsx scripts/browser-tools.ts cookies
pnpm tsx scripts/browser-tools.ts inspect   # show DevTools-enabled Chrome PIDs/ports/tabs
pnpm tsx scripts/browser-tools.ts kill --all --force   # tear down straggler DevTools sessions
```

This mirrors Mario Zechner’s “What if you don’t need MCP?” technique and is handy when you just need a few quick interactions without spinning up additional tooling.

1. **Cookie Sync Blocks Missing Bindings**
   - Temporarily move `node_modules/.pnpm/sqlite3@*/node_modules/sqlite3` out of the way.
   - Run  
     ```bash
     pnpm run oracle -- --engine browser --model "5.1 Instant" --prompt "Smoke test cookie sync."
     ```
   - Expect an early failure: `Unable to load chrome-cookies-secure. Cookie copy is required.` plus the sqlite rebuild hint.  
   - Restore `sqlite3` and rebuild; rerun to confirm cookies copy successfully (`Copied N cookies from Chrome profile Default`).

2. **Prompt Submission & Model Switching**
   - With sqlite bindings healthy, run  
     ```bash
     pnpm run oracle -- --engine browser --model "5.1 Instant" \
       --prompt "Line 1\nLine 2\nLine 3"
     ```
   - Observe logs for:
     - `Prompt textarea ready (xxx chars queued)` (twice: initial + after model switch).
     - `Model picker: ... Instant...`.
     - `Clicked send button` (or Enter fallback).
   - In the attached Chrome window, verify the multi-line prompt appears exactly as sent.

3. **Markdown Capture**
   - Prompt:
     ```bash
     pnpm run oracle -- --engine browser --model "5.1 Instant" \
       --prompt "Produce a short bullet list with code fencing."
     ```
   - Expected CLI output:
     - `Answer:` section containing bullet list with Markdown preserved (e.g., `- item`, fenced code).
     - Session log (`oracle session <id>`) should show the assistant markdown (confirm via `grep -n '```' ~/.oracle/sessions/<id>/output.log`).

4. **Stop Button Handling**
  - Start a long prompt (`"Write a detailed essay about browsers"`) and once ChatGPT responds, manually click “Stop generating” inside Chrome.
  - Oracle should detect the assistant message (partial) and still store the markdown.

5. **Override Flag**
  - Run with `--browser-allow-cookie-errors` while intentionally breaking bindings.
  - Confirm log shows `Cookie sync failed (continuing with override)` and the run proceeds headless/logged-out.
- Remember: the browser composer now pastes only the user prompt (plus any inline file blocks). If you see the default “You are Oracle…” text or other system-prefixed content in the ChatGPT composer, something regressed in `assembleBrowserPrompt` and you should stop and file a bug.
- Heartbeats: Browser runs do **not** emit `--heartbeat` logs today. Heartbeat settings apply to streaming API runs only; ignore heartbeat toggles when validating browser mode.

## Post-Run Validation

- `oracle session <id>` should replay the transcript with markdown.
- `~/.oracle/sessions/<id>/session.json` must include `browser.config` metadata (model label, cookie settings) and `browser.runtime` (PID/port).

Document results (pass/fail, session IDs) in PR descriptions so reviewers can audit real-world behavior.

## Recent Smoke Runs

- 2025-11-18 — API gpt-5.1 (`api-smoke-give-two-words`): returned “blue sky” in 2.5s.
- 2025-11-18 — API gpt-5-pro (`api-smoke-pro-three-words`): completed in 3m08s with “Fast API verification”.
- 2025-11-18 — Browser gpt-5.1 Instant (`browser-smoke-instant-two-words`): completed in ~10s; replied with a clarification prompt.
- 2025-11-18 — Browser gpt-5-pro (`browser-smoke-pro-three-words`): completed in ~1m33s; response noted “Search tool used.”.
- 2025-11-18 (rerun) — API gpt-5.1 (`api-smoke-give-two-words`): reconfirmed OK; same answer + cost bracket.
- 2025-11-18 (rerun) — Browser gpt-5-pro (`browser-smoke-pro-three-words`): reconfirmed OK; included heartbeat progress and search tool note.

## Browser Regression Checklist (manual)

Run these four smoke tests whenever we touch browser automation:

1. **GPT-5.1 simple prompt**  
   `pnpm run oracle -- --engine browser --model "5.1 Instant" --prompt "Give me two short markdown bullet points about tables"`  
   Expect two markdown bullets, no files/search referenced. Note the session ID (e.g., `give-me-two-short-markdown`).

2. **GPT-5 Pro simple prompt**  
   `pnpm run oracle -- --engine browser --model gpt-5-pro --prompt "List two reasons Markdown is handy"`  
   Confirm the answer arrives (and only once) even if it takes ~2–3 minutes; heartbeat lines should show up while waiting.

3. **GPT-5.1 + attachment**  
   Prepare `/tmp/browser-md.txt` with a short note, then run  
   `pnpm run oracle -- --engine browser --model "5.1 Instant" --prompt "Summarize the key idea from the attached note" --file /tmp/browser-md.txt`  
   Ensure upload logs show “Attachment queued” and the answer references the file contents explicitly.

4. **GPT-5 Pro + attachment**  
   Prepare `/tmp/browser-report.txt` with faux metrics, then run  
   `pnpm run oracle -- --engine browser --model gpt-5-pro --prompt "Use the attachment to report current CPU and memory figures" --file /tmp/browser-report.txt --verbose`  
   Verify verbose logs show attachment upload and the final answer matches the file data.

Record session IDs and outcomes in the PR description (pass/fail, notable delays). This ensures reviewers can audit real runs.

## Chrome DevTools / MCP Debugging

Use this when you need to inspect the live ChatGPT composer (DOM state, markdown text, screenshots, etc.). For smaller ad‑hoc pokes, you can often rely on `pnpm tsx scripts/browser-tools.ts …` instead.

1. **Launch within tmux**
   ```bash
   tmux new -d -s oracle-browser \\
     "pnpm run oracle -- --engine browser --browser-keep-browser \\
       --model '5.1 Instant' --prompt 'Debug via DevTools.'"
   ```
   Keeping the run in tmux prevents your shell from blocking and ensures Chrome stays open afterward.

2. **Grab the DevTools port**
   - `tmux capture-pane -pt oracle-browser` to read the logs (`Launched Chrome … on port 56663`).
   - Verify the endpoint:
     ```bash
     curl http://127.0.0.1:<PORT>/json/version
     ```
     Note the `webSocketDebuggerUrl` for reference.

3. **Attach Chrome DevTools MCP**
   - One-off: `CHROME_DEVTOOLS_URL=http://127.0.0.1:<PORT> npx -y chrome-devtools-mcp@latest`
   - `mcporter` config snippet:
     ```json
     {
       "chrome-devtools": {
         "command": "npx",
         "args": [
           "-y",
           "chrome-devtools-mcp@latest",
           "--browserUrl",
           "http://127.0.0.1:<PORT>"
         ]
       }
     }
     ```
   - Once the server prints `chrome-devtools-mcp exposes…`, you can list/call tools via `mcporter`.

4. **Interact & capture**
   - Use MCP tools (`click`, `evaluate_js`, `screenshot`, etc.) to debug the composer contents.
   - Record any manual actions you take (e.g., “fired evaluate_js to dump #prompt-textarea.innerText”).

5. **Cleanup**
   - `tmux kill-session -t oracle-browser`
   - `pkill -f oracle-browser-<slug>` if Chrome is still running.

> **Tip:** Running `npx chrome-devtools-mcp@latest --help` lists additional switches (custom Chrome binary, headless, viewport, etc.).

## Responses API Live Smoke Tests

These Vitest cases hit the real OpenAI API to exercise both transports:

1. Export a real key and explicitly opt in (default runs stay fast):
   ```bash
   export OPENAI_API_KEY=sk-...
   export ORACLE_LIVE_TEST=1
   pnpm vitest run tests/live/openai-live.test.ts
   ```
2. The first test sends a GPT-5 Pro prompt and expects the CLI to stay in
   background mode until OpenAI finishes (up to 30 minutes). The second test
   targets the standard GPT-5 (gpt-5.1) path with foreground streaming.
3. Watch the console for `Reconnected to OpenAI background response...` if
   you're debugging transport flakiness; the test will fail if the response
   status isn't `completed` or if the text doesn't contain the hard-coded
   smoke strings.

Skip these unless you're intentionally validating the production API; they are
fully gated behind `ORACLE_LIVE_TEST=1` to avoid accidental CI runs.
