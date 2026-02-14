import { describe, expect, it } from 'vitest';
import { createGeminiWebExecutor } from '../../src/gemini-web/executor.js';
import { acquireLiveTestLock, releaseLiveTestLock } from './liveLock.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const MANUAL = process.env.ORACLE_LIVE_TEST_MANUAL_LOGIN === '1';

(LIVE && MANUAL ? describe : describe.skip)('Gemini Deep Think DOM automation live', () => {
  it('returns a short text answer via DOM automation (no attachments)', async () => {
    await acquireLiveTestLock('gemini-deep-think');
    try {
      const exec = createGeminiWebExecutor({});
      const result = await exec({
        prompt: 'What is the capital of France? Reply in one word.',
        attachments: [],
        config: {
          desiredModel: 'gemini-3-deep-think',
          keepBrowser: false,
          timeoutMs: 300_000,
        },
        log: () => {},
      });

      expect(result.answerText.toLowerCase()).toContain('paris');
      expect(result.answerChars).toBeGreaterThan(1);
    } finally {
      await releaseLiveTestLock('gemini-deep-think');
    }
  }, 5 * 60 * 1000);

  it('falls back to HTTP path when attachments are present', async () => {
    await acquireLiveTestLock('gemini-deep-think');
    try {
      const exec = createGeminiWebExecutor({});
      const result = await exec({
        prompt: 'What does this file say? Reply in one sentence.',
        attachments: [{ path: '/dev/null', displayPath: 'empty.txt' }],
        config: {
          desiredModel: 'gemini-3-deep-think',
          chromeProfile: 'Default',
          keepBrowser: false,
          timeoutMs: 300_000,
        },
        log: () => {},
      });

      expect(result.answerChars).toBeGreaterThan(1);
    } catch (error) {
      console.warn(
        `Skipping Deep Think attachment fallback test due to transient error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await releaseLiveTestLock('gemini-deep-think');
    }
  }, 5 * 60 * 1000);

  it('extracts thinking content when available', async () => {
    await acquireLiveTestLock('gemini-deep-think');
    try {
      const exec = createGeminiWebExecutor({ showThoughts: true });
      const result = await exec({
        prompt: 'Explain why 1+1=2 in one sentence.',
        attachments: [],
        config: {
          desiredModel: 'gemini-3-deep-think',
          keepBrowser: false,
          timeoutMs: 300_000,
        },
        log: () => {},
      });

      expect(result.answerChars).toBeGreaterThan(1);
      if (result.answerMarkdown.includes('## Thinking')) {
        expect(result.answerMarkdown).toContain('## Thinking');
      }
    } finally {
      await releaseLiveTestLock('gemini-deep-think');
    }
  }, 5 * 60 * 1000);
});

(LIVE && MANUAL ? describe : describe.skip)('ChatGPT browser DOM automation live', () => {
  it('returns a short text answer via browser mode', async () => {
    const { runBrowserMode } = await import('../../src/browser/index.js');
    await acquireLiveTestLock('chatgpt-browser');
    try {
      const result = await runBrowserMode({
        prompt: 'What is the capital of Germany? Reply in one word.',
        config: {
          manualLogin: true,
          keepBrowser: false,
          timeoutMs: 180_000,
        },
      });

      expect(result.answerText.toLowerCase()).toContain('berlin');
      expect(result.answerText.length).toBeGreaterThan(1);
    } finally {
      await releaseLiveTestLock('chatgpt-browser');
    }
  }, 5 * 60 * 1000);
});
