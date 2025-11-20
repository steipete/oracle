# Gemini 3 Pro Integration

This document outlines the integration of Google's Gemini 3 Pro model into the `oracle` CLI.

## Usage

To use Gemini 3 Pro, you must provide a Google AI API key.

1.  **Get an API Key:** Obtain a key from [Google AI Studio](https://aistudio.google.com/).
2.  **Set Environment Variable:** Export the key as `GEMINI_API_KEY`.
    ```bash
    export GEMINI_API_KEY="your-google-api-key"
    ```
3.  **Run Oracle:** Use the `--model` (or `-m`) flag to select Gemini.
    ```bash
    oracle --model gemini --prompt "Explain quantum entanglement"
    ```
    You can also use the explicit model ID:
    ```bash
    oracle --model gemini-3-pro --prompt "..."
    ```

## Implementation Details

The integration uses an **Adapter Pattern** to fit the Google Generative AI SDK into the existing `oracle` architecture, which was originally designed around the OpenAI API structure.

### Key Components

*   **`src/oracle/gemini.ts`**: This is the core adapter. It exports `createGeminiClient(apiKey)`, which returns an object satisfying the `ClientLike` interface used throughout the application.
    *   **Request Mapping**: Converts `OracleRequestBody` (system prompt, user messages) into Gemini's `GenerateContentRequest`. It maps the `web_search_preview` tool to Gemini's `googleSearch` tool.
    *   **Response Mapping**: Converts Gemini's `GenerateContentResponse` (both streaming and complete) back into the `OracleResponse` format expected by the CLI.
    *   **Streaming**: Wraps Gemini's async generator to match the `ResponseStreamLike` interface.

*   **`src/oracle/client.ts`**: The `createDefaultClientFactory` was updated to inspect the `model` parameter. If `gemini-3-pro` is requested, it instantiates the Gemini client instead of the OpenAI client.

*   **`src/oracle/run.ts`**: Logic was added to select the correct API key (`GEMINI_API_KEY` vs `OPENAI_API_KEY`) based on the requested model prefix. Log messages were generalized from "OpenAI" to "API".

### Configuration

*   **`src/oracle/config.ts`**: Added `gemini-3-pro` to `MODEL_CONFIGS` with a 200k token input limit and current preview pricing ($2/1M input, $12/1M output).
*   **`src/oracle/types.ts`**: Updated `ModelName` type to include `gemini-3-pro`.

## Development Notes

*   **Types**: We strictly use types from `@google/generative-ai` (e.g., `GenerateContentResponse`, `Tool`) to ensure type safety within the adapter.
*   **Tokenizer**: Currently, the project reuses the `gpt-5.1-pro` tokenizer for estimation. While not exact for Gemini, it provides a safe upper bound for token budgeting.
*   **Search**: The integration supports Gemini's native Google Search tool.
*   **Retrieval**: The `retrieve` method (fetching a past response by ID) is not supported by the Gemini API in the same way as OpenAI, so it currently returns a placeholder error.