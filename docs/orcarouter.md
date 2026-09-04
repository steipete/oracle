# OrcaRouter

Oracle can target any OpenAI-compatible model on OrcaRouter with minimal setup.

## Setup

```bash
export ORCAROUTER_API_KEY="sk-orca-..."
# Optional but recommended for attribution:
export ORCAROUTER_REFERER="https://your-app.example"
export ORCAROUTER_TITLE="Oracle CLI"
```

- If you set `ORCAROUTER_API_KEY` and don’t provide another provider key, Oracle automatically routes API runs to `https://api.orcarouter.ai/v1`.
- You can still point explicitly with `--base-url https://api.orcarouter.ai/v1` (Oracle will trim a trailing `/responses` if you include it).
- First-party keys win: if `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `XAI_API_KEY` is present, Oracle will prefer those providers unless you set an OrcaRouter base URL.

## Models

- `--model` accepts any OrcaRouter model id, e.g. `orcarouter/auto`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5`.
- `--models` can mix first-party and OrcaRouter ids:
  `oracle --engine api --models "gpt-5-pro,orcarouter/auto,anthropic/claude-sonnet-5" -p "Summarize..."`.
- `orcarouter/auto` is OrcaRouter's adaptive routing model — it selects the best upstream per request based on your routing config at https://www.orcarouter.ai/console/routing. The full catalog is at https://www.orcarouter.ai/models.

## Headers

When hitting OrcaRouter, Oracle forwards optional attribution headers:

- `HTTP-Referer` from `ORCAROUTER_REFERER` (or `ORCAROUTER_HTTP_REFERER`)
- `X-Title` from `ORCAROUTER_TITLE`

## Sessions and logs

- Model ids that contain `/` are stored with a safe slug (`/` → `__`) for per-model log filenames, but the original id remains visible in session metadata and CLI output.

## Tips

- If a model id isn’t found in the OrcaRouter catalog, Oracle still sends the request with the id you provided.
- Pricing/context limits are pulled from the `/api/pricing` catalog when available; otherwise, Oracle uses conservative defaults (200k tokens, cost unknown).
- `orcarouter/auto` routes to whatever upstream OrcaRouter picks, so context limits and pricing are best-effort until the route resolves.
