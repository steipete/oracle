import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OracleRequestBody } from '../../src/oracle/types.js';

describe('createDefaultClientFactory', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ORACLE_CLIENT_FACTORY;
    vi.restoreAllMocks();
  });

  test('falls back to default factory and warns when custom factory export is invalid', async () => {
    process.env.ORACLE_CLIENT_FACTORY = '/nonexistent/path.js';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createDefaultClientFactory } = await import('../../src/oracle/client.js');
    const factory = createDefaultClientFactory();
    expect(typeof factory).toBe('function');
    expect(warn).toHaveBeenCalledOnce();
  });

  test('uses inline test factory hook when requested', async () => {
    process.env.ORACLE_CLIENT_FACTORY = 'INLINE_TEST_FACTORY';
    const { createDefaultClientFactory } = await import('../../src/oracle/client.js');
    const factory = createDefaultClientFactory();
    const client = factory('key');
    const request: OracleRequestBody = {
      model: 'gpt-5.1',
      instructions: 'test',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    };
    const response = await client.responses.create(request);
    const streamed = client.responses.stream(request);
    const retrieved = await client.responses.retrieve('inline-test');

    expect(response).toMatchObject({ id: 'inline-test', status: 'completed' });
    expect(retrieved).toMatchObject({ id: 'inline-test' });
    // stream exposes an async iterator and a finalResponse promise.
    expect(typeof (await streamed).finalResponse).toBe('function');
  });

  test('routes gemini models through the Gemini client', async () => {
    process.env.ORACLE_CLIENT_FACTORY = '';
    const createGeminiClient = vi.fn((key, model, resolvedModelId) => ({
      client: 'gemini',
      key,
      model,
      resolvedModelId,
    }));
    vi.doMock('../../src/oracle/gemini.js', () => ({ createGeminiClient }));

    const { createDefaultClientFactory } = await import('../../src/oracle/client.js');
    const factory = createDefaultClientFactory();
    const client = factory('abc', { model: 'gemini-3-pro', resolvedModelId: 'gem-3-pro' });

    expect(createGeminiClient).toHaveBeenCalledWith('abc', 'gemini-3-pro', 'gem-3-pro');
    expect(client).toMatchObject({ client: 'gemini', model: 'gemini-3-pro' });
  });

  test('routes claude models through the Claude client', async () => {
    process.env.ORACLE_CLIENT_FACTORY = '';
    const createClaudeClient = vi.fn((key, model, resolvedModelId, baseUrl) => ({
      client: 'claude',
      key,
      model,
      resolvedModelId,
      baseUrl,
    }));
    vi.doMock('../../src/oracle/claude.js', () => ({ createClaudeClient }));

    const { createDefaultClientFactory } = await import('../../src/oracle/client.js');
    const factory = createDefaultClientFactory();
    const client = factory('xyz', {
      model: 'claude-4.5-sonnet',
      resolvedModelId: 'claude-sonnet',
      baseUrl: 'https://example',
    });

    expect(createClaudeClient).toHaveBeenCalledWith('xyz', 'claude-4.5-sonnet', 'claude-sonnet', 'https://example');
    expect(client).toMatchObject({ client: 'claude', model: 'claude-4.5-sonnet' });
  });

  test('creates OpenAI clients for default and Azure paths', async () => {
    process.env.ORACLE_CLIENT_FACTORY = '';
    const { createDefaultClientFactory } = await import('../../src/oracle/client.js');
    const factory = createDefaultClientFactory();

    const defaultClient = factory('sk-test', { model: 'gpt-5.1' });
    const azureClient = factory('sk-azure', {
      model: 'gpt-5.1',
      azure: { endpoint: 'https://example.azure.com', apiVersion: '2025-04-01-preview', deployment: 'gpt5' },
    });

    expect(defaultClient.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
    expect(azureClient.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
  });
});
