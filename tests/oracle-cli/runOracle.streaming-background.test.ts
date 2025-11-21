import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runOracle, type ClientLike } from '../../src/oracle.ts';
import { createMockFs, MockBackgroundClient, MockClient, MockStream, buildResponse } from './helpers.ts';

const testNonWindows = process.platform === 'win32' ? test.skip : test;

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
    expect(logs.some((line) => line.includes('oracle ('))).toBe(true);
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
    expect(logs.some((line) => line.includes('oracle ('))).toBe(true);
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
        { type: 'response.output_text.delta', output_index: 0, content_index: 0 },
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
      },
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
    expect(logs.some((line) => line.includes('oracle ('))).toBe(true);
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
    expect(logs.some((line) => line.includes('oracle ('))).toBe(true);
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

    expect(logs.some((line) => line.includes('oracle ('))).toBe(true);
    const listed = logs.some((line) => line.includes('note.txt'));
    expect(listed).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
