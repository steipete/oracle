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
- Browser mode can use an existing Chrome session at `grok.com` without an API key:

  ```bash
  oracle --engine browser --model grok --remote-chrome 127.0.0.1:9222 -p "Review this plan"
  ```

  Grok web mode supports text prompts, file attachments, and browser follow-ups. It opens an
  isolated Grok tab instead of reusing the active tab. Use `--browser-attachments always` to force
  text files through Grok's upload control instead of Oracle's normal small-file inline mode. Grok
  web mode currently supports local `--remote-chrome` / `--browser-attach-running` sessions, not
  `oracle serve --remote-host`.
