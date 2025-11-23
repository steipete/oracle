# OpenRouter

Oracle can target any OpenAI-compatible model on OpenRouter with minimal setup.

## Setup

```bash
export OPENROUTER_API_KEY="sk-or-..."
# Optional but recommended for attribution:
export OPENROUTER_REFERER="https://your-app.example"
export OPENROUTER_TITLE="Oracle CLI"
```

- If you set `OPENROUTER_API_KEY` and don’t provide another provider key, Oracle automatically routes API runs to `https://openrouter.ai/api/v1`.
- You can still point explicitly with `--base-url https://openrouter.ai/api/v1` (Oracle will trim a trailing `/responses` if you include it).
- First‑party keys win: if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY` is present, Oracle will prefer those providers unless you set an OpenRouter base URL.

## Models

- `--model` accepts any OpenRouter model id, e.g. `minimax/minimax-m2`, `z-ai/glm-4.6`, `openai/gpt-4o-mini`.
- `--models` can mix first‑party and OpenRouter ids:  
  `oracle --engine api --models "gpt-5-pro,minimax/minimax-m2,z-ai/glm-4.6,claude-4.5-sonnet" -p "Summarize..."`.
- For built-in models (`gpt-5.1-pro`, `claude-4.5-sonnet`, `gemini-3-pro`), Oracle falls back to OpenRouter automatically when the provider key is missing but `OPENROUTER_API_KEY` is set. It keeps using first‑party endpoints when their keys are present.

## Headers

When hitting OpenRouter, Oracle forwards optional attribution headers:
- `HTTP-Referer` from `OPENROUTER_REFERER` (or `OPENROUTER_HTTP_REFERER`)
- `X-Title` from `OPENROUTER_TITLE`

## Sessions and logs

- Model ids that contain `/` are stored with a safe slug (`/` → `__`) for per-model log filenames, but the original id remains visible in session metadata and CLI output.

## Tips

- If a model id isn’t found in the OpenRouter catalog, Oracle still sends the request with the id you provided.
- Pricing/context limits are pulled from the `/api/v1/models` catalog when available; otherwise, Oracle uses conservative defaults (200k tokens, cost unknown).
