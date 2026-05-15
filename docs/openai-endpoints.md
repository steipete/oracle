# OpenAI-Compatible Endpoints

Oracle uses the official OpenAI Node.js SDK, which allows it to connect to any API that adheres to the OpenAI API specification. This includes:

- Official OpenAI API
- Azure OpenAI Service
- Local inference servers (e.g., vLLM, Ollama)
- Proxy servers (e.g., LiteLLM)

## Azure OpenAI

Oracle uses Azure's v1 Responses endpoint when `--azure-endpoint` (or `azure.endpoint`) is set.
Pass your resource endpoint, Azure key, and deployment name:

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource-name.openai.azure.com/"
export AZURE_OPENAI_API_KEY="your-azure-api-key"
export AZURE_OPENAI_DEPLOYMENT="gpt-5-1-pro"
```

Key lookup for GPT-family models when an Azure endpoint is set:

- First looks for `AZURE_OPENAI_API_KEY`.
- Falls back to `OPENAI_API_KEY` if the Azure key is missing.

Without an Azure endpoint, Oracle keeps using `OPENAI_API_KEY` as before.
If Azure env/config is present but you want first-party OpenAI for one run, pass `--provider openai` or `--no-azure`.

Notes:

- Oracle calls Azure at `https://<resource>.openai.azure.com/openai/v1`.
- For Responses API runs, Azure expects `model` to be your deployment name. Oracle fails early when an Azure endpoint is active without a deployment, except for `gpt-5.5-pro` where the CLI model id is used as the implicit deployment.
- API runs print the selected route without secrets, for example `Provider: Azure OpenAI | endpoint: your-resource.openai.azure.com | deployment: my-deployment | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY`.
- `AZURE_OPENAI_API_VERSION` is still accepted for back-compat, but Azure's v1 Responses endpoint does not require it.

## Provider diagnostics

Check provider readiness before an API run:

```bash
oracle doctor --providers --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro
oracle --preflight --models gpt-5.4,gemini-3-pro
oracle --route --model gpt-5.4
```

The output is redacted and local: provider, base host, key source, Azure status, and missing-route errors. These commands exit before sending a prompt or creating a session.

When Azure env/config is present, GPT-family API models route through Azure unless you force first-party OpenAI:

```bash
oracle --provider openai --route --model gpt-5.4
oracle --no-azure --route --model gpt-5.4
```

### CLI Configuration

You can also pass the Azure settings via CLI flags (env for the key is still recommended):

```bash
oracle --azure-endpoint https://... --azure-deployment my-deployment-name
```

Force first-party OpenAI when Azure env vars are exported:

```bash
oracle --provider openai --engine api --model gpt-5.5-pro -p "Review this"
oracle --no-azure --engine api --model gpt-5.5-pro -p "Review this"
```

## Custom Base URLs (LiteLLM, Localhost)

For other compatible services that use the standard OpenAI protocol but a different URL:

```bash
oracle --base-url http://localhost:4000
```

Or via `config.json`:

```json
{
  "apiBaseUrl": "http://localhost:4000"
}
```

## Model aliases

Oracle keeps a stable CLI-facing model set, but some names are aliases for the concrete API model ids it sends:

- `gpt-5.1-pro`, `gpt-5.2-pro` → `gpt-5.5-pro` (API)

Notes:

- `gpt-5.1-pro` and `gpt-5.2-pro` are **CLI aliases** for “the current Pro API model” — OpenAI’s API uses `gpt-5.5-pro`.
- If you want the classic Pro tier explicitly, use `gpt-5-pro`.

### Browser engine vs API base URLs

`--base-url` / `apiBaseUrl` only affect API runs. For browser automation, use `--chatgpt-url` (or `browser.chatgptUrl` in config) to point Chrome at a specific ChatGPT workspace/folder such as `https://chatgpt.com/g/.../project`.

### Example: LiteLLM

[LiteLLM](https://docs.litellm.ai/) allows you to use Azure, Anthropic, VertexAI, and more using the OpenAI format.

1. Start LiteLLM:
   ```bash
   litellm --model azure/gpt-4-turbo
   ```
2. Connect Oracle:
   ```bash
   oracle --base-url http://localhost:4000
   ```

## OpenRouter

Oracle can also talk to OpenRouter (Responses API compatible) with any model id:

```bash
export OPENROUTER_API_KEY="sk-or-..."
oracle --model minimax/minimax-m2 --prompt "Summarize the notes"
```

- If `OPENROUTER_API_KEY` is set and no provider-specific key is available for the chosen model, Oracle defaults the base URL to `https://openrouter.ai/api/v1`.
- You can still set `--base-url` explicitly; if it points at OpenRouter (with or without a trailing `/responses`), Oracle will use `OPENROUTER_API_KEY` and forward optional attribution headers (`OPENROUTER_REFERER` / `OPENROUTER_TITLE`).
- Multi-model runs accept OpenRouter ids alongside built-in ones. See `docs/openrouter.md` for details.
