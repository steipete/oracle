# OpenAI-Compatible Endpoints

Oracle uses the official OpenAI Node.js SDK, which allows it to connect to any API that adheres to the OpenAI API specification. This includes:

- Official OpenAI API
- Azure OpenAI Service
- Local inference servers (e.g., vLLM, Ollama)
- Proxy servers (e.g., LiteLLM)

## Azure OpenAI

To use Azure OpenAI, you need to configure the client to use the Azure-specific implementation. The easiest way is to set the following environment variables:

```bash
export AZURE_OPENAI_ENDPOINT="https://your-resource-name.openai.azure.com/"
export AZURE_OPENAI_API_KEY="your-azure-api-key"
export AZURE_OPENAI_API_VERSION="2024-02-15-preview"
```

When `AZURE_OPENAI_ENDPOINT` is detected, Oracle automatically switches to the Azure client.

### CLI Configuration

You can also pass these values via CLI flags (though environment variables are recommended for keys):

```bash
oracle --azure-endpoint https://... --azure-deployment my-deployment-name
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
