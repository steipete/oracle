import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../src/sessionStore.js';

const mockSessionStore = {
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  sessionsDir: vi.fn(() => '/tmp/sessions'),
  readSession: vi.fn(),
  readModelLog: vi.fn(),
  readLog: vi.fn(),
  readRequest: vi.fn(),
};

vi.mock('../../src/sessionStore.js', () => ({
  sessionStore: mockSessionStore,
  wait: vi.fn(async () => {}),
}));

describe('sessionDisplay helpers', () => {
  beforeEach(() => {
    Object.values(mockSessionStore).forEach((fn) => {
      if ('mockReset' in fn) {
        (fn as unknown as { mockReset: () => void }).mockReset();
      }
    });
  });

  it('prints cleanup tip and examples when no sessions are found', async () => {
    mockSessionStore.listSessions.mockResolvedValue([]);
    mockSessionStore.filterSessions.mockReturnValue({ entries: [], truncated: false, total: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { showStatus } = await import('../../src/cli/sessionDisplay.js');
    await showStatus({ hours: 24, includeAll: false, limit: 10, showExamples: true });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Tip: Run "oracle session --clear --hours 24" to prune cached runs'),
    );
    log.mockRestore();
  }, 15_000);

  it('prints a status table with cost info and truncation notice', async () => {
    const entry = {
      id: 'sess-123',
      status: 'completed',
      createdAt: '2025-11-20T00:00:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'hi' },
      usage: { cost: 0.123 },
    };
    mockSessionStore.listSessions.mockResolvedValue([entry]);
    mockSessionStore.filterSessions.mockReturnValue({ entries: [entry], truncated: true, total: 2 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { showStatus } = await import('../../src/cli/sessionDisplay.js');
    await showStatus({ hours: 24, includeAll: false, limit: 5 });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Recent Sessions'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sess-123'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Showing 1 of 2 sessions'));
    log.mockRestore();
  }, 15_000);

  it('shows follow-up lineage in status rows', async () => {
    const parent = {
      id: 'parent-session',
      status: 'completed',
      createdAt: '2025-11-20T00:00:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'parent' },
      response: { responseId: 'resp_parent_1234' },
    };
    const child = {
      id: 'child-session',
      status: 'completed',
      createdAt: '2025-11-20T00:01:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'child', previousResponseId: 'resp_parent_1234', followupSessionId: 'parent-session' },
    };
    mockSessionStore.listSessions.mockResolvedValue([child, parent]);
    mockSessionStore.filterSessions.mockReturnValue({ entries: [child, parent], truncated: false, total: 2 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { showStatus } = await import('../../src/cli/sessionDisplay.js');
    await showStatus({ hours: 24, includeAll: false, limit: 5 });

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/parent-session/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/└─ child-session/));
    log.mockRestore();
  }, 15_000);

  it('renders nested follow-up branches with stable tree connectors', async () => {
    const parent = {
      id: 'parent-session',
      status: 'completed',
      createdAt: '2025-11-20T00:00:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'parent' },
      response: { responseId: 'resp_parent_1234' },
    };
    const childA = {
      id: 'child-a',
      status: 'completed',
      createdAt: '2025-11-20T00:01:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'child-a', previousResponseId: 'resp_parent_1234', followupSessionId: 'parent-session' },
      response: { responseId: 'resp_child_a_1234' },
    };
    const childB = {
      id: 'child-b',
      status: 'completed',
      createdAt: '2025-11-20T00:02:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'child-b', previousResponseId: 'resp_parent_1234', followupSessionId: 'parent-session' },
    };
    const grandchild = {
      id: 'grandchild-a1',
      status: 'completed',
      createdAt: '2025-11-20T00:03:00.000Z',
      model: 'gpt-5.1',
      options: { prompt: 'grandchild', previousResponseId: 'resp_child_a_1234', followupSessionId: 'child-a' },
    };
    mockSessionStore.listSessions.mockResolvedValue([parent, childA, childB, grandchild]);
    mockSessionStore.filterSessions.mockReturnValue({
      entries: [parent, childA, childB, grandchild],
      truncated: false,
      total: 4,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { showStatus } = await import('../../src/cli/sessionDisplay.js');
    await showStatus({ hours: 24, includeAll: false, limit: 10 });

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/parent-session/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/├─ child-a/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/│  └─ grandchild-a1/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/└─ child-b/));
    log.mockRestore();
  }, 15_000);

  it('formats metadata and completion summaries', async () => {
    const {
      formatResponseMetadata,
      formatTransportMetadata,
      formatUserErrorMetadata,
      buildReattachLine,
      trimBeforeFirstAnswer,
      formatCompletionSummary,
    } = await import('../../src/cli/sessionDisplay.js');

    expect(
      formatResponseMetadata({
        responseId: 'resp',
        requestId: 'req',
        status: 'completed',
        incompleteReason: 'timeout',
      }),
    ).toContain('response=resp');
    expect(formatTransportMetadata({ reason: 'client-timeout' })).toContain('client timeout');
    expect(formatTransportMetadata({ reason: 'unknown' })).toContain('unknown transport failure');
    expect(formatUserErrorMetadata({ category: 'input', message: 'bad', details: { field: 'prompt' } })).toContain(
      'details',
    );

    const started = new Date(Date.now() - 1500).toISOString();
    const reattachMeta: SessionMetadata = {
      id: 's1',
      status: 'running',
      createdAt: started,
      startedAt: started,
      options: {},
    };
    expect(buildReattachLine(reattachMeta)).toContain('reattached');
    expect(trimBeforeFirstAnswer('Intro\nAnswer: final')).toBe('Answer: final');

    const summaryMeta: SessionMetadata = {
      id: 's2',
      status: 'completed',
      createdAt: started,
      model: 'gpt-5.1',
      mode: 'api',
      elapsedMs: 1500,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30, cost: 0.02 },
      options: { file: ['a'] },
    };
    const summary = formatCompletionSummary(summaryMeta, { includeSlug: true });
    expect(summary).toContain('↑10 ↓20 ↻0 Δ30');
    expect(summary).toContain('slug=s2');
  });
});
