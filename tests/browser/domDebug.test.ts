import { describe, expect, test, vi } from 'vitest';
import { logDomFailure, logConversationSnapshot } from '../../src/browser/domDebug.js';
import type { ChromeClient } from '../../src/browser/types.js';

const makeRuntime = (value: unknown) =>
  ({
    evaluate: vi.fn().mockResolvedValue({ result: { value } }),
  }) as unknown as ChromeClient['Runtime'];

describe('domDebug utilities', () => {
  test('logDomFailure captures snapshot when verbose', async () => {
    const runtime = makeRuntime([{ role: 'assistant', text: 'Hello', testid: 'assistant-1' }]);
    const logger = Object.assign(vi.fn(), { verbose: true, sessionLog: vi.fn() });
    await logDomFailure(runtime, logger, 'test-context');
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Browser automation failure'));
    expect(logger.sessionLog).toHaveBeenCalled();
  });

  test('logConversationSnapshot emits recent entries', async () => {
    const value = [
      { role: 'user', text: 'Hi', testid: 'u1' },
      { role: 'assistant', text: 'Hello', testid: 'a1' },
    ];
    const runtime = makeRuntime(value);
    const logger = vi.fn();
    await logConversationSnapshot(runtime, logger);
    expect(runtime.evaluate).toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Conversation snapshot'));
  });

  test('logDomFailure skips when verbose disabled', async () => {
    const runtime = makeRuntime([]);
    const logger = Object.assign(vi.fn(), { verbose: false });
    await logDomFailure(runtime, logger, 'quiet');
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });
});

