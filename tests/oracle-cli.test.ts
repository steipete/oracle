import { describe, expect, test } from 'vitest';
import chalk from 'chalk';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildPrompt,
  runOracle,
  renderPromptMarkdown,
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  buildRequestBody,
  extractTextOutput,
  formatUSD,
  formatNumber,
  formatElapsed,
  getFileTokenStats,
  printFileTokenStats,
  OracleTransportError,
} from '../src/oracle.ts';
import { collectPaths, parseIntOption } from '../src/cli/options.ts';
import type {
  MinimalFsModule,
  ClientLike,
  ResponseStreamLike,
  ResponseStreamEvent,
  OracleResponse,
  OracleRequestBody,
} from '../src/oracle.ts';

const testNonWindows = process.platform === 'win32' ? test.skip : test;

chalk.level = 0;

type TempFile = { dir: string; filePath: string };

interface MockResponse extends OracleResponse {
  id: string;
  status: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
  output: Array<{
    type: 'message';
    content: Array<{ type: 'text'; text: string }>;
  }>;
  // biome-ignore lint/style/useNamingConvention: OpenAI uses _request_id in responses
  _request_id?: string | null;
}

async function createTempFile(contents: string): Promise<TempFile> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
  const filePath = path.join(dir, 'sample.txt');
  await writeFile(filePath, contents, 'utf8');
  return { dir, filePath };
}

class MockStream implements ResponseStreamLike {
  private events: ResponseStreamEvent[];
  private finalResponseValue: MockResponse;

  constructor(events: ResponseStreamEvent[], finalResponse: MockResponse) {
    this.events = events;
    this.finalResponseValue = finalResponse;
  }

  [Symbol.asyncIterator](): AsyncIterator<ResponseStreamEvent> {
    let index = 0;
    const events = this.events;
    return {
      next: async () => {
        if (index >= events.length) {
          return { done: true, value: undefined };
        }
        const value = events[index++];
        return { done: false, value };
      },
    };
  }

  async finalResponse(): Promise<MockResponse> {
    return this.finalResponseValue;
  }
}

class MockClient implements ClientLike {
  public stream: MockStream;
  public lastRequest: OracleRequestBody | null;
  public responses: {
    stream: (body: OracleRequestBody) => Promise<MockStream>;
    create: (body: OracleRequestBody) => Promise<MockResponse>;
    retrieve: (id: string) => Promise<MockResponse>;
  };

  constructor(stream: MockStream) {
    this.stream = stream;
    this.lastRequest = null;
    this.responses = {
      stream: async (body: OracleRequestBody) => {
        this.lastRequest = body;
        return this.stream;
      },
      create: async () => {
        throw new Error('Background mode not supported in MockClient');
      },
      retrieve: async () => {
        throw new Error('Background mode not supported in MockClient');
      },
    };
  }
}

class MockBackgroundClient implements ClientLike {
  public createdBodies: OracleRequestBody[] = [];
  private entries: MockResponse[];
  private index = 0;
  private failNext = false;
  public responses: {
    stream: (body: OracleRequestBody) => Promise<ResponseStreamLike>;
    create: (body: OracleRequestBody) => Promise<MockResponse>;
    retrieve: (id: string) => Promise<MockResponse>;
  };

  constructor(entries: MockResponse[]) {
    this.entries = entries;
    this.responses = {
      stream: async () => {
        throw new Error('Streaming not supported in MockBackgroundClient');
      },
      create: async (body: OracleRequestBody) => {
        this.createdBodies.push(body);
        this.index = 0;
        return this.entries[0];
      },
      retrieve: async () => {
        if (this.failNext) {
          this.failNext = false;
          throw new OracleTransportError('connection-lost', 'mock disconnect');
        }
        this.index = Math.min(this.index + 1, this.entries.length - 1);
        return this.entries[this.index];
      },
    };
  }

  triggerConnectionDrop(): void {
    this.failNext = true;
  }
}

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

