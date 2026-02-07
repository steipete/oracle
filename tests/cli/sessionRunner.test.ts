import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/oracle.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/oracle.ts')>('../../src/oracle.ts');
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock('../../src/oracle/multiModelRunner.ts', () => ({
  runMultiModelApiSession: vi.fn(),
}));

vi.mock('../../src/browser/sessionRunner.ts', () => ({
  runBrowserSessionExecution: vi.fn(),
}));

vi.mock('../../src/browser/reattach.ts', () => ({
  resumeBrowserSession: vi.fn(),
}));

vi.mock('../../src/cli/notifier.ts', () => ({
  sendSessionNotification: vi.fn(),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

const sessionStoreMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createLogWriter: vi.fn(),
  updateModelRun: vi.fn(),
  readLog: vi.fn(),
  readSession: vi.fn(),
  readRequest: vi.fn(),
  ensureStorage: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  readModelLog: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue('/tmp/.oracle/sessions'),
}));

vi.mock('../../src/sessionStore.ts', () => ({
  sessionStore: sessionStoreMock,
}));

import type { SessionMetadata, SessionModelRun } from '../../src/sessionManager.ts';
import type { ModelName } from '../../src/oracle.ts';
import { performSessionRun } from '../../src/cli/sessionRunner.ts';
import { BrowserAutomationError, FileValidationError, OracleResponseError, OracleTransportError, runOracle } from '../../src/oracle.ts';
import {
  runMultiModelApiSession,
  type ModelExecutionResult,
  type MultiModelRunSummary,
} from '../../src/oracle/multiModelRunner.ts';
import type { OracleResponse, RunOracleResult } from '../../src/oracle.ts';
import { runBrowserSessionExecution } from '../../src/browser/sessionRunner.ts';
import { sendSessionNotification } from '../../src/cli/notifier.ts';
import { getCliVersion } from '../../src/version.ts';
import { deriveModelOutputPath } from '../../src/cli/sessionRunner.ts';
import { resumeBrowserSession } from '../../src/browser/reattach.ts';

const baseSessionMeta: SessionMetadata = {
  id: 'sess-1',
  createdAt: '2025-01-01T00:00:00Z',
  status: 'pending',
  options: {},
};

const baseRunOptions = {
  prompt: 'Hello',
  model: 'gpt-5.2-pro' as const,
};

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();
const originalPlatform = process.platform;

beforeAll(() => {
  // Force macOS platform so browser-mode paths are reachable in Linux/Windows CI
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      fn.mockReset();
    }
  });
  vi.mocked(runMultiModelApiSession).mockReset();
  vi.mocked(runMultiModelApiSession).mockResolvedValue({ fulfilled: [], rejected: [], elapsedMs: 0 });
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
  sessionStoreMock.readModelLog.mockResolvedValue('model log body');
  sessionStoreMock.sessionsDir.mockReturnValue('/tmp/.oracle/sessions');
  vi.spyOn(fsPromises, 'mkdir').mockResolvedValue(undefined);
  vi.spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
});

