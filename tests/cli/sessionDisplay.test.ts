import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionMetadata } from '../../src/sessionManager.ts';
import {
  buildReattachLine,
  formatResponseMetadata,
  formatTransportMetadata,
  formatUserErrorMetadata,
  trimBeforeFirstAnswer,
  attachSession,
} from '../../src/cli/sessionDisplay.ts';
import chalk from 'chalk';

const waitMock = vi.hoisted(() => vi.fn());
const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  readLog: vi.fn(),
  readModelLog: vi.fn(),
  readRequest: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue('/tmp/sessions'),
}));

vi.mock('../../src/sessionStore.ts', () => ({
  sessionStore: sessionStoreMock,
  wait: waitMock,
}));

vi.mock('../../src/sessionManager.ts', () => ({
  wait: vi.fn(),
}));

vi.mock('../../src/cli/markdownRenderer.ts', () => {
  return {
    renderMarkdownAnsi: vi.fn((s: string) => `RENDER:${s}`),
  };
});

const _sessionManagerMock = await import('../../src/sessionManager.ts');
const markdownMock = await import('../../src/cli/markdownRenderer.ts');
const renderMarkdownMock = markdownMock.renderMarkdownAnsi as unknown as { mockClear?: () => void };
const readSessionMetadataMock = sessionStoreMock.readSession as unknown as ReturnType<typeof vi.fn>;
const readSessionLogMock = sessionStoreMock.readLog as unknown as ReturnType<typeof vi.fn>;
const readModelLogMock = sessionStoreMock.readModelLog as unknown as ReturnType<typeof vi.fn>;
const readSessionRequestMock = sessionStoreMock.readRequest as unknown as ReturnType<typeof vi.fn>;

const originalIsTty = process.stdout.isTTY;
const originalChalkLevel = chalk.level;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  chalk.level = 1;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      fn.mockReset();
    }
  });
  sessionStoreMock.sessionsDir.mockReturnValue('/tmp/sessions');
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTty, configurable: true });
  chalk.level = originalChalkLevel;
  vi.restoreAllMocks();
});

describe('formatResponseMetadata', () => {
  test('returns null when metadata missing', () => {
    expect(formatResponseMetadata(undefined)).toBeNull();
  });

  test('joins available metadata parts', () => {
    expect(
      formatResponseMetadata({
        responseId: 'resp-123',
        requestId: 'req-456',
        status: 'completed',
        incompleteReason: undefined,
      }),
    ).toBe('response=resp-123 | request=req-456 | status=completed');
  });
});

describe('formatTransportMetadata', () => {
  test('returns friendly label for known reasons', () => {
    expect(formatTransportMetadata({ reason: 'client-timeout' })).toContain('client timeout');
  });

  test('falls back to null when not provided', () => {
    expect(formatTransportMetadata()).toBeNull();
  });
});

describe('formatUserErrorMetadata', () => {
  test('returns null when not provided', () => {
    expect(formatUserErrorMetadata()).toBeNull();
  });

  test('formats category, message, and details', () => {
    expect(
      formatUserErrorMetadata({ category: 'file-validation', message: 'Too big', details: { path: 'foo.txt' } }),
    ).toBe('file-validation | message=Too big | details={"path":"foo.txt"}');
  });
});

describe('buildReattachLine', () => {
  test('returns message only when session running', () => {
    const now = Date.UTC(2025, 0, 1, 12, 0, 0);
    vi.setSystemTime(now);
    const metadata: SessionMetadata = {
      id: 'session-123',
      createdAt: new Date(now - 30_000).toISOString(),
      status: 'running',
      options: {},
    };
    expect(buildReattachLine(metadata)).toBe('Session session-123 reattached, request started 30s ago.');
  });

  test('returns null for completed sessions', () => {
    const metadata: SessionMetadata = {
      id: 'done',
      createdAt: new Date().toISOString(),
      status: 'completed',
      options: {},
    };
    expect(buildReattachLine(metadata)).toBeNull();
  });
});

