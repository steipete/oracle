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
   Use an explicit current model ID:
   ```bash
   oracle --engine api --model gemini-3.5-flash --prompt "..."
   ```
   Gemini 3.1 Pro is also available; Oracle dispatches it to Google's preview model id:
   ```bash
   oracle --engine api --model gemini-3.1-pro --prompt "..."
   ```
   For the lowest-cost current model:
   ```bash
   oracle --engine api --model gemini-3.1-flash-lite --prompt "..."
   ```

## Usage (Gemini web / cookies)

Gemini web mode is a cookie-based client for `gemini.google.com`. It does **not** use `GEMINI_API_KEY` and does **not** drive ChatGPT.

Prereqs:

- Chrome installed.
- Signed into `gemini.google.com` in the Chrome profile Oracle uses (default: `Default` profile).

Examples:

```bash
# Text run
oracle --engine browser --model gemini-3.5-flash --prompt "Say OK."

# Deep Think browser run (manual-login profile recommended on macOS)
oracle --engine browser --browser-manual-login \
  --model gemini-3-deep-think \
  --prompt "Think carefully, then answer in one paragraph."

# Generate an image (writes an output file)
oracle --engine browser --model gemini-3.1-pro \
  --prompt "a cute robot holding a banana" \
  --generate-image out.jpg --aspect 1:1

# Edit an image (input via --edit-image, output via --output)
oracle --engine browser --model gemini-3.1-pro \
  --prompt "add sunglasses" \
  --edit-image in.png --output out.jpg
```

Notes:

- Current explicit IDs are `gemini-3.1-flash-lite`, `gemini-3.5-flash`, and `gemini-3.1-pro`.
- Legacy `gemini-3-pro`, `gemini-2.5-pro`, and `gemini-2.5-flash` browser names remain accepted and map to current Gemini web models.
- If your logged-in Gemini account can’t access the requested model, Oracle auto-falls back to Gemini 3.1 Flash-Lite and logs the fallback in verbose mode.
- Pass `--no-gemini-fallback` to fail instead when the requested web model is unavailable.
- This path runs fully in Node/TypeScript (no Python/venv dependency).
- `--browser-model-strategy` only affects ChatGPT automation; Gemini web always uses the explicit Gemini model ID.
- `gemini-3-deep-think` is browser-only for now. `--engine api` rejects it instead of silently falling back to regular Gemini Pro.
- Oracle intentionally does not expose generic `low` / `medium` / `high` Gemini aliases. Explicit IDs keep model choice, billing, and thinking-effort configuration distinct.
- If Chrome cookie extraction fails, the missing-cookie error now includes any cookie-reader warnings plus `--browser-manual-login` / `--browser-inline-cookies-file` guidance.

## Implementation details

### Gemini API adapter

- `src/oracle/gemini.ts` — adapter using `@google/genai` that returns a `ClientLike`.
  - Model IDs: `gemini-3.1-flash-lite` and `gemini-3.5-flash` use their stable API IDs; `gemini-3.1-pro` maps to `gemini-3.1-pro-preview`; legacy `gemini-3-pro` maps to `gemini-3-pro-preview`.
  - Request mapping: `OracleRequestBody` → Gemini request; `web_search_preview` maps to Gemini search tooling.
  - Response mapping: Gemini responses → `OracleResponse`.
  - Streaming: wraps Gemini’s async iterator as `ResponseStreamLike`.
- `src/oracle/run.ts` — selects `GEMINI_API_KEY` vs `OPENAI_API_KEY` based on model prefix.
- `src/oracle/config.ts` / `src/oracle/types.ts` — model config + `ModelName`.

### Gemini web client (cookie-based)

- `src/gemini-web/models.ts` — centralizes current private web model headers, legacy aliases, and fallback selection.
- `src/gemini-web/client.ts` — talks to `gemini.google.com` and downloads generated images via authenticated `gg-dl` redirects.
- `src/gemini-web/executor.ts` — browser-engine executor for Gemini (loads Chrome cookies and runs the web client).

## Testing

- Unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web`
- Live (API): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-live.test.ts`
- Live (Gemini web/cookies): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts`
