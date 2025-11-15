# Browser Mode

`oracle --browser` routes the assembled prompt bundle through the ChatGPT web UI instead of the Responses API. The CLI writes the same session metadata/logs as API runs, but the payload is pasted into ChatGPT via a temporary Chrome profile.

## Current Pipeline

1. **Prompt assembly** – we reuse the normal prompt builder (`buildPrompt`) and the markdown renderer. For now we paste the entire `[SYSTEM]/[USER]/[FILE]` bundle into the ChatGPT composer because the attachment workflow is not implemented yet.
2. **Automation stack** – code lives in `src/browserMode.ts` and is a lightly refactored version of the `oraclecheap` utility:
   - Launches Chrome via `chrome-launcher` and connects with `chrome-remote-interface`.
   - (Optional) copies cookies from the requested macOS Chrome profile via `chrome-cookies-secure` so users stay signed in.
   - Navigates to `chatgpt.com`, switches the model (currently just label-matching for GPT-5.1/GPT-5 Pro), pastes the prompt, waits for completion, and copies the markdown via the built-in “copy turn” button.
   - Cleans up the temporary profile unless `--browser-keep-browser` is passed.
3. **Session integration** – browser sessions use the normal log writer, add `mode: "browser"` plus `browser.config/runtime` metadata, and log the Chrome PID/port so `oracle session <id>` shows a marker for the background Chrome process.
4. **Usage accounting** – we estimate input tokens with the same tokenizer used for API runs and estimate output tokens via `estimateTokenCount`. `oracle status` therefore shows comparable cost/timing info even though the call ran through the browser.

### CLI Options

- `--browser`: enables browser mode.
- `--browser-chrome-profile`, `--browser-chrome-path`: cookie source + binary override.
- `--browser-timeout`, `--browser-input-timeout`: `900s`/`30s` defaults using `ms|s|m` syntax.
- `--browser-no-cookie-sync`, `--browser-headless`, `--browser-hide-window`, `--browser-keep-browser`, and the global `-v/--verbose` flag for detailed automation logs.
- `--browser-url`: override ChatGPT base URL if needed.

All options are persisted with the session so reruns (`oracle exec <id>`) reuse the same automation settings.

## Limitations / Follow-Up Plan

- **File upload parity** – today we simply paste file contents into the composer. The next step is to read the resolved file list, upload each via the ChatGPT attachment picker, and only paste the system+user prompts. Implementation sketch:
  1. Extend `BrowserPromptArtifacts` to keep both the textual bundle and an array of `{displayPath, absolutePath}` attachments.
  2. Automate the upload button using DevTools `DOM.performSearch` to locate `<input type="file">` or the new drag target, then use `Input.dispatchDragEvent` to attach each file.
  3. The existing markdown fallback should only include `[SYSTEM]/[USER]` once file uploads succeed; keep a `--browser-inline-files` escape hatch for debugging.
  4. Update docs/session metadata to record which files were uploaded vs pasted.
- **Model picker drift** – we currently rely on heuristics to pick GPT-5.1/GPT-5 Pro. If OpenAI changes the DOM we need to refresh the selectors quickly. Consider snapshot tests or a small “self check” command.
- **Non-mac platforms** – window hiding uses AppleScript today; Linux/Windows just ignore the flag. We should detect platforms explicitly and document the behavior.
- **Streaming UX** – browser runs cannot stream tokens, so we log a warning before launching Chrome. Investigate whether we can stream clipboard deltas via mutation observers for a closer UX.

## Testing Notes

- `pnpm test --filter browser` does not exist yet; manual runs with `--browser -v` are the current validation path.
- Most of the heavy lifting lives in `src/browserMode.ts`. If you change selectors or the mutation observer logic, run a local `oracle --browser --browser-keep-browser` session so you can inspect DevTools before cleanup.