describe('trimBeforeFirstAnswer', () => {
  test('returns log starting at first Answer marker', () => {
    const input = 'intro\nnoise\nAnswer:\nactual content\n';
    expect(trimBeforeFirstAnswer(input)).toBe('Answer:\nactual content\n');
  });

  test('returns original text when marker missing', () => {
    const input = 'no answer yet';
    expect(trimBeforeFirstAnswer(input)).toBe(input);
  });
});

describe('attachSession rendering', () => {
  const baseMeta: SessionMetadata = {
    id: 'sess',
    createdAt: new Date().toISOString(),
    status: 'completed',
    options: {},
  };

  beforeEach(() => {
    renderMarkdownMock?.mockClear?.();
    readSessionRequestMock.mockReset();
  });

  test('prints chain metadata for follow-up sessions', async () => {
    const followupMeta: SessionMetadata = {
      ...baseMeta,
      options: {
        previousResponseId: 'resp_parent_1234',
        followupSessionId: 'parent-session',
      },
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(followupMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nchild output');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: false });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Chain: parent-session (resp_parent_1234) -> sess'));
  });

	  test('prints all model runs with status and tokens', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        {
	          model: 'gpt-5.2-pro',
	          status: 'completed',
	          usage: { inputTokens: 10, outputTokens: 12, reasoningTokens: 0, totalTokens: 24 },
	        },
        {
          model: 'gemini-3-pro',
          status: 'running',
          usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 0, totalTokens: 10 },
        },
      ],
    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nhi');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

	    await attachSession('sess', { renderMarkdown: false });

	    expect(logSpy).toHaveBeenCalledWith('Models:');
	    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/gpt-5\.2-pro.*completed tok=12\/24/));
	    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/gemini-3-pro.*running tok=0\/10/));
	  });

	  test('ignores empty model filter from CLI defaults', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        { model: 'gpt-5.2-pro', status: 'completed', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 } },
	      ],
	    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nbody');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write');

	    await attachSession('sess', { renderMarkdown: false, model: '' });

	    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('gpt-5.2-pro'));
	    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Answer:'));
	  });

	  test('falls back to session log when per-model logs are empty', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        { model: 'gpt-5.2-pro', status: 'completed', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 } },
	      ],
	    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(multiMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nfrom-session-log');
    // model log missing/empty
    readModelLogMock.mockResolvedValue('');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write');

	    await attachSession('sess', { renderMarkdown: false });

	    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Answer:\nfrom-session-log'));
	    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('gpt-5.2-pro'));
	  });

  test('renders markdown when requested and rich tty', async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nhello *world*');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Prompt:'));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith('Answer:\nhello *world*');
    expect(writeSpy).toHaveBeenCalledWith('RENDER:Answer:\nhello *world*');
  });

  test('skips render when too large', async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue('A'.repeat(210_000));
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Prompt:'));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(1);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(expect.stringContaining('Prompt here'));
    expect(writeSpy).toHaveBeenCalled(); // raw write
  });

  test('streams rendered chunks during running sessions and honors safe breaks', async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: 'running' };
    const completedMeta: SessionMetadata = { ...baseMeta, status: 'completed' };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    readSessionLogMock
      .mockResolvedValueOnce('Answer:\n| a | b |\n')
      .mockResolvedValueOnce('Answer:\n| a | b |\n| c | d |\n\nDone\n');
    const writeSpy = vi.spyOn(process.stdout, 'write');
    waitMock.mockResolvedValue(undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(2);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(expect.stringContaining('Prompt here'));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(expect.stringContaining('Answer:\n| a | b |'));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('RENDER:Answer'));
  });

  test('falls back to raw streaming when live render exceeds cap', async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: 'running' };
    const completedMeta: SessionMetadata = { ...baseMeta, status: 'completed' };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    sessionStoreMock.readSession.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const huge = 'A'.repeat(210_000);
    readSessionLogMock.mockResolvedValueOnce(huge).mockResolvedValueOnce(huge);
    waitMock.mockResolvedValue(undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(expect.stringContaining('Prompt here'));
  });

  test('suppresses prompt when renderPrompt is false', async () => {
    readSessionMetadataMock.mockResolvedValue(baseMeta);
    readSessionLogMock.mockResolvedValue('Answer:\nhello');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Hidden prompt' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: true, renderPrompt: false });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Prompt:'));
  });

	  test('shows completion summary with cost and slug when available', async () => {
	    const metaWithUsage: SessionMetadata = {
	      ...baseMeta,
	      status: 'completed',
	      model: 'gpt-5.2-pro',
	      mode: 'api',
	      elapsedMs: 1234,
	      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 1.23 },
	    } as SessionMetadata;
    readSessionMetadataMock.mockResolvedValue(metaWithUsage);
    readSessionLogMock.mockResolvedValue('Answer:\nhello');
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('↑'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('↓'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Δ'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('$1.23'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('slug=sess'));
  });

  test('falls back to metadata prompt when request is missing', async () => {
    readSessionMetadataMock.mockResolvedValue({ ...baseMeta, options: { prompt: 'From meta' } });
    readSessionLogMock.mockResolvedValue('Answer:\nhello');
    readSessionRequestMock.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Prompt:'));
    expect(renderMarkdownMock).toHaveBeenCalledWith('Answer:\nhello');
  });

	  test('prints all per-model logs when multi-model session completes', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        { model: 'gpt-5.2-pro', status: 'completed', usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 } },
	        { model: 'gemini-3-pro', status: 'completed', usage: { inputTokens: 4, outputTokens: 5, reasoningTokens: 0, totalTokens: 9 } },
	      ],
	    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const writeSpy = vi.spyOn(process.stdout, 'write');
	    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

	    sessionStoreMock.readModelLog
	      .mockResolvedValueOnce('Answer:\nfrom gpt-5.2-pro')
	      .mockResolvedValueOnce('Answer:\nfrom gemini');

	    await attachSession('sess', { renderMarkdown: false });

	    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
	    expect(written).toContain('from gpt-5.2-pro');
	    expect(written).toContain('=== gemini-3-pro ===');
	    expect(written).toContain('from gemini');
    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Models:'));
  });

	  test('prints only the selected model log when a model filter is provided', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        { model: 'gpt-5.2-pro', status: 'completed' },
	        { model: 'gemini-3-pro', status: 'completed' },
	      ],
	    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    sessionStoreMock.readSession.mockResolvedValue(multiMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const writeSpy = vi.spyOn(process.stdout, 'write');
    sessionStoreMock.readModelLog
      .mockResolvedValueOnce('Answer:\nfrom gemini only');

	    await attachSession('sess', { renderMarkdown: false, model: 'Gemini-3-Pro' });

	    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
	    expect(written).toContain('from gemini only');
	    expect(written).not.toContain('gpt-5.2-pro');
	    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
	    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith('sess', 'gemini-3-pro');
	  });

	  test('exits with error when requested model is not part of the session', async () => {
	    const multiMeta: SessionMetadata = {
	      ...baseMeta,
	      models: [
	        { model: 'gpt-5.2-pro', status: 'completed' },
	        { model: 'gemini-3-pro', status: 'completed' },
	      ],
	    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(multiMeta);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await attachSession('sess', { model: 'claude-4.5' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Model "claude-4.5" not found'));
    expect(process.exitCode).toBe(1);
    expect(sessionStoreMock.readModelLog).not.toHaveBeenCalled();
  });

	  test('falls back to per-model log when metadata is legacy but filter provided', async () => {
	    const legacyMeta: SessionMetadata = {
	      ...baseMeta,
	      model: 'gpt-5.2-pro',
	      models: undefined,
	    } as SessionMetadata;

    readSessionMetadataMock.mockResolvedValue(legacyMeta);
    sessionStoreMock.readSession.mockResolvedValue(legacyMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt legacy' });
    sessionStoreMock.readModelLog.mockResolvedValue('Answer:\nlegacy per-model');
    const writeSpy = vi.spyOn(process.stdout, 'write');

	    await attachSession('sess', { renderMarkdown: false, model: 'gpt-5.2-pro' });

	    const written = writeSpy.mock.calls.map((c) => c[0]).join('');
	    expect(written).toContain('legacy per-model');
	    expect(sessionStoreMock.readModelLog).toHaveBeenCalledTimes(1);
	    expect(sessionStoreMock.readModelLog).toHaveBeenCalledWith('sess', 'gpt-5.2-pro');
	    expect(sessionStoreMock.readLog).not.toHaveBeenCalled();
	  });
});
