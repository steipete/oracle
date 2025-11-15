# Manual Test Suite (Browser Mode)

These checks validate the real Chrome automation path. Run them whenever you
touch browser mode (Chrome lifecycle, cookie sync, prompt injection, model
selection, markdown capture, etc.).

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
   - Expect immediate failure with `Chrome cookie sync needs sqlite3 bindings...`.
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
- Remember: the browser composer now pastes the system instructions verbatim as the first paragraph, followed by the user prompt. If you see `[SYSTEM]` blocks or any extra prefixes (e.g., “System instructions: …”) in the ChatGPT composer, something regressed in `assembleBrowserPrompt` and you should stop and file a bug.
- Heartbeats: Oracle now emits status heartbeats every 30 s by default (`Browser automation in progress — 2m 0s elapsed...`). Tweak via `--heartbeat 15` or disable with `--heartbeat 0` when recording clean logs.

## Post-Run Validation

- `oracle session <id>` should replay the transcript with markdown.
- `~/.oracle/sessions/<id>/session.json` must include `browser.config` metadata (model label, cookie settings) and `browser.runtime` (PID/port).

Document results (pass/fail, session IDs) in PR descriptions so reviewers can audit real-world behavior.

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
