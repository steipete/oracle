import { describe, expect, test, vi } from 'vitest';
import { shouldBlockDuplicatePrompt } from '../../src/cli/duplicatePromptGuard.js';
import type { SessionStore, SessionMetadata } from '../../src/sessionStore.js';

const makeStore = (sessions: Partial<SessionMetadata>[]): SessionStore =>
  ({
    listSessions: vi.fn().mockResolvedValue(
      sessions.map((s, idx) => ({
        id: `sess-${idx + 1}`,
        status: 'running',
        createdAt: new Date().toISOString(),
        options: {},
        ...s,
      })),
    ),
  } as unknown as SessionStore);

describe('shouldBlockDuplicatePrompt', () => {
  test('allows when no running session matches prompt', async () => {
    const store = makeStore([{ options: { prompt: 'other prompt' } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: 'target prompt',
      force: false,
      sessionStore: store,
      log: vi.fn(),
    });
    expect(blocked).toBe(false);
  });

  test('blocks when identical prompt is already running', async () => {
    const log = vi.fn();
    const store = makeStore([{ options: { prompt: 'same prompt' } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: 'same prompt',
      force: false,
      sessionStore: store,
      log,
    });
    expect(blocked).toBe(true);
    expect(log).toHaveBeenCalled();
  });

  test('allows duplicate prompt when force is true', async () => {
    const store = makeStore([{ options: { prompt: 'same prompt' } }]);
    const blocked = await shouldBlockDuplicatePrompt({
      prompt: 'same prompt',
      force: true,
      sessionStore: store,
      log: vi.fn(),
    });
    expect(blocked).toBe(false);
  });
});
