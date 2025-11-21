import { describe, expect, test, vi } from 'vitest';
import { runDryRunSummary } from '../../src/cli/dryRun.js';
import type { RunOracleOptions } from '../../src/oracle/types.js';

const baseRunOptions: RunOracleOptions = {
  prompt: 'Do it',
  system: 'SYS',
  file: [],
  model: 'gpt-5.1-pro',
};

describe('runDryRunSummary', () => {
  test('api dry run logs when no files match', async () => {
    const log = vi.fn();
    const readFilesImpl = vi.fn().mockResolvedValue([]);

    await runDryRunSummary(
      { engine: 'api', runOptions: baseRunOptions, cwd: '/repo', version: '1.3.0', log },
      { readFilesImpl },
    );

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Oracle (1.3.0) would call gpt-5.1-pro'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No files matched'));
  });

  test('browser dry run with bundled attachments logs bundle info and cookie source', async () => {
    const log = vi.fn();
    const assembleBrowserPromptImpl = vi.fn().mockResolvedValue({
      markdown: '[SYSTEM]\n[USER]',
      composerText: 'Do it',
      estimatedInputTokens: 1234,
      attachments: [{ path: '/tmp/bundle.txt', displayPath: '/tmp/bundle.txt', sizeBytes: 42 }],
      inlineFileCount: 0,
      tokenEstimateIncludesInlineFiles: false,
      bundled: { originalCount: 3, bundlePath: '/tmp/bundle.txt' },
    });

    await runDryRunSummary(
      {
        engine: 'browser',
        runOptions: { ...baseRunOptions, browserBundleFiles: true },
        cwd: '/repo',
        version: '1.3.0',
        log,
        browserConfig: {
          inlineCookies: [{ name: 'a', value: 'b', domain: 'chatgpt.com' }],
          inlineCookiesSource: 'test',
          cookieNames: [],
        },
      },
      { assembleBrowserPromptImpl },
    );

    const joined = log.mock.calls.flat().join('\n');
    expect(joined).toContain('Bundled upload');
    expect(joined).toContain('bundled 3 files');
    expect(joined).toContain('Cookies: inline payload (1) via test');
  });

  test('browser dry run falls back to inline composer summary when no attachments', async () => {
    const log = vi.fn();
    const assembleBrowserPromptImpl = vi.fn().mockResolvedValue({
      markdown: '[SYSTEM]\n[USER]',
      composerText: 'Inline content',
      estimatedInputTokens: 500,
      attachments: [],
      inlineFileCount: 2,
      tokenEstimateIncludesInlineFiles: true,
      bundled: null,
    });

    await runDryRunSummary(
      {
        engine: 'browser',
        runOptions: baseRunOptions,
        cwd: '/repo',
        version: '1.3.0',
        log,
        browserConfig: { cookieSync: false },
      },
      { assembleBrowserPromptImpl },
    );

    const joined = log.mock.calls.flat().join('\n');
    expect(joined).toContain('Inline file content');
    expect(joined).toContain('cookie-sync');
  });
});
