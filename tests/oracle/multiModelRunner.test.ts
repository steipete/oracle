import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runMultiModelApiSession } from '../../src/oracle/multiModelRunner.js';
import {
  OracleResponseError,
  type ModelName,
  type RunOracleOptions,
  type RunOracleResult,
  type RunOracleDeps,
} from '../../src/oracle.js';
import type { SessionStore } from '../../src/sessionStore.js';
import type { SessionMetadata, SessionModelRun } from '../../src/sessionManager.js';

const successResult = (model: ModelName): RunOracleResult => ({
  mode: 'live',
  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
  elapsedMs: 42,
  response: {
    id: `resp-${model}`,
    status: 'completed',
    usage: {},
    output: [{ type: 'text', text: `answer-${model}` }],
    // biome-ignore lint/style/useNamingConvention: field mirrors upstream response shape
    _request_id: `req-${model}`,
  },
});

describe('runMultiModelApiSession', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'oracle-multi-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test('records partial success and rejection when one model is unavailable', async () => {
    const sessionMeta: SessionMetadata = {
      id: 'sess-multi-missing-model',
      createdAt: new Date().toISOString(),
      status: 'pending',
      model: 'gpt-5.1-pro',
      options: {},
    };

    const models: ModelName[] = ['gpt-5.1-pro', 'gpt-5.1', 'gemini-3-pro'];

    const updateModelRun = vi.fn();

    const store: SessionStore = {
      ensureStorage: async () => {},
      createSession: async () => sessionMeta,
      readSession: async () => sessionMeta,
      updateSession: async () => sessionMeta,
      createLogWriter: (sessionId: string, model?: string) => {
        const logPath = path.join(tmpRoot, sessionId, 'models', `${model ?? 'session'}.log`);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, '');
        return {
          logPath,
          stream: { end: vi.fn() } as unknown as fs.WriteStream,
          logLine: (line = '') => fs.appendFileSync(logPath, `${line}\n`),
          writeChunk: (chunk: string) => {
            fs.appendFileSync(logPath, chunk);
            return true;
          },
        };
      },
      updateModelRun: updateModelRun as unknown as SessionStore['updateModelRun'],
      readLog: async () => '',
      readModelLog: async () => '',
      readRequest: async () => null,
      listSessions: async () => [],
      filterSessions: (metas) => ({ entries: metas, truncated: false, total: metas.length }),
      deleteOlderThan: async () => ({ deleted: 0, remaining: 0 }),
      getPaths: async (sessionId: string) => ({
        dir: path.join(tmpRoot, sessionId),
        metadata: '',
        log: '',
        request: '',
      }),
      sessionsDir: () => tmpRoot,
    };

    const runOracleImpl = vi.fn(async ({ model }: RunOracleOptions) => {
      if (model === 'gpt-5.1-pro') {
        throw new OracleResponseError('The requested model does not exist.');
      }
      return successResult(model as ModelName);
    });

    const summary = await runMultiModelApiSession(
      {
        sessionMeta,
        runOptions: { prompt: 'Cross-check this design', model: 'gpt-5.1-pro', search: false },
        models,
        cwd: process.cwd(),
        version: 'test',
      },
      { store, runOracleImpl },
    );

    expect(runOracleImpl).toHaveBeenCalledTimes(models.length);
    expect(summary.fulfilled.map((r) => r.model)).toEqual(expect.arrayContaining(['gpt-5.1', 'gemini-3-pro']));
    expect(summary.rejected).toEqual([
      expect.objectContaining({ model: 'gpt-5.1-pro', reason: expect.any(OracleResponseError) }),
    ]);

    runOracleImpl.mock.calls.forEach(([options]) => {
      expect(options).toMatchObject({
        suppressHeader: true,
        suppressAnswerHeader: true,
        suppressTips: true,
      });
    });

    const statusUpdatesFor = (model: string) =>
      updateModelRun.mock.calls
        .filter(([, m]) => m === model)
        .map(([, , updates]) => updates?.status);

    expect(statusUpdatesFor('gpt-5.1-pro')).toContain('running');
    expect(statusUpdatesFor('gpt-5.1-pro')).toContain('error');
    expect(statusUpdatesFor('gpt-5.1')).toContain('completed');
    expect(statusUpdatesFor('gemini-3-pro')).toContain('completed');
  });

  test('invokes onModelDone callbacks in completion order', async () => {
    vi.useFakeTimers();
    const sessionMeta: SessionMetadata = {
      id: 'sess-order',
      createdAt: new Date().toISOString(),
      status: 'pending',
      model: 'gpt-5.1-pro',
      options: {},
    };

    const models: ModelName[] = ['gemini-3-pro', 'gpt-5.1'];
    const order: string[] = [];

    const store: SessionStore = {
      ensureStorage: async () => {},
      createSession: async () => sessionMeta,
      readSession: async () => sessionMeta,
      updateSession: async () => sessionMeta,
      createLogWriter: (sessionId: string, model?: string) => {
        const logPath = path.join(tmpRoot, sessionId, 'models', `${model ?? 'session'}.log`);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, '');
        return {
          logPath,
          stream: { end: vi.fn() } as unknown as fs.WriteStream,
          logLine: (line = '') => fs.appendFileSync(logPath, `${line}\n`),
          writeChunk: (chunk: string) => {
            fs.appendFileSync(logPath, chunk);
            return true;
          },
        };
      },
      updateModelRun: async (_sessionId: string, model: string, updates: Partial<SessionModelRun>) =>
        Promise.resolve({ model, status: updates.status ?? 'running' } as SessionModelRun),
      readLog: async () => '',
      readModelLog: async () => '',
      readRequest: async () => null,
      listSessions: async () => [],
      filterSessions: (metas) => ({ entries: metas, truncated: false, total: metas.length }),
      deleteOlderThan: async () => ({ deleted: 0, remaining: 0 }),
      getPaths: async (sessionId: string) => ({
        dir: path.join(tmpRoot, sessionId),
        metadata: '',
        log: '',
        request: '',
      }),
      sessionsDir: () => tmpRoot,
    };

    const runOracleImpl = vi.fn(async ({ model }: RunOracleOptions) => {
      const delay = model === 'gemini-3-pro' ? 5 : 15;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return successResult(model as ModelName);
    });

    const promise = runMultiModelApiSession(
      {
        sessionMeta,
        runOptions: { prompt: 'Cross-check this design', model: 'gpt-5.1-pro', search: false },
        models,
        cwd: process.cwd(),
        version: 'test',
        onModelDone: (result) => {
          order.push(result.model);
        },
      },
      { store, runOracleImpl },
    );

    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    expect(order).toEqual(['gemini-3-pro', 'gpt-5.1']);
  });

  test('forwards OSC progress updates to stdout during multi-model runs', async () => {
    const sessionMeta: SessionMetadata = {
      id: 'sess-osc',
      createdAt: new Date().toISOString(),
      status: 'pending',
      model: 'gpt-5.1-pro',
      options: {},
    };

    const models: ModelName[] = ['gpt-5.1-pro'];
    let modelLogPath = '';

    const store: SessionStore = {
      ensureStorage: async () => {},
      createSession: async () => sessionMeta,
      readSession: async () => sessionMeta,
      updateSession: async () => sessionMeta,
      createLogWriter: (sessionId: string, model?: string) => {
        modelLogPath = path.join(tmpRoot, sessionId, 'models', `${model ?? 'session'}.log`);
        fs.mkdirSync(path.dirname(modelLogPath), { recursive: true });
        fs.writeFileSync(modelLogPath, '');
        return {
          logPath: modelLogPath,
          stream: { end: vi.fn() } as unknown as fs.WriteStream,
          logLine: (line = '') => fs.appendFileSync(modelLogPath, `${line}\n`),
          writeChunk: (chunk: string) => {
            fs.appendFileSync(modelLogPath, chunk);
            return true;
          },
        };
      },
      updateModelRun: async (_sessionId: string, model: string, updates: Partial<SessionModelRun>) =>
        Promise.resolve({ model, status: updates.status ?? 'running' } as SessionModelRun),
      readLog: async () => '',
      readModelLog: async () => '',
      readRequest: async () => null,
      listSessions: async () => [],
      filterSessions: (metas) => ({ entries: metas, truncated: false, total: metas.length }),
      deleteOlderThan: async () => ({ deleted: 0, remaining: 0 }),
      getPaths: async (sessionId: string) => ({
        dir: path.join(tmpRoot, sessionId),
        metadata: '',
        log: '',
        request: '',
      }),
      sessionsDir: () => tmpRoot,
    };

    const oscSequence = '\u001b]9;4;3;;Waiting for API\u001b\\';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const runOracleImpl = vi.fn(async (options: RunOracleOptions, deps?: RunOracleDeps) => {
      deps?.write?.(oscSequence);
      return successResult(options.model as ModelName);
    });

    await runMultiModelApiSession(
      {
        sessionMeta,
        runOptions: { prompt: 'Cross-check this design', model: 'gpt-5.1-pro', search: false },
        models,
        cwd: process.cwd(),
        version: 'test',
      },
      { store, runOracleImpl },
    );

    expect(writeSpy).toHaveBeenCalledWith(oscSequence);
    const logBody = fs.readFileSync(modelLogPath, 'utf8');
    expect(logBody).toContain(oscSequence);

    writeSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('does not forward OSC progress when stdout is not a TTY', async () => {
    const sessionMeta: SessionMetadata = {
      id: 'sess-osc-notty',
      createdAt: new Date().toISOString(),
      status: 'pending',
      model: 'gpt-5.1-pro',
      options: {},
    };

    const models: ModelName[] = ['gpt-5.1-pro'];
    let modelLogPath = '';

    const store: SessionStore = {
      ensureStorage: async () => {},
      createSession: async () => sessionMeta,
      readSession: async () => sessionMeta,
      updateSession: async () => sessionMeta,
      createLogWriter: (sessionId: string, model?: string) => {
        modelLogPath = path.join(tmpRoot, sessionId, 'models', `${model ?? 'session'}.log`);
        fs.mkdirSync(path.dirname(modelLogPath), { recursive: true });
        fs.writeFileSync(modelLogPath, '');
        return {
          logPath: modelLogPath,
          stream: { end: vi.fn() } as unknown as fs.WriteStream,
          logLine: (line = '') => fs.appendFileSync(modelLogPath, `${line}\n`),
          writeChunk: (chunk: string) => {
            fs.appendFileSync(modelLogPath, chunk);
            return true;
          },
        };
      },
      updateModelRun: async (_sessionId: string, model: string, updates: Partial<SessionModelRun>) =>
        Promise.resolve({ model, status: updates.status ?? 'running' } as SessionModelRun),
      readLog: async () => '',
      readModelLog: async () => '',
      readRequest: async () => null,
      listSessions: async () => [],
      filterSessions: (metas) => ({ entries: metas, truncated: false, total: metas.length }),
      deleteOlderThan: async () => ({ deleted: 0, remaining: 0 }),
      getPaths: async (sessionId: string) => ({
        dir: path.join(tmpRoot, sessionId),
        metadata: '',
        log: '',
        request: '',
      }),
      sessionsDir: () => tmpRoot,
    };

    const oscSequence = '\u001b]9;4;3;;Waiting for API\u001b\\';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const runOracleImpl = vi.fn(async (options: RunOracleOptions, deps?: RunOracleDeps) => {
      deps?.write?.(oscSequence);
      return successResult(options.model as ModelName);
    });

    await runMultiModelApiSession(
      {
        sessionMeta,
        runOptions: { prompt: 'Cross-check this design', model: 'gpt-5.1-pro', search: false },
        models,
        cwd: process.cwd(),
        version: 'test',
      },
      { store, runOracleImpl },
    );

    expect(writeSpy).not.toHaveBeenCalledWith(oscSequence);
    const logBody = fs.readFileSync(modelLogPath, 'utf8');
    expect(logBody).toContain(oscSequence);

    writeSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });
});
