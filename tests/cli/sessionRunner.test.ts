import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/oracle.ts', async () => {
  const actual = await vi.importActual<typeof import('../../src/oracle.ts')>('../../src/oracle.ts');
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock('../../src/browser/sessionRunner.ts', () => ({
  runBrowserSessionExecution: vi.fn(),
}));

vi.mock('../../src/cli/notifier.ts', () => ({
  sendSessionNotification: vi.fn(),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

vi.mock('../../src/oracle/multiModelRunner.ts', () => ({
  runMultiModelApiSession: vi.fn(),
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

import type { SessionMetadata } from '../../src/sessionManager.ts';
import { performSessionRun } from '../../src/cli/sessionRunner.ts';
import { BrowserAutomationError, FileValidationError, OracleResponseError, OracleTransportError, runOracle } from '../../src/oracle.ts';
import type { OracleResponse, RunOracleResult } from '../../src/oracle.ts';
import { runBrowserSessionExecution } from '../../src/browser/sessionRunner.ts';
import { sendSessionNotification } from '../../src/cli/notifier.ts';
import { getCliVersion } from '../../src/version.ts';
import { runMultiModelApiSession } from '../../src/oracle/multiModelRunner.ts';
import fs from 'node:fs/promises';

const baseSessionMeta: SessionMetadata = {
  id: 'sess-1',
  createdAt: '2025-01-01T00:00:00Z',
  status: 'pending',
  options: {},
};

const baseRunOptions = {
  prompt: 'Hello',
  model: 'gpt-5-pro' as const,
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
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
  sessionStoreMock.readModelLog.mockResolvedValue('model log body');
  vi.spyOn(fs, 'mkdir').mockResolvedValue();
  vi.spyOn(fs, 'writeFile').mockResolvedValue();
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
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Transport'));
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('User error (file-validation)'));
  });

  test('saves per-model outputs when multi-model run and writeOutputPath provided', async () => {
    vi.mocked(runMultiModelApiSession).mockResolvedValue({
      fulfilled: [
        {
          model: 'gpt-5-pro',
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
          answerText: 'pro answer',
          logPath: 'models/gpt-5-pro.log',
        },
        {
          model: 'gemini-3-pro',
          usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
          answerText: 'gemini answer',
          logPath: 'models/gemini-3-pro.log',
        },
      ],
      rejected: [],
      elapsedMs: 1000,
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, models: ['gpt-5-pro', 'gemini-3-pro'], writeOutputPath: '/tmp/out.md' },
      mode: 'api',
      cwd: '/tmp',
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fs.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(writeCalls).toContainEqual(['/tmp/out.gpt-5-pro.md', expect.stringContaining('pro answer\n'), 'utf8']);
    expect(writeCalls).toContainEqual(['/tmp/out.gemini-3-pro.md', expect.stringContaining('gemini answer\n'), 'utf8']);
  });
});