describe('buildPrompt', () => {
  test('includes attached file sections with relative paths', async () => {
    const { dir, filePath } = await createTempFile('hello from file');
    try {
      const prompt = buildPrompt('Base', [{ path: filePath, content: 'hello from file' }], dir);
      expect(prompt).toContain('### File 1: sample.txt');
      expect(prompt).toContain('hello from file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    // Ensure no separate duplicate completion line was logged
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
    const logLines = logs;
    expect(logLines.some((line) => line.includes('[verbose] Dispatching request to API...'))).toBe(true);
    const answerLineIndex = logLines.findIndex((line) => line.trim() === 'Answer:');
    expect(answerLineIndex).toBeGreaterThan(0);
    // The line immediately before Answer should be blank (separator)
    expect(logLines[answerLineIndex - 1]).toBe('');
  });

  test('streamed answers get a newline before verbose footer', async () => {
    const stream = new MockStream(
      [
        { type: 'response.output_text.delta', delta: 'Yo bro.' },
      ],
      buildResponse(),
    );
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
    // Non-streamed runs keep the single blank separator before verbose footer (but no run-on).
    expect(logs[statusIndex - 1]).toBe('');
  });
});

describe('timeouts', () => {
  test('non-pro run respects short timeout override', async () => {
    const nowRef = { t: 0 };
    const wait = async (ms: number) => {
      nowRef.t += ms;
    };
    const client: ClientLike = {
      responses: {
        async stream() {
          return new MockStream([], buildResponse());
        },
        async create() {
          return { id: 'bg-1', status: 'in_progress', output: [] } as OracleResponse;
        },
        async retrieve() {
          return { id: 'bg-1', status: 'in_progress', output: [] } as OracleResponse;
        },
      },
    };

    await expect(
      runOracle(
        { prompt: 'hi', model: 'gpt-5.1', background: true, timeoutSeconds: 1 },
        { client, log: () => {}, write: () => true, wait, now: () => nowRef.t },
      ),
    ).rejects.toBeInstanceOf(OracleTransportError);
  });

  test('gpt-5.1-pro auto timeout allows long background runs', async () => {
    const nowRef = { t: 0 };
    const wait = async (ms: number) => {
      nowRef.t += ms;
    };
    let pollCount = 0;
    const client: ClientLike = {
      responses: {
        async stream() {
          return new MockStream([], buildResponse());
        },
        async create() {
          return { id: 'bg-2', status: 'in_progress', output: [] } as OracleResponse;
        },
        async retrieve() {
          pollCount += 1;
          if (pollCount >= 3) {
            return {
              id: 'bg-2',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
              usage: { input_tokens: 1, output_tokens: 0, reasoning_tokens: 0, total_tokens: 1 },
            } as OracleResponse;
          }
          return { id: 'bg-2', status: 'in_progress', output: [] } as OracleResponse;
        },
      },
    };

    const result = await runOracle(
      { prompt: 'hi', model: 'gpt-5.1-pro', background: true },
      { client, log: () => {}, write: () => true, wait, now: () => nowRef.t },
    );
    expect(result.mode).toBe('live');
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });
});

describe('runOracle preview mode', () => {
  test('prints request JSON when preview mode is json', async () => {
    const logs: string[] = [];
    const result = await runOracle(
      {
        prompt: 'Preview me',
        model: 'gpt-5.1-pro',
        preview: true,
        previewMode: 'json',
        search: true,
      },
      {
        apiKey: 'sk-test',
        log: (msg: string) => logs.push(msg),
      },
    );

    expect(result.mode).toBe('preview');
    if (result.mode !== 'preview') {
      throw new Error('Expected preview result');
    }
    expect(result.previewMode).toBe('json');
    expect(result.requestBody?.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(logs.some((line) => line === 'Request JSON')).toBe(true);
    expect(logs.some((line) => line.startsWith('oracle ('))).toBe(false);
  });

  test('omits request JSON in preview-only mode', async () => {
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Preview only',
        model: 'gpt-5.1-pro',
        preview: true,
        previewMode: 'summary',
      },
      {
        apiKey: 'sk-test',
        log: (msg: string) => logs.push(msg),
      },
    );

    expect(logs.some((line) => line.startsWith('oracle ('))).toBe(false);
    expect(logs.some((line) => line === 'Request JSON')).toBe(false);
  });

  test('full preview mode emits assembled prompt text', async () => {
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Show everything',
        model: 'gpt-5.1-pro',
        preview: true,
        previewMode: 'full',
      },
      {
        apiKey: 'sk-test',
        log: (msg: string) => logs.push(msg),
      },
    );

    expect(logs).toContain('Assembled Prompt');
    expect(logs.some((line) => line.includes('Show everything'))).toBe(true);
  });
});

