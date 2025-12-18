import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserConfig } from '../../../src/config.js';
import { DEFAULT_MODEL } from '../../../src/oracle/config.js';
import type { RunOracleOptions } from '../../../src/oracle.js';

const promptMock = vi.fn();
const performSessionRunMock = vi.fn();
const ensureSessionStorageMock = vi.fn();
const initializeSessionMock = vi.fn();
const createSessionLogWriterMock = vi.fn();
const readSessionMock = vi.fn();
const readRequestMock = vi.fn();
const readLogMock = vi.fn();
const listSessionsMock = vi.fn().mockResolvedValue([]);
const getPathsMock = vi.fn();
const pruneOldSessionsMock = vi.fn();

vi.mock('inquirer', () => ({
  default: { prompt: promptMock },
  prompt: promptMock,
}));

vi.mock('../../../src/cli/sessionRunner.ts', () => ({
  performSessionRun: performSessionRunMock,
}));

vi.mock('../../../src/sessionStore.ts', () => ({
  sessionStore: {
    ensureStorage: ensureSessionStorageMock,
    createSession: initializeSessionMock,
    createLogWriter: createSessionLogWriterMock,
    readSession: readSessionMock,
    readRequest: readRequestMock,
    readLog: readLogMock,
    listSessions: listSessionsMock,
    deleteOlderThan: vi.fn(),
    getPaths: getPathsMock,
    sessionsDir: vi.fn().mockReturnValue('/tmp/.oracle/sessions'),
  },
  pruneOldSessions: pruneOldSessionsMock,
}));

// Import after mocks are registered
const tui = await import('../../../src/cli/tui/index.ts');

const originalCI = process.env.CI;
const originalSshConnection = process.env.SSH_CONNECTION;

describe('askOracleFlow', () => {
  beforeEach(() => {
    // Make notification defaults deterministic (CI disables by default).
    process.env.CI = '';
    process.env.SSH_CONNECTION = '';
  promptMock.mockReset();
  performSessionRunMock.mockReset();
  ensureSessionStorageMock.mockReset();
  initializeSessionMock.mockReset();
  createSessionLogWriterMock.mockReset();
  readSessionMock.mockReset();
  readRequestMock.mockReset();
  readLogMock.mockReset();
  listSessionsMock.mockReset();
  getPathsMock.mockReset();
  pruneOldSessionsMock.mockReset();
  listSessionsMock.mockResolvedValue([]);
    createSessionLogWriterMock.mockReturnValue({
      logLine: vi.fn(),
      writeChunk: vi.fn(),
      stream: { end: vi.fn() },
    });
    initializeSessionMock.mockResolvedValue({
      id: 'sess-123',
      createdAt: new Date().toISOString(),
      status: 'pending',
      options: { prompt: 'hello', model: DEFAULT_MODEL },
    });
  });

  test('cancels when prompt input is blank', async () => {
    promptMock.mockResolvedValue({
      promptInput: '',
      mode: 'api',
      model: DEFAULT_MODEL,
      files: [],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const config: UserConfig = {};
    await tui.askOracleFlow('0.4.1', config);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    expect(performSessionRunMock).not.toHaveBeenCalled();
  });

  test('runs happy path and calls performSessionRun', async () => {
    promptMock.mockResolvedValue({
      promptInput: 'Hello world',
      mode: 'api',
      model: DEFAULT_MODEL,
      files: [],
      models: [],
    });

    const config: UserConfig = {};
    await tui.askOracleFlow('0.4.1', config);

    expect(ensureSessionStorageMock).toHaveBeenCalled();
    expect(initializeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Hello world', mode: 'api' }),
      expect.any(String),
      expect.objectContaining({ enabled: true, sound: false }),
    );
    expect(performSessionRunMock).toHaveBeenCalledTimes(1);
    expect(performSessionRunMock.mock.calls[0][0].sessionMeta.id).toBe('sess-123');
  });

  test('passes multi-model selections to run options', async () => {
    promptMock.mockResolvedValue({
      promptInput: 'Multi',
      mode: 'api',
      model: DEFAULT_MODEL,
      models: ['gemini-3-pro'],
      files: [],
    });

    const config: UserConfig = {};
    await tui.askOracleFlow('0.4.1', config);

    const creationArgs = initializeSessionMock.mock.calls[0]?.[0] as RunOracleOptions & { models?: string[] };
    expect(creationArgs.models).toEqual([DEFAULT_MODEL, 'gemini-3-pro']);
  });
});

afterAll(() => {
  process.env.CI = originalCI;
  process.env.SSH_CONNECTION = originalSshConnection;
});

describe('resolveCost basics', () => {
  test('computes cost for api sessions without stored cost', async () => {
    const { resolveCost } = await import('../../../src/cli/tui/index.ts');
    const apiMeta = {
      id: 'a',
      createdAt: new Date().toISOString(),
      status: 'completed',
      usage: { inputTokens: 1000, outputTokens: 2000, reasoningTokens: 0, totalTokens: 3000 },
      model: DEFAULT_MODEL,
      mode: 'api' as const,
      options: {},
    };
    expect(resolveCost(apiMeta)).toBeGreaterThan(0);
  });
});

describe('showSessionDetail', () => {
  test('prints session header and combined log then returns on back', async () => {
    const { showSessionDetail } = await import('../../../src/cli/tui/index.ts');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    promptMock.mockResolvedValueOnce({ next: 'back' });

    readSessionMock.mockResolvedValueOnce({
      id: 'sess-123',
      createdAt: '2025-11-21T00:00:00Z',
      status: 'completed',
      model: 'gpt-5.1',
      options: { prompt: 'hi', model: 'gpt-5.1', mode: 'api' },
    });
    readLogMock.mockResolvedValueOnce('Answer: hello');
    getPathsMock.mockResolvedValueOnce({
      dir: '/tmp',
      metadata: '/tmp/meta.json',
      log: '/tmp/output.log',
      request: '/tmp/request.json',
    });

    await showSessionDetail('sess-123');

    expect(readSessionMock).toHaveBeenCalledWith('sess-123');
    expect(readLogMock).toHaveBeenCalledWith('sess-123');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Session'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Log file'));

    consoleSpy.mockRestore();
  });
});
