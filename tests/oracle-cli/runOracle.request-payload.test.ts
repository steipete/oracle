import { describe, expect, test } from 'vitest';

import { runOracle } from '../../src/oracle.ts';
import { MockClient, MockStream, buildResponse } from './helpers.ts';

describe('runOracle request payload', () => {
  test('search enabled by default', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: 'Default search',
        model: 'gpt-5.1-pro',
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
        model: 'gpt-5.1-pro',
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
        model: 'gpt-5.1-pro',
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
});
