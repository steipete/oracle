# Requesty

Oracle can target any OpenAI-compatible model on [Requesty](https://requesty.ai) with minimal setup. Requesty uses the same `provider/model` id convention as OpenRouter, so wiring is nearly identical.

## Setup

```bash
export REQUESTY_API_KEY="rqsty-sk-..."
# Optional but recommended for attribution:
export REQUESTY_REFERER="https://your-app.example"
export REQUESTY_TITLE="Oracle CLI"
```

- If you set `REQUESTY_API_KEY` and don’t provide another provider key, Oracle automatically routes API runs to `https://router.requesty.ai/v1`.
- You can still point explicitly with `--base-url https://router.requesty.ai/v1` (EU: `https://router.eu.requesty.ai/v1`).
- First‑party keys win: if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY` is present, Oracle will prefer those providers unless you set a Requesty base URL.
- `OPENROUTER_API_KEY` keeps precedence over `REQUESTY_API_KEY` for the automatic gateway fallback, so existing OpenRouter setups are unchanged. Requesty takes over the fallback only when `OPENROUTER_API_KEY` is absent but `REQUESTY_API_KEY` is present.

## Models

- `--model` accepts any Requesty model id, e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4-5`, `deepseek/deepseek-chat`.
- `--models` can mix first‑party and Requesty ids:  
  `oracle --engine api --models "gpt-5-pro,openai/gpt-4o-mini,anthropic/claude-sonnet-4-5" -p "Summarize..."`.

## Headers

When hitting Requesty, Oracle forwards optional attribution headers (same header names as OpenRouter):

- `HTTP-Referer` from `REQUESTY_REFERER` (or `REQUESTY_HTTP_REFERER`)
- `X-Title` from `REQUESTY_TITLE`

## Sessions and logs

- Model ids that contain `/` are stored with a safe slug (`/` → `__`) for per-model log filenames, but the original id remains visible in session metadata and CLI output.

## Tips

- If a model id isn’t found in the Requesty catalog, Oracle still sends the request with the id you provided.
- Pricing/context limits are pulled from the `/v1/models` catalog when available. Requesty reports context length as `context_window` and prices as flat per-token USD, which Oracle maps to its internal shape; otherwise, Oracle uses conservative defaults.

## Get a key

Create a key at [app.requesty.ai/api-keys](https://app.requesty.ai/api-keys) and browse available models at [app.requesty.ai/router/list](https://app.requesty.ai/router/list). See the [docs](https://docs.requesty.ai) for more.