describe('performSessionRun', () => {
  test('completes API sessions and records usage', async () => {
    const liveResult: RunOracleResult = {
      mode: 'live',
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
      elapsedMs: 1234,
      response: { id: 'resp', usage: {}, output: [] },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'api',
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(sessionStoreMock.updateSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runOracle)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'completed',
      usage: { totalTokens: 30 },
      response: expect.objectContaining({ responseId: expect.any(String) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.2-pro',
      expect.objectContaining({ status: 'running' }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.2-pro',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test('writes final assistant output to disk for single-model runs', async () => {
    const liveResult: RunOracleResult = {
      mode: 'live',
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
      elapsedMs: 500,
      response: {
        id: 'resp',
        usage: {},
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Saved text' }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: '/tmp/out.md' },
      mode: 'api',
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const expectedPath = path.resolve('/tmp/out.md');
    expect(writeCalls).toContainEqual([expectedPath, expect.stringContaining('Saved text\n'), 'utf8']);
    const logLines = log.mock.calls.map((c) => c[0]).join('\n');
    expect(logLines).toContain('Saved assistant output');
  });

  test('streams per-model output as each model finishes when TTY', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(async (_sessionId: string, model: string) => `Answer:\nfrom ${model}`);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      const fulfilled: ModelExecutionResult[] = [
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'gemini answer',
          logPath: 'log-gemini',
        },
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'gpt answer',
          logPath: 'log-gpt',
        },
      ];

      if (params.onModelDone) {
        for (const entry of fulfilled) {
          await params.onModelDone(entry);
        }
      }

      return {
        fulfilled,
        rejected: [],
        elapsedMs: 1000,
      } as MultiModelRunSummary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('from gemini-3-pro');
    expect(written).toContain('from gpt-5.1');
    const geminiIndex = written.indexOf('from gemini-3-pro');
    const gptIndex = written.indexOf('from gpt-5.1');
    expect(geminiIndex).toBeGreaterThan(-1);
    expect(gptIndex).toBeGreaterThan(-1);
    expect(geminiIndex).toBeLessThan(gptIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('strips OSC progress codes from stored model logs', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('\u001b]9;4;3;;Waiting for API\u001b\\Please provide design');

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'other',
          logPath: 'log-gpt',
        },
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'fallback text',
          logPath: 'log-gem',
        },
      ],
      rejected: [],
      elapsedMs: 123,
    };

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const combined =
      writeSpy.mock.calls.map((c) => c[0]).join('') + logSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('Please provide design');
    // OSC progress codes should be preserved when replaying logs so terminals can render them.
    expect(combined).toContain('\u001b]9;4;');

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

	  test('writes per-model outputs during multi-model runs when writeOutputPath provided', async () => {
	    const summary: MultiModelRunSummary = {
	      fulfilled: [
	        {
	          model: 'gpt-5.2-pro' as ModelName,
	          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3, cost: 0.01 },
	          answerText: 'pro answer',
	          logPath: 'log-pro',
	        },
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3, cost: 0.02 },
          answerText: 'gemini answer',
          logPath: 'log-gemini',
        },
      ],
      rejected: [],
      elapsedMs: 1200,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

	    await performSessionRun({
	      sessionMeta: {
	        ...baseSessionMeta,
	        models: [
	          { model: 'gpt-5.2-pro', status: 'pending' } as SessionModelRun,
	          { model: 'gemini-3-pro', status: 'pending' } as SessionModelRun,
	        ],
	      },
	      runOptions: { ...baseRunOptions, models: ['gpt-5.2-pro', 'gemini-3-pro'], writeOutputPath: '/tmp/out.md' },
	      mode: 'api',
	      cwd: '/tmp',
	      log,
	      write,
	      version: cliVersion,
	    });

	    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
	    const expectedProPath = path.resolve('/tmp/out.gpt-5.2-pro.md');
	    const expectedGeminiPath = path.resolve('/tmp/out.gemini-3-pro.md');
	    expect(writeCalls).toContainEqual([expectedProPath, expect.stringContaining('pro answer\n'), 'utf8']);
	    expect(writeCalls).toContainEqual([expectedGeminiPath, expect.stringContaining('gemini answer\n'), 'utf8']);
	    const logLines = log.mock.calls.map((c) => c[0]).join('\n');
	    expect(logLines).toContain('Saved outputs:');
	    expect(logLines).toContain(`gpt-5.2-pro -> ${expectedProPath}`);
	  });

  test('prints one aggregate header and colored summary for multi-model runs', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\nfrom model');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 0.01 },
          answerText: 'ans-gpt',
          logPath: 'log-gpt',
        },
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0, totalTokens: 10, cost: 0.02 },
          answerText: 'ans-gemini',
          logPath: 'log-gemini',
        },
      ],
      rejected: [],
      elapsedMs: 1234,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logsCombined).toContain('Calling gpt-5.1, gemini-3-pro');
    expect((logsCombined.match(/Calling gpt-5.1/g) ?? []).length).toBe(1);
    expect((logsCombined.match(/Tip: no files attached/g) ?? []).length).toBe(1);
    expect((logsCombined.match(/Tip: brief prompts often yield generic answers/g) ?? []).length).toBe(1);
    expect(logsCombined).toContain('2/2 models');
    expect(logsCombined).toContain('↑');
    expect(logsCombined).toContain('↓');
    expect(logsCombined).toContain('Δ');

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('uses warning color when some models fail', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' },
        { model: 'gemini-3-pro', status: 'running' },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\npartial');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'ok',
          logPath: 'log-ok',
        },
      ],
      rejected: [{ model: 'gemini-3-pro' as ModelName, reason: new Error('boom') }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await expect(
      performSessionRun({
        sessionMeta,
        runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'] },
        mode: 'api',
        cwd: '/tmp',
        log: logSpy,
        write: writeSpy,
        version: cliVersion,
      }),
    ).rejects.toThrow('boom');

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logsCombined).toContain('Calling gpt-5.1, gemini-3-pro');
    expect(logsCombined).toContain('1/2 models');

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('prints tips before the first model heading in multi-model TTY streaming', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(async (_sessionId: string, model: string) => `Answer for ${model}`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'ans-gpt',
          logPath: 'log-gpt',
        },
      ],
      rejected: [],
      elapsedMs: 321,
    };
    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5.1', 'gemini-3-pro'], prompt: 'short' },
      mode: 'api',
      cwd: '/tmp',
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logMessages = logSpy.mock.calls.map((c) => c[0]);
    const tipIndex = logMessages.findIndex((line) => typeof line === 'string' && line.includes('Tip: no files attached'));
    const headingIndex = logMessages.findIndex((line) => typeof line === 'string' && line.includes('[gpt-5.1]'));
    expect(tipIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(-1);
    expect(tipIndex).toBeLessThan(headingIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test('omits tips when files are attached and prompt is long', async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: 'gpt-5.1', status: 'running' } as SessionModelRun,
        { model: 'gemini-3-pro', status: 'running' } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\nfrom model');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, 'oracle-tip.txt');
    fs.writeFileSync(tmpFile, 'content');

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: 'gpt-5.1' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'ans-gpt',
          logPath: 'log-gpt',
        },
        {
          model: 'gemini-3-pro' as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: 'ans-gem',
          logPath: 'log-gemini',
        },
      ],
      rejected: [],
      elapsedMs: 999,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: {
        ...baseRunOptions,
        prompt: 'a'.repeat(100),
        file: [tmpFile],
        models: ['gpt-5.1', 'gemini-3-pro'],
      },
      mode: 'api',
      cwd: tmpDir,
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logsCombined).toContain('Calling gpt-5.1, gemini-3-pro');
    expect(logsCombined).not.toContain('Tip: no files attached');
    expect(logsCombined).not.toContain('Tip: brief prompts often yield generic answers');

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  }, 10_000);

  test('invokes browser runner when mode is browser', async () => {
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
      elapsedMs: 2000,
      runtime: { chromePid: 123, chromePort: 9222, userDataDir: '/tmp/profile' },
      answerText: 'Answer',
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'browser',
      browserConfig: { chromePath: null },
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(runBrowserSessionExecution)).toHaveBeenCalled();
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'completed',
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePid: 123 }) }),
    });
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'running' }),
	    );
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'completed' }),
	    );
	  });

  test('writes browser answers to disk when writeOutputPath provided', async () => {
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime: { chromePid: 1, chromePort: 9222, userDataDir: '/tmp/chrome' },
      answerText: 'browser answer',
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: '/tmp/browser-out.md' },
      mode: 'browser',
      browserConfig: { chromePath: null },
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const expectedPath = path.resolve('/tmp/browser-out.md');
    expect(writeCalls).toContainEqual([expectedPath, expect.stringContaining('browser answer\n'), 'utf8']);
  });

  test('write-output failures warn but keep session successful', async () => {
    const liveResult: RunOracleResult = {
      mode: 'live',
      usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0, totalTokens: 10 },
      elapsedMs: 300,
      response: {
        id: 'resp',
        usage: {},
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'content' }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);
    const eacces = new Error('EACCES');
    // @ts-expect-error simulate code
    eacces.code = 'EACCES';
    vi.mocked(fsPromises.writeFile)
      .mockRejectedValueOnce(eacces as never)
      .mockResolvedValueOnce(undefined as unknown as Awaited<ReturnType<typeof fsPromises.writeFile>>);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: { ...baseRunOptions, writeOutputPath: '/tmp/out.md' },
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
        version: cliVersion,
      }),
    ).resolves.not.toThrow();

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: 'completed' });
    const logLines = log.mock.calls.map((c) => c[0]).join('\n');
    expect(logLines).toContain('write-output fallback');
    const calls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0][0]).toBe(path.resolve('/tmp/out.md'));
    expect(calls[1][0]).toMatch(/out\.fallback/);
  });

  test('refuses to write inside session storage path', async () => {
    const sessionsDir = sessionStoreMock.sessionsDir();
    const liveResult: RunOracleResult = {
      mode: 'live',
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
      elapsedMs: 100,
      response: {
        id: 'resp',
        usage: {},
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'blocked' }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: path.join(sessionsDir, 'out.md') },
      mode: 'api',
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => c[0]).join('\n');
    expect(logLines).toContain('refusing to write inside session storage');
  });

	  test('deriveModelOutputPath appends model when base has no extension', () => {
	    const result = deriveModelOutputPath('/tmp/out', 'gpt-5.2-pro');
	    const expected = path.join(path.dirname('/tmp/out'), 'out.gpt-5.2-pro');
	    expect(result).toBe(expected);
	  });

  test('records metadata when browser automation fails', async () => {
    const automationError = new BrowserAutomationError('automation failed', { stage: 'execute-browser' });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'browser',
        browserConfig: { chromePath: null },
        cwd: '/tmp',
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow('automation failed');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      errorMessage: 'automation failed',
      browser: expect.objectContaining({ config: expect.any(Object) }),
    });
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'error' }),
	    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).not.toContain('Next steps (browser fallback)');
    expect(logLines).not.toContain('--engine api');
  });

  test('keeps session running when assistant response times out', async () => {
    const automationError = new BrowserAutomationError('assistant timed out', {
      stage: 'assistant-timeout',
      runtime: { chromePort: 9222, chromeHost: '127.0.0.1', tabUrl: 'https://chatgpt.com/c/demo' },
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'browser',
      browserConfig: { chromePath: null },
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'running',
      response: { status: 'running', incompleteReason: 'assistant-timeout' },
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePort: 9222 }) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      'gpt-5.2-pro',
      expect.objectContaining({ status: 'running' }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logLines).toContain('Assistant response timed out; keeping session running for reattach.');
  });

  test('auto-reattaches after assistant timeout when configured', async () => {
    const automationError = new BrowserAutomationError('assistant timed out', {
      stage: 'assistant-timeout',
      runtime: { chromePort: 9222, chromeHost: '127.0.0.1', tabUrl: 'https://chatgpt.com/c/demo' },
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
    vi.mocked(resumeBrowserSession).mockResolvedValue({
      answerText: 'ok text',
      answerMarkdown: 'ok markdown',
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: 'browser',
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1000,
        autoReattachTimeoutMs: 1000,
      },
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'completed',
      response: { status: 'completed' },
    });
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test('auto-reattach stops after a hard cap when it cannot capture an answer', async () => {
    vi.useFakeTimers();
    try {
      const automationError = new BrowserAutomationError('assistant timed out', {
        stage: 'assistant-timeout',
        runtime: { chromePort: 9222, chromeHost: '127.0.0.1', tabUrl: 'https://chatgpt.com/c/demo' },
      });
      vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
      vi.mocked(resumeBrowserSession).mockRejectedValue(new Error('not ready'));

      const pending = performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'browser',
        browserConfig: {
          chromePath: null,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 60 * 60 * 1000,
          autoReattachTimeoutMs: 1000,
        },
        cwd: '/tmp',
        log,
        write,
        version: cliVersion,
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 5_000);
      await pending;

      expect(vi.mocked(resumeBrowserSession).mock.calls.length).toBeGreaterThanOrEqual(2);
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: 'running',
        response: { status: 'running', incompleteReason: 'assistant-timeout' },
      });
      const logLines = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logLines).toContain('Auto-reattach stopped');
      expect(logLines).toContain('Reattach later with: oracle session');
    } finally {
      vi.useRealTimers();
    }
  });

  test('records response metadata when runOracle throws OracleResponseError', async () => {
    const errorResponse: OracleResponse = { id: 'resp-error', output: [], usage: {} };
    vi.mocked(runOracle).mockRejectedValue(new OracleResponseError('boom', errorResponse));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('boom');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      response: expect.objectContaining({ responseId: 'resp-error' }),
    });
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'running' }),
	    );
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'error' }),
	    );
  });

  test('captures transport failures when OracleTransportError thrown', async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError('client-timeout', 'timeout'));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('timeout');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      transport: { reason: 'client-timeout' },
    });
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'error' }),
	    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Transport'));
  });

  test('stores api-error transport message for later rendering', async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError('api-error', 'quota exceeded'));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow('quota exceeded');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      transport: { reason: 'api-error' },
      errorMessage: 'quota exceeded',
    });
  });

  test('captures user errors when OracleUserError thrown', async () => {
    vi.mocked(runOracle).mockRejectedValue(new FileValidationError('too large', { path: 'foo.txt' }));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: 'api',
        cwd: '/tmp',
        log,
        write,
      version: cliVersion,
      }),
    ).rejects.toThrow('too large');

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ category: 'file-validation', message: 'too large' }),
    });
	    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
	      baseSessionMeta.id,
	      'gpt-5.2-pro',
	      expect.objectContaining({ status: 'error' }),
	    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('User error (file-validation)'));
  });
});
