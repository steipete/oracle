import { describe, expect, test, vi } from 'vitest';
import type { RunOracleOptions } from '../../src/oracle.js';
import type { BrowserSessionConfig } from '../../src/sessionStore.js';
import { runBrowserSessionExecution } from '../../src/browser/sessionRunner.js';

const baseRunOptions: RunOracleOptions = {
  prompt: 'Hello world',
  model: 'gpt-5.1-pro',
  file: [],
  silent: false,
};

const baseConfig: BrowserSessionConfig = {};

describe('runBrowserSessionExecution', () => {
  test('logs stats and returns usage/runtime', async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        chromePort: 9999,
        chromeHost: '127.0.0.1',
        chromeTargetId: 't-1',
        tabUrl: 'https://chatgpt.com/c/foo',
      });
      return {
        answerText: 'ok',
        answerMarkdown: 'ok',
        tookMs: 1000,
        answerTokens: 12,
        answerChars: 20,
      };
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 12, reasoningTokens: 0, totalTokens: 54 });
    expect(result.runtime).toMatchObject({ chromePid: undefined });
    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({ chromePort: 9999, chromeHost: '127.0.0.1', chromeTargetId: 't-1' }),
    );
    expect(log).toHaveBeenCalled();
  });

  test('suppresses automation noise when not verbose', async () => {
    const log = vi.fn();
    const noisyLogger = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.('Prompt textarea ready');
          noisyLogger();
          return { answerText: 'text', answerMarkdown: 'markdown', tookMs: 1, answerTokens: 1, answerChars: 4 };
        },
      },
    );
    expect(log.mock.calls.some((call) => /Launching browser mode/.test(String(call[0])))).toBe(true);
    expect(log.mock.calls.some((call) => /Prompt textarea ready/.test(String(call[0])))).toBe(false);
    expect(noisyLogger).toHaveBeenCalled(); // ensure executeBrowser ran
  });

  test('prints fallback retry logs even when not verbose', async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.('[browser] Inline prompt too large; retrying with file uploads.');
          return { answerText: 'text', answerMarkdown: 'markdown', tookMs: 1, answerTokens: 1, answerChars: 4 };
        },
      },
    );
    expect(
      log.mock.calls.some((call) => String(call[0]).includes('Inline prompt too large; retrying')),
    ).toBe(true);
  });

  test('passes fallback submission through to browser runner', async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: 'text',
      answerMarkdown: 'markdown',
      tookMs: 1,
      answerTokens: 1,
      answerChars: 4,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: {
            composerText: 'fallback prompt',
            attachments: [{ path: '/repo/a.txt', displayPath: 'a.txt', sizeBytes: 1 }],
            bundled: null,
          },
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackSubmission: {
          prompt: 'fallback prompt',
          attachments: [expect.objectContaining({ path: '/repo/a.txt', displayPath: 'a.txt' })],
        },
      }),
    );
  });

  test('respects verbose logging', async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: { keepBrowser: true },
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 1,
          attachments: [{ path: '/repo/a.txt', displayPath: 'a.txt', sizeBytes: 1024 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'upload',
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: 'text',
          answerMarkdown: 'markdown',
          tookMs: 10,
          answerTokens: 1,
          answerChars: 5,
        }),
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes('Browser attachments'))).toBe(true);
  });

  test('verbose output spells out token labels', async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: 'text',
          answerMarkdown: 'markdown',
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls.map((c) => String(c[0])).find((line) => line.startsWith('Finished in '));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain('tokens (input/output/reasoning/total)=');
  });

  test('non-verbose output keeps short token label', async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: 'text',
          answerMarkdown: 'markdown',
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls.map((c) => String(c[0])).find((line) => line.startsWith('Finished in '));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain('tok(i/o/r/t)=');
    expect(finishedLine).not.toContain('tokens (input/output/reasoning/total)=');
  });

  test('passes heartbeat interval through to browser runner', async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: 'text',
      answerMarkdown: 'markdown',
      tookMs: 10,
      answerTokens: 1,
      answerChars: 5,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, heartbeatIntervalMs: 15_000 },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatIntervalMs: 15_000 }),
    );
  });

  test('allows Gemini in browser mode with custom executor', async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn().mockResolvedValue({
      answerText: 'gemini response',
      answerMarkdown: 'gemini response',
      tookMs: 100,
      answerTokens: 5,
      answerChars: 15,
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, model: 'gemini-3-pro' },
        browserConfig: baseConfig,
        cwd: '/repo',
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: 'prompt',
          composerText: 'prompt',
          estimatedInputTokens: 1,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: 'auto',
          attachmentMode: 'inline',
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(result.answerText).toBe('gemini response');
    expect(executeBrowser).toHaveBeenCalled();
  });
});
