import { describe, expect, it, vi } from 'vitest';
import { runOracle } from '../../src/oracle/run.js';
import type { ClientLike } from '../../src/oracle/types.js';

function createMockClient(flags: { streamCalled: boolean; createCalled: boolean }): ClientLike {
  const stream = {
    async *[Symbol.asyncIterator]() {
      // no chunks
    },
    finalResponse: async () => ({
      id: 'resp-1',
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      output_text: ['ok'],
    }),
  };

  return {
    responses: {
      stream: async () => {
        flags.streamCalled = true;
        return stream;
      },
      create: async () => {
        flags.createCalled = true;
        throw new Error('should not call create');
      },
      retrieve: async () => ({ id: 'x', status: 'error' }),
    },
  };
}

describe('runOracle with Claude models', () => {
  it('forces streaming (no background) and warns when search is unsupported', async () => {
    const logs: string[] = [];
    const flags = { streamCalled: false, createCalled: false };
    const client = createMockClient(flags);

    await runOracle(
      {
        prompt: 'This is a sufficiently long prompt for testing purposes.',
        model: 'claude-4.5-sonnet',
        background: true, // should be ignored
        search: true,
        apiKey: 'sk-test',
      },
      {
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    expect(flags.streamCalled).toBe(true);
    expect(flags.createCalled).toBe(false);
    expect(logs.some((msg) => msg.includes('Background mode is not supported'))).toBe(true);
    expect(logs.some((msg) => msg.includes('Search tool is not supported'))).toBe(true);
  });

  it('passes provider-specific baseUrl to the client factory', async () => {
    const flags = { streamCalled: false, createCalled: false };
    const client = createMockClient(flags);
    let capturedBaseUrl: string | undefined;

    const clientFactory = vi.fn((_key: string, opts?: { baseUrl?: string }) => {
      capturedBaseUrl = opts?.baseUrl;
      return client;
    });

    await runOracle(
      {
        prompt: 'Another sufficiently long prompt for base URL test.',
        model: 'claude-4.5-sonnet',
        background: false,
        apiKey: 'sk-test',
        baseUrl: 'https://claude.local',
      },
      {
        clientFactory,
        log: () => {},
        write: () => true,
      },
    );

    expect(capturedBaseUrl).toBe('https://claude.local');
    expect(flags.streamCalled).toBe(true);
  });
});
