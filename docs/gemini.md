# Gemini Integration

Oracle supports Gemini in two distinct ways:

1. **Gemini API mode** (`--engine api`) via `GEMINI_API_KEY`
2. **Gemini web (cookie) mode** (`--engine browser`) via your signed-in Chrome cookies at `gemini.google.com` (no API key required)

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
- If your logged-in Gemini account can’t access “Pro”, Oracle will auto-fallback to a supported model for web runs (and logs the fallback in verbose mode).
- This path runs fully in Node/TypeScript (no Python/venv dependency).
- `--browser-model-strategy` only affects ChatGPT automation; Gemini web always uses the explicit Gemini model ID.

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

## Testing

- Unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`
- Live (API): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-live.test.ts`
- Live (Gemini web/cookies): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts`
