import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SessionMetadata } from '../../src/sessionManager.ts';
import {
  buildReattachLine,
  formatResponseMetadata,
  formatTransportMetadata,
  formatUserErrorMetadata,
  trimBeforeFirstAnswer,
  attachSession,
  formatCompletionSummary,
} from '../../src/cli/sessionDisplay.ts';
import chalk from 'chalk';

vi.useFakeTimers();

vi.mock('../../src/sessionManager.ts', () => {
  return {
    readSessionMetadata: vi.fn(),
    readSessionLog: vi.fn(),
    readSessionRequest: vi.fn(),
    wait: vi.fn(),
    listSessionsMetadata: vi.fn(),
    filterSessionsByRange: vi.fn(),
    // biome-ignore lint/style/useNamingConvention: mimic exported constant name
    SESSIONS_DIR: '/tmp/sessions',
  };
});

vi.mock('../../src/cli/markdownRenderer.ts', () => {
  return {
    renderMarkdownAnsi: vi.fn((s: string) => `RENDER:${s}`),
  };
});

const sessionManagerMock = await import('../../src/sessionManager.ts');
const markdownMock = await import('../../src/cli/markdownRenderer.ts');
const renderMarkdownMock = markdownMock.renderMarkdownAnsi as unknown as { mockClear?: () => void };
const readSessionMetadataMock = sessionManagerMock.readSessionMetadata as unknown as ReturnType<typeof vi.fn>;
const readSessionLogMock = sessionManagerMock.readSessionLog as unknown as ReturnType<typeof vi.fn>;
const readSessionRequestMock = sessionManagerMock.readSessionRequest as unknown as ReturnType<typeof vi.fn>;
const _readSessionRequestMock = sessionManagerMock.readSessionRequest as unknown as ReturnType<typeof vi.fn>;

const originalIsTty = process.stdout.isTTY;
const originalChalkLevel = chalk.level;

beforeEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  chalk.level = 1;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
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
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    readSessionLogMock
      .mockResolvedValueOnce('Answer:\n| a | b |\n')
      .mockResolvedValueOnce('Answer:\n| a | b |\n| c | d |\n\nDone\n');
    const writeSpy = vi.spyOn(process.stdout, 'write');
    (sessionManagerMock.wait as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(3);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenNthCalledWith(1, expect.stringContaining('Prompt here'));
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenNthCalledWith(2, 'Answer:\n| a | b |\n| c | d |\n\n');
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenNthCalledWith(3, 'Done\n');
    expect(writeSpy).toHaveBeenCalledWith('RENDER:Answer:\n| a | b |\n| c | d |\n\n');
    expect(writeSpy).toHaveBeenCalledWith('RENDER:Done\n');
  });

  test('falls back to raw streaming when live render exceeds cap', async () => {
    const runningMeta: SessionMetadata = { ...baseMeta, status: 'running' };
    const completedMeta: SessionMetadata = { ...baseMeta, status: 'completed' };
    readSessionMetadataMock.mockResolvedValueOnce(runningMeta).mockResolvedValueOnce(completedMeta);
    readSessionRequestMock.mockResolvedValue({ prompt: 'Prompt here' });
    const huge = 'A'.repeat(210_000);
    readSessionLogMock.mockResolvedValueOnce(huge);
    const writeSpy = vi.spyOn(process.stdout, 'write');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    (sessionManagerMock.wait as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await attachSession('sess', { renderMarkdown: true });

    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledTimes(1);
    expect(markdownMock.renderMarkdownAnsi).toHaveBeenCalledWith(expect.stringContaining('Prompt here'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Render skipped'));
    expect(writeSpy).toHaveBeenCalledWith(huge);
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
      model: 'gpt-5-pro',
      mode: 'api',
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 1.23 },
    } as SessionMetadata;
    const summary = formatCompletionSummary(metaWithUsage, { includeSlug: true });
    expect(summary).not.toBeNull();
    expect(summary).toContain('Finished in');
    expect(summary).toContain('$1.23');
    expect(summary).toContain('slug=sess');
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
});
