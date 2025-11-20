import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGeminiClient, resolveGeminiModelId } from '../src/oracle/gemini.js';
import type { OracleRequestBody } from '../src/oracle.js';
import { GoogleGenAI } from '@google/genai';

const { mockGenerateContent, mockGenerateContentStream } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  const mockGenerateContentStream = vi.fn();
  return { mockGenerateContent, mockGenerateContentStream };
});

vi.mock('@google/genai', () => {
  const MOCK_GOOGLE_GENAI = vi.fn().mockImplementation(function GoogleGenAIMock() {
    return {
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
      },
    };
  });

  return {
    // biome-ignore lint/style/useNamingConvention: keep SDK casing
    GoogleGenAI: MOCK_GOOGLE_GENAI,
    // biome-ignore lint/style/useNamingConvention: keep SDK casing
    HarmCategory: {
      // biome-ignore lint/style/useNamingConvention: keep SDK casing
      HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
      // biome-ignore lint/style/useNamingConvention: keep SDK casing
      HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
      // biome-ignore lint/style/useNamingConvention: keep SDK casing
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      // biome-ignore lint/style/useNamingConvention: keep SDK casing
      HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    },
    // biome-ignore lint/style/useNamingConvention: keep SDK casing
    HarmBlockThreshold: {
      // biome-ignore lint/style/useNamingConvention: keep SDK casing
      BLOCK_NONE: 'BLOCK_NONE',
    },
  };
});

describe('Gemini Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with the correct model', () => {
    createGeminiClient('fake-key');
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'fake-key' });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('maps 3-pro through resolver', () => {
    expect(resolveGeminiModelId('gemini-3-pro')).toBe('gemini-3-pro-preview');
  });

  it('adapts create request correctly', async () => {
    const client = createGeminiClient('fake-key');
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Gemini response' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
      },
    };
    mockGenerateContent.mockResolvedValue(mockResponse);

    const requestBody: OracleRequestBody = {
      model: 'gemini-3-pro',
      instructions: 'System prompt',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'User prompt' }],
        },
      ],
      max_output_tokens: 100,
    };

    const result = await client.responses.create(requestBody);

    expect(mockGenerateContent).toHaveBeenCalledWith({
      model: 'gemini-3-pro-preview',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'User prompt' }],
        },
      ],
      config: {
        systemInstruction: { role: 'system', parts: [{ text: 'System prompt' }] },
        tools: undefined,
        maxOutputTokens: 100,
        safetySettings: expect.any(Array),
      },
    });

    expect(result).toEqual({
      id: expect.stringMatching(/^gemini-/),
      status: 'completed',
      output_text: ['Gemini response'],
      output: [{ type: 'text', text: 'Gemini response' }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      },
    });
  });

  it('adapts streaming request correctly', async () => {
    const client = createGeminiClient('fake-key');
    
    const mockStream = async function* () {
      yield { text: 'Chunk 1 A' };
      yield { text: 'Chunk 2', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }, responseId: 'resp-123' };
    };

    mockGenerateContentStream.mockResolvedValue(mockStream());

    const requestBody: OracleRequestBody = {
      model: 'gemini-3-pro',
      instructions: 'System',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Stream me' }],
        },
      ],
      tools: [{ type: 'web_search_preview' }],
    };

    const stream = await client.responses.stream(requestBody);
    const chunks: string[] = [];

    for await (const event of stream) {
      if (event.type === 'chunk' && event.delta) {
        chunks.push(event.delta);
      }
    }

    expect(chunks).toEqual(['Chunk 1 A', 'Chunk 2']);

    expect(mockGenerateContentStream).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ tools: [{ googleSearch: {} }] }),
    }));
    
    const final = await stream.finalResponse();
    expect(final).toMatchObject({
      id: 'resp-123',
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10,
      },
      output_text: ['Chunk 1 AChunk 2'],
    });
  });

  it('maps web_search_preview to googleSearch tool and keeps safety settings', async () => {
    const client = createGeminiClient('fake-key');
    mockGenerateContent.mockResolvedValue({
      candidates: [],
      usageMetadata: {},
    });

    const requestBody: OracleRequestBody = {
      model: 'gemini-3-pro',
      instructions: '',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'search please' }],
        },
      ],
      tools: [{ type: 'web_search_preview' }],
    };

    await client.responses.create(requestBody);

    const call = mockGenerateContent.mock.calls[0]?.[0];
    expect(call?.config?.tools).toEqual([{ googleSearch: {} }]);
    expect(call?.config?.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ]);
  });

  it('prefers explicitly resolved model id when provided', async () => {
    const client = createGeminiClient('fake-key', 'gemini-3-pro', 'custom-model-id');
    mockGenerateContent.mockResolvedValue({ candidates: [], usageMetadata: {} });

    await client.responses.create({
      model: 'gemini-3-pro',
      instructions: '',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      ],
    });

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-model-id' }),
    );
  });

  it('returns finalResponse even when not iterated', async () => {
    const client = createGeminiClient('fake-key');

    const mockStream = async function* () {
      yield { text: 'Only chunk', responseId: 'resp-999', usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } };
    };

    mockGenerateContentStream.mockResolvedValue(mockStream());

    const requestBody: OracleRequestBody = {
      model: 'gemini-3-pro',
      instructions: '',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Ping' }],
        },
      ],
    };

    const stream = await client.responses.stream(requestBody);
    const final = await stream.finalResponse();

    expect(final).toEqual({
      id: 'resp-999',
      status: 'completed',
      output_text: ['Only chunk'],
      output: [{ type: 'text', text: 'Only chunk' }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
  });

  it('includes system prompt even when empty tools array is provided', async () => {
    const client = createGeminiClient('fake-key');
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: {},
      },
    });

    const requestBody: OracleRequestBody = {
      model: 'gemini-3-pro',
      instructions: 'Sys',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Ping' }],
        },
      ],
      tools: [],
    };

    await client.responses.create(requestBody);
    expect(mockGenerateContent.mock.calls[0]?.[0]).toMatchObject({
      config: { systemInstruction: { role: 'system', parts: [{ text: 'Sys' }] }, tools: [] },
    });
  });
});
