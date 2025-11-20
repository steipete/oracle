import type {
  ClientLike,
  ModelName,
  OracleRequestBody,
  OracleResponse,
  ResponseStreamEvent,
  ResponseStreamLike,
} from './types.js';

const DEFAULT_CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function extractPrompt(body: OracleRequestBody): string {
  const first = body.input?.[0]?.content?.[0];
  if (first && first.type === 'input_text') {
    return first.text ?? '';
  }
  return '';
}

async function callClaude({
  apiKey,
  model,
  prompt,
  endpoint,
  stream = false,
}: {
  apiKey: string;
  model: string;
  prompt: string;
  endpoint?: string;
  stream?: boolean;
}): Promise<Response> {
  const url = endpoint?.trim() || DEFAULT_CLAUDE_ENDPOINT;
  const payload: Record<string, unknown> = {
    model,
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    stream,
  };

  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });
}

async function parseClaudeResponse(raw: Response): Promise<OracleResponse> {
  const json = (await raw.json()) as {
    id?: string;
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(json.error.message || 'Claude request failed');
  }
  const textParts = json.content?.map((part) => part.text ?? '').filter(Boolean) ?? [];
  const outputText = textParts.join('');
  return {
    id: json.id ?? `claude-${Date.now()}`,
    status: 'completed',
    output_text: [outputText],
    output: [{ type: 'text', text: outputText }],
    usage: {
      input_tokens: json.usage?.input_tokens ?? 0,
      output_tokens: json.usage?.output_tokens ?? 0,
      total_tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
    },
  };
}

export function createClaudeClient(
  apiKey: string,
  modelName: ModelName,
  resolvedModelId?: string,
  baseUrl?: string,
): ClientLike {
  const modelId = resolveClaudeModelId(resolvedModelId ?? modelName);

  const stream = async (body: OracleRequestBody): Promise<ResponseStreamLike> => {
    const prompt = extractPrompt(body);
    const resp = await callClaude({ apiKey, model: modelId, prompt, stream: false, endpoint: baseUrl });
    const parsed = await parseClaudeResponse(resp);
    const iterator = async function* (): AsyncGenerator<ResponseStreamEvent> {
      if (parsed.output_text?.[0]) {
        yield { type: 'response.output_text.delta', delta: parsed.output_text[0] };
      }
      return;
    };
    return {
      [Symbol.asyncIterator]: () => iterator(),
      finalResponse: async () => parsed,
    } satisfies ResponseStreamLike;
  };

  const create = async (body: OracleRequestBody): Promise<OracleResponse> => {
    const prompt = extractPrompt(body);
    const resp = await callClaude({ apiKey, model: modelId, prompt, stream: false, endpoint: baseUrl });
    return parseClaudeResponse(resp);
  };

  const retrieve = async (id: string): Promise<OracleResponse> => ({
    id,
    status: 'error',
    error: { message: 'Retrieve by ID not supported for Claude API yet.' },
  });

  return {
    responses: {
      stream,
      create,
      retrieve,
    },
  };
}

export function resolveClaudeModelId(modelName: string): string {
  if (modelName === 'claude-4.5-sonnet' || modelName === 'claude-sonnet-4-5-20241022') {
    return 'claude-sonnet-4-5';
  }
  if (modelName === 'claude-4.1-opus' || modelName === 'claude-opus-4-1-20240808') {
    return 'claude-opus-4-1';
  }
  return modelName;
}
