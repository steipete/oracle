import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserConfig } from '../../../src/config.js';

const promptMock = vi.fn();
const performSessionRunMock = vi.fn();
const ensureSessionStorageMock = vi.fn();
const initializeSessionMock = vi.fn();
const createSessionLogWriterMock = vi.fn();

vi.mock('inquirer', () => ({
  default: { prompt: promptMock },
  prompt: promptMock,
}));

vi.mock('../../../src/cli/sessionRunner.ts', () => ({
  performSessionRun: performSessionRunMock,
}));

vi.mock('../../../src/sessionManager.ts', () => ({
  ensureSessionStorage: ensureSessionStorageMock,
  initializeSession: initializeSessionMock,
  createSessionLogWriter: createSessionLogWriterMock,
  readSessionMetadata: vi.fn(),
  readSessionRequest: vi.fn(),
  readSessionLog: vi.fn(),
  listSessionsMetadata: vi.fn().mockResolvedValue([]),
  getSessionPaths: vi.fn(),
}));

// Import after mocks are registered
const tui = await import('../../../src/cli/tui/index.ts');

describe('askOracleFlow', () => {
  beforeEach(() => {
    promptMock.mockReset();
    performSessionRunMock.mockReset();
    ensureSessionStorageMock.mockReset();
    initializeSessionMock.mockReset();
    createSessionLogWriterMock.mockReset();
    createSessionLogWriterMock.mockReturnValue({
      logLine: vi.fn(),
      writeChunk: vi.fn(),
      stream: { end: vi.fn() },
    });
    initializeSessionMock.mockResolvedValue({
      id: 'sess-123',
      createdAt: new Date().toISOString(),
      status: 'pending',
      options: { prompt: 'hello', model: 'gpt-5-pro' },
    });
  });

  test('cancels when prompt input is blank', async () => {
    promptMock.mockResolvedValue({
      promptInput: '',
      mode: 'api',
      model: 'gpt-5-pro',
      files: [],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const config: UserConfig = {};
    await tui.askOracleFlow('1.1.0', config);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    expect(performSessionRunMock).not.toHaveBeenCalled();
  });

  test('runs happy path and calls performSessionRun', async () => {
    promptMock.mockResolvedValue({
      promptInput: 'Hello world',
      mode: 'api',
      model: 'gpt-5-pro',
      files: [],
    });

    const config: UserConfig = {};
    await tui.askOracleFlow('1.1.0', config);

    expect(ensureSessionStorageMock).toHaveBeenCalled();
    expect(initializeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Hello world', mode: 'api' }),
      expect.any(String),
      expect.objectContaining({ enabled: true }),
    );
    expect(performSessionRunMock).toHaveBeenCalledTimes(1);
    expect(performSessionRunMock.mock.calls[0][0].sessionMeta.id).toBe('sess-123');
  });
});

describe('resolveCost basics', () => {
  test('computes cost for api sessions without stored cost', async () => {
    const { resolveCost } = await import('../../../src/cli/tui/index.ts');
    const apiMeta = {
      id: 'a',
      createdAt: new Date().toISOString(),
      status: 'completed',
      usage: { inputTokens: 1000, outputTokens: 2000, reasoningTokens: 0, totalTokens: 3000 },
      model: 'gpt-5-pro',
      mode: 'api' as const,
      options: {},
    };
    expect(resolveCost(apiMeta)).toBeGreaterThan(0);
  });
});
