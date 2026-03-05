import { describe, expect, test, vi } from 'vitest';

import { runOracle } from '@src/oracle.ts';
import { MockClient, MockStream, buildResponse } from './helpers.ts';

describe('runOracle request payload', () => {
  test('maps gpt-5.1-pro alias to gpt-5.4-pro API model', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Alias check',
        model: 'gpt-5.1-pro',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe('gpt-5.4-pro');
    expect(logs.join('\n')).toContain('(API: gpt-5.4-pro)');
    expect(logs.join('\n')).toContain('gpt-5.1-pro');
    expect(logs.join('\n')).toContain('OpenAI API uses `gpt-5.4-pro`');
  });

  test('maps gpt-5.2-pro alias to gpt-5.4-pro API model', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Alias check',
        model: 'gpt-5.2-pro',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe('gpt-5.4-pro');
    expect(logs.join('\n')).toContain('(API: gpt-5.4-pro)');
    expect(logs.join('\n')).toContain('gpt-5.2-pro');
    expect(logs.join('\n')).toContain('OpenAI API uses `gpt-5.4-pro`');
  });

  test('search enabled by default', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: 'Default search',
        model: 'gpt-5.2-pro',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: 'web_search_preview' }]);
  });

  test('passes baseUrl through to clientFactory', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; baseUrl?: string }> = [];
    await runOracle(
      {
        prompt: 'Custom endpoint',
        model: 'gpt-5.2-pro',
        baseUrl: 'https://litellm.test/v1',
        background: false,
      },
      {
        apiKey: 'sk-test',
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, baseUrl: options?.baseUrl });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([{ apiKey: 'sk-test', baseUrl: 'https://litellm.test/v1' }]);
  });

  test('passes azure config to clientFactory', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; azure?: unknown }> = [];
    const azureOptions = {
      endpoint: 'https://my-azure.com/',
      deployment: 'gpt-4-test',
      apiVersion: '2024-01-01',
    };

    await runOracle(
      {
        prompt: 'Azure test',
        model: 'gpt-5.2-pro',
        azure: azureOptions,
        background: false,
      },
      {
        apiKey: 'sk-test',
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, azure: options?.azure });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([{ apiKey: 'sk-test', azure: azureOptions }]);
  });

  test('uses grok search tool shape', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: 'Search capability',
        model: 'grok-4.1',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: 'web_search' }]);
    expect(client.lastRequest?.background).toBeUndefined();
  });

  test('forces foreground for models without background support (grok)', async () => {
    const stream = new MockStream([], buildResponse());
    const createSpy = vi.fn();
    const client = new MockClient(stream);
    // Override background create handler to fail if invoked.
    client.responses.create = createSpy.mockImplementation(() => {
      throw new Error('create should not be called for grok');
    });
    await runOracle(
      {
        prompt: 'Please run in foreground',
        model: 'grok-4.1',
        background: true,
      },
      {
        apiKey: 'sk-test',
        client,
        log: () => {},
      },
    );
    expect(createSpy).not.toHaveBeenCalled();
  });
});
