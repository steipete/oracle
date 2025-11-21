import chalk from 'chalk';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ClientLike,
  MinimalFsModule,
  OracleTransportError,
  OracleRequestBody,
  OracleResponse,
  ResponseStreamEvent,
  ResponseStreamLike,
} from '../../src/oracle.ts';

chalk.level = 0;

export type TempFile = { dir: string; filePath: string };

export interface MockResponse extends OracleResponse {
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

export class MockStream implements ResponseStreamLike {
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

export class MockClient implements ClientLike {
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

export class MockBackgroundClient implements ClientLike {
  public createdBodies: OracleRequestBody[] = [];
  private entries: MockResponse[];
  private index = 0;
  private failNext = false;

  constructor(entries: MockResponse[]) {
    this.entries = entries;
  }

  public responses = {
    create: async (body: OracleRequestBody) => {
      this.createdBodies.push(body);
      return this.entries[0];
    },
    stream: async () => {
      throw new Error('Streaming not supported for background client');
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

  triggerConnectionDrop(): void {
    this.failNext = true;
  }
}

export async function createTempFile(contents: string): Promise<TempFile> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-test-'));
  const filePath = path.join(dir, 'sample.txt');
  await writeFile(filePath, contents, 'utf8');
  return { dir, filePath };
}

export function createMockFs(fileEntries: Record<string, string>): MinimalFsModule {
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

export function buildResponse(overrides: Partial<MockResponse> = {}): MockResponse {
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
    ...overrides,
  };
}
