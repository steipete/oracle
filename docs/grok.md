# Grok 4.1 (xAI) Support

Status: **experimental** (November 21, 2025)  
Owner: Oracle CLI

- Model key: `grok-4.1` (mapped to API id `grok-4-1-fast-reasoning`). Alias: `grok`.
- Endpoint: defaults to `https://api.x.ai/v1` or `XAI_BASE_URL`. Uses the OpenAI **Responses API** surface.
- Auth: `XAI_API_KEY`.
- Background runs: **not supported** by the Grok API (requests with `background: true` are rejected). Oracle forces foreground streaming even if `--background` is set.
- Search tools: Grok expects `web_search`; OpenAI’s `web_search_preview` is not accepted.
- Pricing (preview): $0.20 / 1M input tokens, $0.50 / 1M output tokens; 2M token context.

Notes:
- If you supply `--base-url`, it overrides the default xAI endpoint.
- Browser engine is supported for Grok via `--grok-url https://grok.com` (automation via Chrome). Use `--browser-model-strategy ignore` to skip the ChatGPT picker logic.
- Grok browser mode auto-enables hard mode when `DeepSearch` / `Think Harder` is available.
- Grok browser mode currently does not upload file attachments.
