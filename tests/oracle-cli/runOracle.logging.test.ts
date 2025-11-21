import { describe, expect, test } from 'vitest';

import { runOracle, type ClientLike, type OracleResponse } from '../../src/oracle.ts';
import { MockClient, MockStream, buildResponse } from './helpers.ts';

describe('runOracle no-file tip', () => {
  test('logs guidance when no files are attached', async () => {
    const logs: string[] = [];
    const mockStream = new MockStream([], {
      id: 'resp-1',
      status: 'completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 0,
        total_tokens: 15,
      },
      output: [
        {
          type: 'message',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
    const client = new MockClient(mockStream);
    await runOracle(
      {
        prompt: 'hello',
        model: 'gpt-5.1-pro',
        search: false,
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join('\n').toLowerCase();
    expect(combined).toContain('no files attached');
    expect(combined).toContain('--file');
  });
});

describe('api key logging', () => {
  test('logs masked OPENAI_API_KEY', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Key log test',
        model: 'gpt-5.1-pro',
        background: false,
      },
      {
        apiKey: 'sk-supersecret-key-1234',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join('\n');
    expect(combined).toContain('Using OPENAI_API_KEY=sk-s****1234');
    expect(combined).not.toContain('supersecret');
  });

  test('logs masked GEMINI_API_KEY when using gemini model', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Key log test Gemini',
        model: 'gemini-3-pro',
        background: false,
      },
      {
        apiKey: 'sk-gemini-secret-9999',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join('\n');
    expect(combined).toContain('Using GEMINI_API_KEY=sk-g****9999 for model gemini-3-pro');
    expect(combined).not.toContain('gemini-secret');
  });

  test('throws when OPENAI_API_KEY is missing for API engine', async () => {
    const originalOpenai = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        runOracle(
          {
            prompt: 'Needs key',
            model: 'gpt-5.1-pro',
            background: false,
          },
          {
            log: () => {},
            write: () => true,
          },
        ),
      ).rejects.toThrow(/Missing OPENAI_API_KEY/);
    } finally {
      if (originalOpenai !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenai;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  test('throws when GEMINI_API_KEY is missing for gemini API engine', async () => {
    const originalGemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(
        runOracle(
          {
            prompt: 'Needs gemini key',
            model: 'gemini-3-pro',
            background: false,
          },
          {
            log: () => {},
            write: () => true,
          },
        ),
      ).rejects.toThrow(/Missing GEMINI_API_KEY/);
    } finally {
      if (originalGemini !== undefined) {
        process.env.GEMINI_API_KEY = originalGemini;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }
  });

  test('single-line summary includes session id when provided', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      { prompt: 'Summarize', model: 'gpt-5.1-pro', sessionId: 'abc123', background: false },
      {
        apiKey: 'sk-test',
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    const finished = logs.find((line) => line.startsWith('Finished abc123 in '));
    expect(finished).toBeDefined();
    expect(finished).toContain('abc123');
    expect(logs.filter((line) => line.includes('Finished abc123 in')).length).toBe(1);
  });

  test('verbose logs insert separation before answer stream', async () => {
    const stream = new MockStream(
      [
        { type: 'response.output_text.delta', delta: 'Yo' },
        { type: 'response.output_text.delta', delta: ' bro.' },
      ],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const logs: string[] = [];
    const writes: string[] = [];
    await runOracle(
      { prompt: 'hi', model: 'gpt-5.1-pro', verbose: true, background: false },
      {
        apiKey: 'sk-test-1234',
        client,
        log: (msg) => logs.push(msg),
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );
    const answerLineIndex = logs.findIndex((line) => line.trim() === 'Answer:');
    expect(answerLineIndex).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('[verbose] Dispatching request to API...'))).toBe(true);
    expect(logs[answerLineIndex - 1]).toBe('');
    expect(writes.join('')).toContain('Yo bro.');
  });

  test('streamed answers get a newline before verbose footer', async () => {
    const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Yo bro.' }], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    const writes: string[] = [];
    await runOracle(
      { prompt: 'Greeting', model: 'gpt-5.1-pro', verbose: true, background: false },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );

    const verboseIndex = logs.findIndex((line) => line.includes('Response status:'));
    expect(verboseIndex).toBeGreaterThan(0);
    expect(logs[verboseIndex - 1]).toBe('');
    expect(writes.join('')).toContain('Yo bro.\n');
  });

  test('verbose run spells out token labels', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Verbose tokens',
        model: 'gpt-5.1-pro',
        background: false,
        verbose: true,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const finished = logs.find((line) => line.startsWith('Finished in '));
    expect(finished).toBeDefined();
    expect(finished).toContain('tokens (input/output/reasoning/total)=');
    expect(finished).not.toContain('tok(i/o/r/t)=');
  });

  test('non-verbose run keeps short token label', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Short tokens',
        model: 'gpt-5.1-pro',
        background: false,
        verbose: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const finished = logs.find((line) => line.startsWith('Finished in '));
    expect(finished).toBeDefined();
    expect(finished).toContain('tok(i/o/r/t)=');
    expect(finished).not.toContain('tokens (input/output/reasoning/total)=');
  });

  test('verbose footer separation still clean for non-streamed output', async () => {
    const client: ClientLike = {
      responses: {
        stream: async () =>
          new MockStream([], {
            id: 'resp-id',
            status: 'completed',
            usage: { input_tokens: 5, output_tokens: 0, reasoning_tokens: 0, total_tokens: 5 },
            output: [
              {
                type: 'message',
                content: [{ type: 'text', text: 'Hello world' }],
              },
            ],
          }),
        async create() {
          return {
            id: 'resp-id',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'text', text: 'Hello world' }] }],
          } as OracleResponse;
        },
        async retrieve() {
          return {
            id: 'resp-id',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'text', text: 'Hello world' }] }],
          } as OracleResponse;
        },
      },
    } as ClientLike;
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Greeting',
        model: 'gpt-5.1-pro',
        background: false,
        verbose: true,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const statusIndex = logs.findIndex((line) => line.includes('Response status:'));
    expect(statusIndex).toBeGreaterThan(0);
    expect(logs[statusIndex - 1]).toBe('');
  });
});
