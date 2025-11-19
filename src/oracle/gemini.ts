import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type Tool,
  type GenerateContentResponse,
} from '@google/generative-ai';
import type { ClientLike, ModelName, OracleRequestBody, OracleResponse, ResponseStreamLike, ResponseOutputItem } from './types.js';

const MODEL_ID_MAP: Record<ModelName, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gpt-5.1-pro': 'gpt-5.1-pro', // unused, normalize TS map
  'gpt-5-pro': 'gpt-5-pro', // unused, normalize TS map
  'gpt-5.1': 'gpt-5.1',
  'gpt-5.1-codex': 'gpt-5.1-codex',
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
  const genAI = new GoogleGenerativeAI(apiKey);

  const modelId = resolvedModelId ?? resolveGeminiModelId(modelName);
  const model = genAI.getGenerativeModel({ model: modelId });

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

    const generationConfig = {
      maxOutputTokens: body.max_output_tokens,
    };

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

    const systemInstruction = body.instructions || undefined;

    return { systemInstruction, contents, tools, generationConfig, safetySettings };
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
      id: `gemini-${Date.now()}`, // Gemini doesn't always provide a stable ID in the response object
      status: 'completed',
      output_text: outputText,
      output,
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
        const collectChunkText = (chunk: GenerateContentResponse): string => {
          const parts: string[] = [];
          chunk.candidates?.forEach((candidate) => {
            candidate.content?.parts?.forEach((part) => {
              if (part.text) {
                parts.push(part.text);
              }
            });
          });
          return parts.join('');
        };
        async function* iterator() {
          let streamingResp: Awaited<ReturnType<typeof model.generateContentStream>>;
          try {
            streamingResp = await model.generateContentStream(geminiBody);
          } catch (error) {
            throw enrichGeminiError(error);
          }
          for await (const chunk of streamingResp.stream) {
            const text = collectChunkText(chunk);
            if (text) {
              yield { type: 'chunk', delta: text };
            }
          }
          finalResponsePromise = streamingResp.response.then(adaptGeminiResponseToOracle);
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
        let result: Awaited<ReturnType<typeof model.generateContent>>;
        try {
          result = await model.generateContent(geminiBody);
        } catch (error) {
          throw enrichGeminiError(error);
        }
        return adaptGeminiResponseToOracle(result.response);
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
