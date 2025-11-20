import { GoogleGenAI, HarmCategory, HarmBlockThreshold, type Tool, type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata } from '@google/genai';
import type { ClientLike, ModelName, OracleRequestBody, OracleResponse, ResponseStreamLike, ResponseOutputItem } from './types.js';

const MODEL_ID_MAP: Record<ModelName, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gpt-5.1-pro': 'gpt-5.1-pro', // unused, normalize TS map
  'gpt-5-pro': 'gpt-5-pro',
  'gpt-5.1': 'gpt-5.1',
  'gpt-5.1-codex': 'gpt-5.1-codex',
  'claude-4.5-sonnet': 'claude-4.5-sonnet',
  'claude-4.1-opus': 'claude-4.1-opus',
};

export function resolveGeminiModelId(modelName: ModelName): string {
  // Map our logical Gemini names to the exact model ids expected by the SDK.
  return MODEL_ID_MAP[modelName] ?? modelName;
}

export function createGeminiClient(
  apiKey: string,
  modelName: ModelName = 'gemini-3-pro',
  resolvedModelId?: string,
): ClientLike {
  const modelId = resolvedModelId ?? resolveGeminiModelId(modelName);
  const genAI = new GoogleGenAI({ apiKey });

  const adaptBodyToGemini = (body: OracleRequestBody) => {
    const contents = body.input.map((inputItem) => ({
      role: inputItem.role === 'user' ? 'user' : 'model',
      parts: inputItem.content
        .map((contentPart) => {
          if (contentPart.type === 'input_text') {
            return { text: contentPart.text };
          }
          return null;
        })
        .filter((part) => part !== null),
    }));

    const tools = body.tools
      ?.map((tool) => {
        if (tool.type === 'web_search_preview') {
          return {
            googleSearch: {},
          };
        }
        return {};
      })
      .filter((t) => Object.keys(t).length > 0) as Tool[] | undefined;

    const safetySettings = [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ];

    const systemInstruction = body.instructions
      ? { role: 'system', parts: [{ text: body.instructions }] }
      : undefined;

    return {
      model: modelId,
      contents,
      config: {
        maxOutputTokens: body.max_output_tokens,
        safetySettings,
        tools,
        systemInstruction,
      },
    };
  };

  const adaptGeminiResponseToOracle = (geminiResponse: GenerateContentResponse): OracleResponse => {
    const outputText: string[] = [];
    const output: ResponseOutputItem[] = [];
    geminiResponse.candidates?.forEach((candidate) => {
      candidate.content?.parts?.forEach((part) => {
        if (part.text) {
          outputText.push(part.text);
          output.push({ type: 'text', text: part.text });
        }
      });
    });

    const usage = {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: (geminiResponse.usageMetadata?.promptTokenCount || 0) + (geminiResponse.usageMetadata?.candidatesTokenCount || 0),
    };

    return {
      id: geminiResponse.responseId ?? `gemini-${Date.now()}`,
      status: 'completed',
      output_text: outputText,
      output,
      usage,
    };
  };

  const adaptAggregatedTextToOracle = (
    text: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseId?: string,
  ): OracleResponse => {
    const usage = {
      input_tokens: usageMetadata?.promptTokenCount ?? 0,
      output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: (usageMetadata?.promptTokenCount ?? 0) + (usageMetadata?.candidatesTokenCount ?? 0),
    };

    return {
      id: responseId ?? `gemini-${Date.now()}`,
      status: 'completed',
      output_text: [text],
      output: [{ type: 'text', text }],
      usage,
    };
  };

  const enrichGeminiError = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('404')) {
      return new Error(
        `Gemini model not available to this API key/region. Confirm preview access and model ID (${modelId}). Original: ${message}`,
      );
    }
    return error instanceof Error ? error : new Error(message);
  };

  return {
    responses: {
      stream: (body: OracleRequestBody): ResponseStreamLike => {
        const geminiBody = adaptBodyToGemini(body);
        let finalResponsePromise: Promise<OracleResponse> | null = null;
        let aggregatedText = '';
        let lastUsage: GenerateContentResponseUsageMetadata | undefined;
        let responseId: string | undefined;
        async function* iterator() {
          let streamingResp: Awaited<ReturnType<typeof genAI.models.generateContentStream>>;
          try {
            streamingResp = await genAI.models.generateContentStream(geminiBody);
          } catch (error) {
            throw enrichGeminiError(error);
          }
          for await (const chunk of streamingResp) {
            const text = chunk.text;
            if (text) {
              aggregatedText += text;
              yield { type: 'chunk', delta: text };
            }
            if (chunk.usageMetadata) {
              lastUsage = chunk.usageMetadata;
            }
            if (chunk.responseId) {
              responseId = chunk.responseId;
            }
          }
          finalResponsePromise = Promise.resolve(
            adaptAggregatedTextToOracle(aggregatedText, lastUsage, responseId),
          );
        }

        const generator = iterator();
        
        return {
          [Symbol.asyncIterator]: () => generator,
          finalResponse: async () => {
            // Ensure the stream has been consumed or at least started to get the promise
            if (!finalResponsePromise) {
               // In case the user calls finalResponse before iterating, we need to consume the stream
               // This is a bit edge-casey but safe.
               for await (const _ of generator) {} 
            }
            if (!finalResponsePromise) {
                throw new Error('Response promise not initialized');
            }
            return finalResponsePromise;
          }
        };
      },
      create: async (body: OracleRequestBody): Promise<OracleResponse> => {
        const geminiBody = adaptBodyToGemini(body);
        let result: Awaited<ReturnType<typeof genAI.models.generateContent>>;
        try {
          result = await genAI.models.generateContent(geminiBody);
        } catch (error) {
          throw enrichGeminiError(error);
        }
        return adaptGeminiResponseToOracle(result);
      },
      retrieve: async (id: string): Promise<OracleResponse> => {
        return {
          id,
          status: 'error',
          error: { message: 'Retrieve by ID not supported for Gemini API yet.' },
        };
      },
    },
  };
}
