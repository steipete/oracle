# Gemini Integration

Oracle supports Gemini in three distinct ways:

1. **Gemini API mode** (`--engine api`) via `GEMINI_API_KEY`
2. **Gemini web (cookie) mode** (`--engine browser`) via HTTP requests using your Chrome cookies (fast, lightweight)
3. **Gemini browser automation mode** (`--engine browser --model gemini-deep-think`) for Deep Think via full browser automation at `gemini.google.com/app`

## Usage (API)

1. **Get an API Key:** Obtain a key from [Google AI Studio](https://aistudio.google.com/).
2. **Set Environment Variable:** Export the key as `GEMINI_API_KEY`.
   ```bash
   export GEMINI_API_KEY="your-google-api-key"
   ```
3. **Run Oracle:** Use the `--model` (or `-m`) flag to select Gemini.
   ```bash
   oracle --engine api --model gemini --prompt "Explain quantum entanglement"
   ```
   You can also use the explicit model ID:
   ```bash
   oracle --engine api --model gemini-3-pro --prompt "..."
   ```

## Usage (Gemini web / cookies)

Gemini web mode is a cookie-based client for `gemini.google.com`. It does **not** use `GEMINI_API_KEY` and does **not** drive ChatGPT.

Prereqs:
- Chrome installed.
- Signed into `gemini.google.com` in the Chrome profile Oracle uses (default: `Default` profile).

Examples:
```bash
# Text run
oracle --engine browser --model gemini-3-pro --prompt "Say OK."

# Generate an image (writes an output file)
oracle --engine browser --model gemini-3-pro \
  --prompt "a cute robot holding a banana" \
  --generate-image out.jpg --aspect 1:1

# Edit an image (input via --edit-image, output via --output)
oracle --engine browser --model gemini-3-pro \
  --prompt "add sunglasses" \
  --edit-image in.png --output out.jpg
```

Notes:
- If your logged-in Gemini account can't access "Pro", Oracle will auto-fallback to a supported model for web runs (and logs the fallback in verbose mode).
- This path runs fully in Node/TypeScript (no Python/venv dependency).
- `--browser-model-strategy` only affects ChatGPT automation; Gemini web always uses the explicit Gemini model ID.

## Usage (Gemini Deep Think / Browser Automation)

For Gemini Deep Think and Deep Research modes, Oracle provides full browser automation similar to ChatGPT browser mode. This drives a real Chrome browser at `gemini.google.com/app`.

Prereqs:
- Chrome installed.
- Signed into `gemini.google.com` in Chrome (you'll be prompted if not logged in).

Examples:
```bash
# Basic Deep Think query (can take several minutes for complex questions)
oracle --engine browser --model gemini-deep-think --prompt "Analyze the trade-offs of microservices vs monolithic architecture"

# Deep Research mode
oracle --engine browser --model gemini-deep-research --prompt "Research the current state of quantum computing"

# Use the Thinking model (faster than Deep Think, still has reasoning)
oracle --engine browser --model gemini-3-thinking --prompt "Solve this step by step"

# Use the Fast model (quickest responses)
oracle --engine browser --model gemini-3-fast --prompt "Hello world"

# Manual login mode (first-time setup)
oracle --engine browser --model gemini-deep-think --browser-manual-login --prompt "Test query"
```

### Gemini UI Structure

The Gemini web UI (`gemini.google.com/app`) has two separate selection mechanisms:

1. **Model Picker** (Fast/Thinking/Pro dropdown):
   - `gemini-3-fast` → Fast mode (gemini-flash-3-fast) - quickest responses
   - `gemini-3-thinking` → Thinking mode (gemini-flash-3-thinking) - balanced
   - `gemini-3-pro` → Pro mode (gemini-3-pro-preview) - most capable

2. **Tools Drawer** (accessed via "Tools" button):
   - `Deep Research` - Extended research capabilities
   - `Create videos (Veo 3.1)` - Video generation
   - `Create images` - Image generation
   - `Canvas` - Document editing
   - `Guided Learning` - Educational mode
   - `Deep Think` - Advanced reasoning (experimental)

When you request `gemini-deep-think`, Oracle:
1. Selects "Thinking" from the model picker
2. Opens the Tools drawer
3. Activates "Deep Think" from the tools

### Supported Models

Browser automation models:
- `gemini-3-fast` - Fast mode (Gemini Flash 3)
- `gemini-3-thinking` - Thinking mode (Gemini Flash 3 with reasoning)
- `gemini-3-pro` - Pro mode (Gemini 3 Pro Preview)
- `gemini-deep-think` - Deep Think tool (experimental advanced reasoning)
- `gemini-deep-research` - Deep Research tool

Options:
- `--browser-manual-login` - Keep browser visible for manual Google sign-in
- `--browser-keep-browser` - Don't close browser after completion
- `--browser-timeout <seconds>` - Override response timeout (default: 300s, Deep Think: 600s)
- `--show-thinking` - Include thinking/reasoning process in output

Notes:
- Browser automation uses Chrome DevTools Protocol (CDP), same as ChatGPT mode.
- Deep Think runs can take 5-10+ minutes for complex queries - this is normal.
- The browser automation mode uses a separate debug port (9223) from ChatGPT (9222) to allow both to run simultaneously.

## Implementation details

### Gemini API adapter

- `src/oracle/gemini.ts` — adapter using `@google/genai` that returns a `ClientLike`.
  - Model IDs: `gemini-3-pro` maps to the provider ID (currently `gemini-3-pro-preview`).
  - Request mapping: `OracleRequestBody` → Gemini request; `web_search_preview` maps to Gemini search tooling.
  - Response mapping: Gemini responses → `OracleResponse`.
  - Streaming: wraps Gemini’s async iterator as `ResponseStreamLike`.
- `src/oracle/run.ts` — selects `GEMINI_API_KEY` vs `OPENAI_API_KEY` based on model prefix.
- `src/oracle/config.ts` / `src/oracle/types.ts` — model config + `ModelName`.

### Gemini web client (cookie-based)

- `src/gemini-web/client.ts` — talks to `gemini.google.com` and downloads generated images via authenticated `gg-dl` redirects.
- `src/gemini-web/executor.ts` — browser-engine executor for Gemini (loads Chrome cookies and runs the web client).

### Gemini browser automation (Deep Think)

- `src/gemini-browser/index.ts` — main entry point for Gemini browser automation mode.
- `src/gemini-browser/constants.ts` — Gemini-specific selectors, URLs, model definitions, and tool configs.
- `src/gemini-browser/types.ts` — TypeScript types for Gemini browser automation.
- `src/gemini-browser/actions/navigation.ts` — navigation, consent handling, and login detection.
- `src/gemini-browser/actions/modelSelection.ts` — model picker automation (Fast/Thinking/Pro).
- `src/gemini-browser/actions/toolsSelection.ts` — Tools drawer automation (Deep Think, Create images, etc.).
- `src/gemini-browser/actions/promptComposer.ts` — prompt input and submission.
- `src/gemini-browser/actions/assistantResponse.ts` — response capture and thinking status detection.

The browser automation module:
1. Launches Chrome using the shared `chromeLifecycle.ts` module
2. Syncs Google cookies from Chrome profile via `cookies.ts`
3. Navigates to `gemini.google.com/app` and handles consent/login
4. Selects the desired model from the picker (Fast/Thinking/Pro)
5. If Deep Think requested: opens Tools drawer and activates Deep Think tool
6. Submits the prompt and monitors response/thinking progress
7. Captures the response text and optional thinking/reasoning content

## Testing

- Unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`
- Live (API): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-live.test.ts`
- Live (Gemini web/cookies): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts`
