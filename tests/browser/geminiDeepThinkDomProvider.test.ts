import { describe, expect, it, vi, afterEach } from 'vitest';
import { geminiDeepThinkDomProvider } from '../../src/browser/providers/geminiDeepThinkDomProvider.js';

describe('geminiDeepThinkDomProvider timeouts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses inputTimeoutMs for UI readiness', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForUi({
        prompt: 'hello',
        evaluate: async <T>() => ({ ready: false, requiresLogin: false } as T),
        delay: async (ms) => { now += ms; },
        state: { inputTimeoutMs: 2_000 },
      }),
    ).rejects.toThrow('Timed out waiting for Gemini UI prompt input to become ready.');
  });

  it('uses timeoutMs for response polling', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    await expect(
      geminiDeepThinkDomProvider.waitForResponse({
        prompt: 'hello',
        evaluate: async <T>() => (JSON.stringify({ status: 'generating' }) as T),
        delay: async (ms) => { now += ms; },
        state: { timeoutMs: 4_000 },
      }),
    ).rejects.toThrow('Deep Think timed out waiting for response (4 seconds).');
  });
});
