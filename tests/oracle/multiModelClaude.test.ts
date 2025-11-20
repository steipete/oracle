import { describe, expect, it, vi } from 'vitest';
import { runMultiModelApiSession } from '../../src/oracle/multiModelRunner.js';
import type { RunOracleOptions, ModelName, LiveResult } from '../../src/oracle/types.js';
import type { SessionMetadata, SessionStore } from '../../src/sessionStore.js';
import type { StoredRunOptions } from '../../src/sessionManager.js';

describe('runMultiModelApiSession', () => {
  type SessionLogWriterType = {
    stream: NodeJS.WriteStream;
    logLine: (line?: string) => void;
    writeChunk: (chunk: string) => boolean;
    logPath: string;
  };

  it('keeps background off for Claude while allowing GPT to opt in', async () => {
    const sessionMeta: SessionMetadata = {
      id: 'sess-1',
      createdAt: new Date().toISOString(),
      status: 'pending',
      options: {
        prompt: 'test',
        model: 'gpt-5.1-pro',
        background: true,
        search: true,
      } satisfies StoredRunOptions,
    };

    const seenBackground: Record<ModelName, boolean | undefined> = {
      'gpt-5.1-pro': undefined,
      'gpt-5-pro': undefined,
      'gpt-5.1': undefined,
      'gpt-5.1-codex': undefined,
      'gemini-3-pro': undefined,
      'claude-4.5-sonnet': undefined,
      'claude-4.1-opus': undefined,
    };

    const mockRunOracle = vi.fn(async (opts: RunOracleOptions): Promise<LiveResult> => {
      seenBackground[opts.model] = opts.background;
      return {
        mode: 'live',
        response: { status: 'completed', output_text: ['ok'] },
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
        elapsedMs: 10,
      };
    });

    const store = {
      ensureStorage: async () => {},
      createSession: async () => sessionMeta,
      readSession: async () => sessionMeta,
      updateSession: async () => sessionMeta,
      createLogWriter: () => {
        const stream = {} as unknown as NodeJS.WriteStream;
        return {
          logPath: 'log',
          logLine: () => {},
          writeChunk: () => true,
          stream,
        } satisfies SessionLogWriterType;
      },
      updateModelRun: async () => ({ model: '', status: 'running' }),
      readLog: async () => '',
      readModelLog: async () => '',
      readRequest: async () => null,
      listSessions: async () => [],
      filterSessions: () => ({ entries: [], truncated: false, total: 0 }),
      deleteOlderThan: async () => ({ deleted: 0, remaining: 0 }),
      getPaths: async () => ({ dir: '.', metadata: '', log: '', request: '' }),
      sessionsDir: () => '.',
    } as unknown as SessionStore;

    await runMultiModelApiSession(
      {
        sessionMeta,
        runOptions: { prompt: 'hello', model: 'gpt-5.1-pro', background: true, search: true },
        models: ['gpt-5.1-pro', 'claude-4.5-sonnet'],
        cwd: process.cwd(),
        version: 'test',
      },
      {
        runOracleImpl: mockRunOracle,
        store,
        now: () => 0,
      },
    );

    expect(seenBackground['gpt-5.1-pro']).toBe(true);
    expect(seenBackground['claude-4.5-sonnet']).toBe(false); // forced off
  });
});