describe('runOracle error handling', () => {
  test('throws when estimated tokens exceed the configured budget', async () => {
    await expect(
      runOracle(
        {
          prompt: 'This is a small prompt',
          model: 'gpt-5.1-pro',
          maxInput: 1,
          background: false,
        },
        { apiKey: 'sk-test' },
      ),
    ).rejects.toThrow('Input too large');
  });

  test('logs short-prompt guidance when prompt is brief', async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'short',
        model: 'gpt-5.1-pro',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    expect(logs.some((line) => line.includes('brief prompts often yield generic answers'))).toBe(true);
  });
});

describe('runOracle streaming output', () => {
  test('streams deltas and prints stats', async () => {
    const stream = new MockStream(
      [
        { type: 'chunk', delta: 'Hello ', output_index: 0, content_index: 0 },
        { type: 'chunk', delta: 'world', output_index: 0, content_index: 0 },
      ],
      buildResponse(),
    );
    const writes: string[] = [];
    const logs: string[] = [];
    let ticks = 0;
    const client = new MockClient(stream);
    const result = await runOracle(
      {
        prompt: 'Say hello',
        model: 'gpt-5.1-pro',
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        log: (msg: string) => logs.push(msg),
        now: () => {
          ticks += 1000;
          return ticks;
        },
      },
    );

    expect(result.mode).toBe('live');
    expect(writes.join('')).toBe('Hello world\n\n');
    expect(logs.some((line) => line.startsWith('🧿 oracle ('))).toBe(true);
    expect(logs.some((line) => line.startsWith('Finished in '))).toBe(true);
  });


  test('silent mode suppresses streamed answer output', async () => {
    const stream = new MockStream(
      [{ type: 'chunk', delta: 'hi', output_index: 0, content_index: 0 }],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const writes: string[] = [];
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Say nothing',
        model: 'gpt-5.1-pro',
        silent: true,
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        log: (msg: string) => logs.push(msg),
      },
    );

    expect(writes).toEqual([]);
    expect(logs.some((line) => line.startsWith('🧿 oracle ('))).toBe(true);
    const finishedLine = logs.find((line) => line.startsWith('Finished in '));
    expect(finishedLine).toBeDefined();
  });

  test('accepts OpenAI delta events alongside chunk events', async () => {
    const stream = new MockStream(
      [
        { type: 'response.output_text.delta', delta: 'alpha', output_index: 0, content_index: 0 },
        { type: 'chunk', delta: 'beta', output_index: 0, content_index: 0 },
      ],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const writes: string[] = [];
    await runOracle(
      { prompt: 'Mix events', model: 'gpt-5.1-pro', background: false },
      {
        apiKey: 'sk-test',
        client,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        log: () => {},
      },
    );

    expect(writes.join('')).toContain('alpha');
    expect(writes.join('')).toContain('beta');
  });

  test('handles mixed stream payloads with missing delta text gracefully', async () => {
    const stream = new MockStream(
      [
        { type: 'response.output_text.delta', output_index: 0, content_index: 0 }, // no delta field
        { type: 'chunk', delta: 'visible', output_index: 0, content_index: 0 },
      ],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const writes: string[] = [];
    await runOracle(
      { prompt: 'Robust stream', model: 'gpt-5.1-pro', background: false },
      {
        apiKey: 'sk-test',
        client,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        log: () => {},
      },
    );

    expect(writes.join('')).toBe('visible\n\n');
  });
});

describe('runOracle background mode', () => {
  test('uses background mode for GPT-5 Pro by default', async () => {
    const finalResponse = buildResponse();
    const initialResponse = { ...finalResponse, status: 'in_progress', output: [] };
    const client = new MockBackgroundClient([initialResponse, finalResponse]);
    const logs: string[] = [];
    let clock = 0;
    const now = () => clock;
    const wait = async (ms: number) => {
      clock += ms;
    };
    const result = await runOracle(
      {
        prompt: 'Background run',
        model: 'gpt-5.1-pro',
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        now,
        wait,
      },
    );
    expect(result.mode).toBe('live');
    expect(client.createdBodies[0]?.background).toBe(true);
    expect(client.createdBodies[0]?.store).toBe(true);
    expect(logs.some((line) => line.includes('background response status'))).toBe(true);
  });

  test('retries polling and logs reconnection after a transport drop', async () => {
    const logs: string[] = [];
    const finalResponse = buildResponse();
    const initialResponse = { ...finalResponse, status: 'in_progress' };
    const client = new MockBackgroundClient([initialResponse, finalResponse]);
    client.triggerConnectionDrop();

    const wait = async (_ms: number) => {};
    const now = () => Date.now();
    
    await runOracle(
      {
          prompt: 'Retry test',
          model: 'gpt-5.1-pro',
      },
      {
          apiKey: 'sk-test',
          client,
          log: (msg) => logs.push(msg),
          wait,
          now,
      }
    );

    expect(logs.some((line) => line.includes('Retrying in'))).toBe(true);
    expect(logs.some((line) => line.includes('Reconnected to API background response'))).toBe(true);
  });
});

describe('runOracle file reports', () => {
  test('filesReport flag logs token usage per file', async () => {
    const cwd = '/tmp/oracle-files-report';
    const files = {
      [path.resolve(cwd, 'alpha.md')]: 'alpha content',
      [path.resolve(cwd, 'beta.md')]: 'beta content that is a bit longer',
    };
    const fsMock = createMockFs(files);
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Base prompt',
        model: 'gpt-5.1-pro',
        file: ['alpha.md', 'beta.md'],
        filesReport: true,
        silent: true,
        background: false,
      },
      {
        apiKey: 'sk-test',
        cwd,
        fs: fsMock,
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(logs.some((line) => line.startsWith('🧿 oracle ('))).toBe(true);
    const fileUsageIndex = logs.indexOf('File Token Usage');
    expect(fileUsageIndex).toBeGreaterThan(-1);
    const fileLines = logs.slice(fileUsageIndex + 1, fileUsageIndex + 3);
    expect(fileLines[0]).toContain('beta.md');
    expect(fileLines[1]).toContain('alpha.md');
  });

  test('automatically logs file usage when attachments exceed budget and aborts before API call', async () => {
    const cwd = '/tmp/oracle-files-overflow';
    const files = {
      [path.resolve(cwd, 'big.txt')]: 'a'.repeat(10000),
    };
    const fsMock = createMockFs(files);
    const logs: string[] = [];
    await expect(
      runOracle(
        {
          prompt: 'Check budget',
          model: 'gpt-5.1-pro',
          file: ['big.txt'],
          maxInput: 100,
          background: false,
        },
        {
          apiKey: 'sk-test',
          cwd,
          fs: fsMock,
          log: (msg: string) => logs.push(msg),
          clientFactory: () => {
            throw new Error('Should not create client when over budget');
          },
        },
      ),
    ).rejects.toThrow('Input too large');
    expect(logs.some((line) => line.startsWith('🧿 oracle ('))).toBe(true);
    expect(logs.find((line) => line === 'File Token Usage')).toBeDefined();
  });

  testNonWindows('accepts directories passed via --file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-dir-'));
    const nestedDir = path.join(dir, 'notes');
    await mkdir(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, 'note.txt');
    await writeFile(nestedFile, 'nested content', 'utf8');

    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: 'Directory test',
        model: 'gpt-5.1-pro',
        file: [dir],
        filesReport: true,
        silent: true,
        background: false,
      },
      {
        apiKey: 'sk-test',
        client,
        log: (msg: string) => logs.push(msg),
        cwd: dir,
      },
    );

    expect(logs.some((line) => line.startsWith('🧿 oracle ('))).toBe(true);
    const fileLogIndex = logs.indexOf('File Token Usage');
    expect(fileLogIndex).toBeGreaterThan(-1);
    expect(logs.some((line) => line.includes('note.txt'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
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

describe('renderPromptMarkdown', () => {
  test('emits markdown bundle with system and files', async () => {
    const { dir, filePath } = await createTempFile('rendered content');
    try {
      const markdown = await renderPromptMarkdown(
        {
          prompt: 'Hello world',
          file: [filePath],
        },
        { cwd: dir },
      );
      expect(markdown).toContain('[SYSTEM]');
      expect(markdown).toContain('[USER]');
      expect(markdown).toContain('[FILE: sample.txt]');
      expect(markdown).toContain('rendered content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('warns when render-markdown exceeds token threshold', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'oracle-warn-'));
    const filePath = path.join(cwd, 'big.txt');
    // 50k chars ~ 12.5k tokens per file; stitch enough to cross 196k
    const chunk = 'a'.repeat(50_000);
    await writeFile(filePath, chunk.repeat(4), 'utf8'); // ~200k chars → ~50k tokens
    const logs: string[] = [];
    try {
      await renderPromptMarkdown(
        {
          prompt: 'Hello world',
          file: [filePath],
        },
        { cwd },
      );
      // Direct rendering doesn't warn; the warning is in CLI path. Simulate warning helper.
      const { warnIfOversizeBundle } = await import('../src/cli/bundleWarnings.js');
      const warned = warnIfOversizeBundle(200_000, 196_000, (msg: string) => logs.push(msg));
      expect(warned).toBe(true);
      expect(logs.join('\n')).toMatch(/Warning: bundle is ~200,000 tokens/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

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
});

describe('oracle utility helpers', () => {
  test('collectPaths flattens inputs and trims whitespace', () => {
    const result = collectPaths([' alpha, beta ', 'gamma', '']);
    expect(result).toEqual(['alpha', 'beta', 'gamma']);
    const unchanged = collectPaths(undefined, ['start']);
    expect(unchanged).toEqual(['start']);
  });

  test('collectPaths honors multiple flags and comma-separated batches', () => {
    const initial = collectPaths(['src/docs', 'tests,examples'], []);
    expect(initial).toEqual(['src/docs', 'tests', 'examples']);
    const appended = collectPaths(['more', 'assets,notes'], initial);
    expect(appended).toEqual(['src/docs', 'tests', 'examples', 'more', 'assets', 'notes']);
  });

  test('parseIntOption handles undefined and invalid values', () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption('42')).toBe(42);
    expect(() => parseIntOption('not-a-number')).toThrow('Value must be an integer.');
  });

  testNonWindows('readFiles deduplicates and expands directories', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-'));
    try {
      const nestedDir = path.join(dir, 'nested');
      await mkdir(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, 'note.txt');
      await writeFile(nestedFile, 'nested', 'utf8');

      const duplicateFiles = await readFiles([nestedFile, nestedFile], { cwd: dir });
      expect(duplicateFiles).toHaveLength(1);
      expect(duplicateFiles[0].content).toBe('nested');

      const expandedFiles = await readFiles([dir], { cwd: dir });
      expect(expandedFiles.map((file) => path.basename(file.path))).toContain('note.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles rejects immediately when a referenced file is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-missing-'));
    try {
      await expect(readFiles(['ghost.txt'], { cwd: dir })).rejects.toThrow(/Missing file or directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles respects glob include/exclude syntax and size limits', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-glob-'));
    try {
      const nestedDir = path.join(dir, 'src', 'nested');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(dir, 'src', 'alpha.ts'), 'alpha', 'utf8');
      await writeFile(path.join(dir, 'src', 'beta.test.ts'), 'beta', 'utf8');
      await writeFile(path.join(nestedDir, 'gamma.ts'), 'gamma', 'utf8');

      const files = await readFiles(['src/**/*.ts', '!src/**/*.test.ts'], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('alpha.ts');
      expect(basenames).toContain('gamma.ts');
      expect(basenames).not.toContain('beta.test.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles skips dotfiles by default when expanding directories', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-dot-'));
    try {
      const dotFile = path.join(dir, '.env');
      const visibleFile = path.join(dir, 'app.ts');
      await writeFile(dotFile, 'SECRET=1', 'utf8');
      await writeFile(visibleFile, 'console.log(1)', 'utf8');

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('app.ts');
      expect(basenames).not.toContain('.env');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles can opt-in to dotfiles with explicit globs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-dot-include-'));
    try {
      const dotFile = path.join(dir, '.env');
      await writeFile(dotFile, 'SECRET=1', 'utf8');

      const files = await readFiles(['**/.env'], { cwd: dir });
      expect(files).toHaveLength(1);
      expect(path.basename(files[0].path)).toBe('.env');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles honors .gitignore when present', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-gitignore-'));
    try {
      const gitignore = path.join(dir, '.gitignore');
      const ignoredFile = path.join(dir, 'secret.log');
      const nestedIgnored = path.join(dir, 'build', 'asset.js');
      const keptFile = path.join(dir, 'kept.txt');
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      await mkdir(path.join(dir, 'build'), { recursive: true });
      await writeFile(gitignore, 'secret.log\nbuild/\n', 'utf8');
      await writeFile(ignoredFile, 'should skip', 'utf8');
      await writeFile(nestedIgnored, 'ignored build asset', 'utf8');
      await writeFile(keptFile, 'keep me', 'utf8');

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('kept.txt');
      expect(basenames).not.toContain('secret.log');
      expect(basenames).not.toContain('asset.js');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles honors nested .gitignore files', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-gitignore-nested-'));
    try {
      const subdir = path.join(dir, 'dist');
      await mkdir(subdir, { recursive: true });
      await writeFile(path.join(subdir, '.gitignore'), '*.map\n', 'utf8');
      const ignored = path.join(subdir, 'bundle.js.map');
      const kept = path.join(subdir, 'bundle.js');
      await writeFile(ignored, 'ignored', 'utf8');
      await writeFile(kept, 'kept', 'utf8');

      const files = await readFiles([path.join(dir, 'dist')], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('bundle.js');
      expect(basenames).not.toContain('bundle.js.map');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles skips default-ignored dirs when walking project roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-ignore-default-'));
    try {
      const nodeModules = path.join(dir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      const ignoredFile = path.join(nodeModules, 'leftpad.ts');
      const keptFile = path.join(dir, 'src', 'index.ts');
      await mkdir(path.dirname(keptFile), { recursive: true });
      await writeFile(ignoredFile, 'ignored', 'utf8');
      await writeFile(keptFile, 'kept', 'utf8');

      const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const files = await readFiles(['**/*.ts'], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('index.ts');
      expect(basenames).not.toContain('leftpad.ts');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('node_modules'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles allows explicitly passed default-ignored dirs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-allow-default-'));
    try {
      const nodeModules = path.join(dir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      const filePath = path.join(nodeModules, 'package.json');
      await writeFile(filePath, '{"name":"ok"}', 'utf8');

      const files = await readFiles([nodeModules], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('package.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles logs and skips default-ignored dirs under project roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-ignore-logs-'));
    const ignoredDirs = ['node_modules', 'dist', 'coverage'];
    try {
      for (const ignored of ignoredDirs) {
        const ignoredDir = path.join(dir, ignored);
        await mkdir(ignoredDir, { recursive: true });
        await writeFile(path.join(ignoredDir, `${ignored}-ignored.txt`), 'ignored', 'utf8');
      }
      const keepFile = path.join(dir, 'src', 'keep.ts');
      await mkdir(path.dirname(keepFile), { recursive: true });
      await writeFile(keepFile, 'keep', 'utf8');

      const { vi } = await import('vitest');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));

      expect(basenames).toContain('keep.ts');
      for (const ignored of ignoredDirs) {
        expect(basenames.some((name) => name.includes(`${ignored}-ignored.txt`))).toBe(false);
        const logged = logSpy.mock.calls.flat().some((arg) => String(arg ?? '').includes(ignored));
        expect(logged).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles rejects files larger than 1 MB', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-large-'));
    try {
      const largeFile = path.join(dir, 'huge.bin');
      await writeFile(largeFile, 'a'.repeat(1_200_000), 'utf8');
      await expect(readFiles([largeFile], { cwd: dir })).rejects.toThrow(/exceed the 1 MB limit/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('createFileSections renders relative paths', () => {
    const sections = createFileSections(
      [{ path: '/tmp/example/file.txt', content: 'contents' }],
      '/tmp/example',
    );
    expect(sections[0].displayPath).toBe('file.txt');
    expect(sections[0].sectionText).toContain('### File 1: file.txt');
  });

  test('buildRequestBody respects search toggles', () => {
    const base = buildRequestBody({
      modelConfig: MODEL_CONFIGS['gpt-5.1-pro'],
      systemPrompt: 'sys',
      userPrompt: 'user',
      searchEnabled: false,
      maxOutputTokens: 222,
    });
    expect(base.tools).toBeUndefined();
    expect(base.max_output_tokens).toBe(222);

    const withSearch = buildRequestBody({
      modelConfig: MODEL_CONFIGS['gpt-5.1'],
      systemPrompt: 'sys',
      userPrompt: 'user',
      searchEnabled: true,
      maxOutputTokens: undefined,
    });
    expect(withSearch.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(withSearch.reasoning).toEqual({ effort: 'high' });
  });

  test('extractTextOutput combines multiple event styles', () => {
    const responseWithOutputText = {
      output_text: ['First chunk', 'Second chunk'],
      output: [],
    };
    expect(extractTextOutput(responseWithOutputText)).toBe('First chunk\nSecond chunk');

    const responseWithMessages = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'output_text', text: 'World' },
          ],
        },
        {
          type: 'output_text',
          text: '!!!',
        },
      ],
    };
    expect(extractTextOutput(responseWithMessages)).toBe('Hello\nWorld\n!!!');
  });

  test('formatting helpers render friendly output', () => {
    expect(formatUSD(12.345)).toBe('$12.3450');
    expect(formatUSD(0.05)).toBe('$0.0500');
    expect(formatUSD(0.000123)).toBe('$0.0001');
    expect(formatUSD(Number.NaN)).toBe('n/a');

    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(4200, { estimated: true })).toBe('4,200 (est.)');
    expect(formatNumber(null)).toBe('n/a');

    expect(formatElapsed(12345)).toBe('12.35s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });

  test('getFileTokenStats orders files by tokens and reports totals', () => {
    const files = [
      { path: '/tmp/a.txt', content: 'aaa' },
      { path: '/tmp/b.txt', content: 'bbbbbb' },
    ];
    const tokenizer = (input: unknown) => String(input).length;
    const { stats, totalTokens } = getFileTokenStats(files, {
      cwd: '/tmp',
      tokenizer,
      tokenizerOptions: {},
      inputTokenBudget: 100,
    });
    expect(totalTokens).toBeGreaterThan(0);
    expect(stats[0].displayPath).toBe('b.txt');
    expect(stats[1].displayPath).toBe('a.txt');

    const logs: string[] = [];
    printFileTokenStats({ stats, totalTokens }, { inputTokenBudget: 100, log: (msg: string) => logs.push(msg) });
    expect(logs[0]).toBe('File Token Usage');
    expect(logs.some((line) => line.includes('Total:'))).toBe(true);
  });
});

function createMockFs(fileEntries: Record<string, string>): MinimalFsModule {
  const normalizedEntries = Object.fromEntries(
    Object.entries(fileEntries).map(([key, value]) => [path.resolve(key), value]),
  ) as Record<string, string>;

  function hasDirectory(dirPath: string) {
    const prefix = `${dirPath}${path.sep}`;
    return Object.keys(normalizedEntries).some((entry) => entry.startsWith(prefix));
  }

  return {
    async stat(targetPath: string) {
      const normalizedPath = path.resolve(targetPath);
      if (normalizedEntries[normalizedPath] != null) {
        const size = Buffer.byteLength(normalizedEntries[normalizedPath]);
        return {
          isFile(): boolean {
            return true;
          },
          isDirectory(): boolean {
            return false;
          },
          size,
        };
      }
      if (hasDirectory(normalizedPath)) {
        return {
          isFile(): boolean {
            return false;
          },
          isDirectory(): boolean {
            return true;
          },
        };
      }
      throw Object.assign(new Error(`Missing file: ${normalizedPath}`), { code: 'ENOENT' });
    },
    async readFile(targetPath: string) {
      const normalizedPath = path.resolve(targetPath);
      if (!(normalizedPath in normalizedEntries)) {
        throw Object.assign(new Error(`Missing file: ${normalizedPath}`), { code: 'ENOENT' });
      }
      return normalizedEntries[normalizedPath];
    },
    async readdir(targetPath: string) {
      const normalizedPath = path.resolve(targetPath);
      if (!hasDirectory(normalizedPath)) {
        throw Object.assign(new Error(`Not a directory: ${normalizedPath}`), { code: 'ENOTDIR' });
      }
      const children = new Set<string>();
      const prefix = `${normalizedPath}${path.sep}`;
      for (const entry of Object.keys(normalizedEntries)) {
        if (entry.startsWith(prefix)) {
          const remainder = entry.slice(prefix.length);
          if (remainder.length === 0) {
            continue;
          }
          const child = remainder.split(path.sep)[0];
          children.add(child);
        }
      }
      return Array.from(children);
    },
  };
}

function buildResponse(): MockResponse {
  return {
    id: 'resp_test_123',
    status: 'completed',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 1,
      total_tokens: 16,
    },
    // biome-ignore lint/style/useNamingConvention: mirrors API field
    _request_id: 'req_test_456',
    incomplete_details: undefined,
    output: [
      {
        type: 'message',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    ],
  };
}
