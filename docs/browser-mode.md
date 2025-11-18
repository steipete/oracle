# Browser Mode

`oracle --engine browser` routes the assembled prompt bundle through the ChatGPT web UI instead of the Responses API. (Legacy `--browser` still maps to `--engine browser`, but it will be removed.) If you omit `--engine`, Oracle auto-picks API when `OPENAI_API_KEY` is available and falls back to browser otherwise. The CLI writes the same session metadata/logs as API runs, but the payload is pasted into ChatGPT via a temporary Chrome profile.

`--preview` now works with `--engine browser`: it renders the composed prompt, lists which files would be uploaded vs inlined, and shows the bundle location when bundling is enabled, without launching Chrome.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. Browser mode pastes the system + user text (no special markers) into the ChatGPT composer and then uploads each resolved `--file` individually (via the hidden `<input type="file">`) before submitting the prompt.
2. **Automation stack** – code lives in `src/browserMode.ts` and is a lightly refactored version of the `oraclecheap` utility:
   - Launches Chrome via `chrome-launcher` and connects with `chrome-remote-interface`.
   - (Optional) copies cookies from the requested macOS Chrome profile via `chrome-cookies-secure` so users stay signed in.
   - Navigates to `chatgpt.com`, switches the model (currently just label-matching for GPT-5.1/GPT-5 Pro), pastes the prompt, waits for completion, and copies the markdown via the built-in “copy turn” button.
   - When files are queued, we upload them one-by-one via the hidden `<input type="file">` and wait for ChatGPT to re-enable the send button before submitting the combined system+user prompt.
   - Cleans up the temporary profile unless `--browser-keep-browser` is passed.
3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and log the Chrome PID/port so `oracle session <id>` (or `oracle status <id>`) shows a marker for the background Chrome process.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--engine browser`: enables browser mode (legacy `--browser` remains as an alias for now). Without `--engine`, Oracle chooses API when `OPENAI_API_KEY` exists, otherwise browser.
- `--browser-chrome-profile`, `--browser-chrome-path`: cookie source + binary override (defaults to the standard `"Default"` Chrome profile so existing ChatGPT logins carry over).
- `--browser-timeout`, `--browser-input-timeout`: `900s`/`30s` defaults using `ms|s|m` syntax.
- `--browser-no-cookie-sync`, `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and the global `-v/--verbose` flag for detailed automation logs.
- `--browser-url`: override ChatGPT base URL if needed.
- `--browser-inline-files`: paste resolved files directly into the composer instead of uploading them (debug fallback; useful when the attachment button is broken).
- `--browser-bundle-files`: bundle all resolved attachments into a single temp file before uploading (useful when you want one upload even with many files).
- sqlite bindings: automatic rebuilds now require `ORACLE_ALLOW_SQLITE_REBUILD=1`. Without it, the CLI logs instructions instead of running `pnpm rebuild` on your behalf.
- `--model`: the same flag used for API runs controls the ChatGPT picker. Pass descriptive labels such as `--model "ChatGPT 5.1 Instant"` when you want a specific browser variant; canonical API names (`gpt-5-pro`, `gpt-5.1`) still work and map to their default picker labels.
- Cookie sync is mandatory—if we can’t copy cookies from Chrome, the run exits early. Use the hidden `--browser-allow-cookie-errors` flag only when you’re intentionally running logged out (it skips the early exit but still warns).

All options are persisted with the session so reruns (`oracle exec <id>`) reuse the same automation settings.

## Limitations / Follow-Up Plan

- **Attachment lifecycle** – every `--file` path is uploaded separately so ChatGPT can ingest the original filenames/content. The automation waits for the uploads to finish (send button enabled, no upload indicators) before hitting submit. Follow-up work: expose upload status in session logs. When upload automation flakes, use `--browser-inline-files` to fall back to pasting file contents directly.
- **Model picker drift** – we currently rely on heuristics to pick GPT-5.1/GPT-5 Pro. If OpenAI changes the DOM we need to refresh the selectors quickly. Consider snapshot tests or a small “self check” command.
- **Non-mac platforms** – window hiding uses AppleScript today; Linux/Windows just ignore the flag. We should detect platforms explicitly and document the behavior.
- **Streaming UX** – browser runs cannot stream tokens, so we log a warning before launching Chrome. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- `pnpm test --filter browser` does not exist yet; manual runs with `--engine browser -v` are the current validation path.
- Most of the heavy lifting lives in `src/browserMode.ts`. If you change selectors or the mutation observer logic, run a local `oracle --engine browser --browser-keep-browser` session so you can inspect DevTools before cleanup.
