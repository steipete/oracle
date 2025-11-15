import { describe, expect, test, vi } from 'vitest';
import type { RunOracleOptions } from '../../src/oracle.js';
import type { BrowserSessionConfig } from '../../src/sessionManager.js';
import { runBrowserSessionExecution } from '../../src/browser/sessionRunner.js';

const baseRunOptions: RunOracleOptions = {
  prompt: 'Hello world',
  model: 'gpt-5-pro',
  file: [],
  silent: false,
};

const baseConfig: BrowserSessionConfig = {};

describe('runBrowserSessionExecution', () => {
  test('logs stats and returns usage/runtime', async () => {
    const log = vi.fn();
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
        cliVersion: '1.0.0',
      },
      {
        assemblePrompt: async () => ({ markdown: 'prompt', estimatedInputTokens: 42 }),
        executeBrowser: async () => ({
          answerText: 'ok',
          answerMarkdown: 'ok',
          tookMs: 1000,
          answerTokens: 12,
          answerChars: 20,
        }),
      },
    );
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 12, reasoningTokens: 0, totalTokens: 54 });
    expect(result.runtime).toMatchObject({ chromePid: undefined });
    expect(log).toHaveBeenCalled();
  });

  test('respects verbose logging', async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: { keepBrowser: true },
        cwd: '/repo',
        log,
        cliVersion: '1.0.0',
      },
      {
        assemblePrompt: async () => ({ markdown: 'prompt', estimatedInputTokens: 1 }),
        executeBrowser: async () => ({
          answerText: 'text',
          answerMarkdown: 'markdown',
          tookMs: 10,
          answerTokens: 1,
          answerChars: 5,
        }),
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes('[verbose]'))).toBe(true);
  });
});
