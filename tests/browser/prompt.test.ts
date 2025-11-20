import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { assembleBrowserPrompt } from '../../src/browser/prompt.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/oracle.js';
import type { RunOracleOptions } from '../../src/oracle.js';

function buildOptions(overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  return {
    prompt: overrides.prompt ?? 'Explain the bug',
    model: overrides.model ?? 'gpt-5.1-pro',
    file: overrides.file ?? ['a.txt'],
    system: overrides.system,
    browserInlineFiles: overrides.browserInlineFiles,
  } as RunOracleOptions;
}

describe('assembleBrowserPrompt', () => {
  test('builds markdown bundle with system/user/file blocks', async () => {
    const options = buildOptions();
    const result = await assembleBrowserPrompt(options, {
      cwd: '/repo',
      readFilesImpl: async () => [{ path: '/repo/a.txt', content: 'console.log("hi")\n' }],
    });
    expect(result.markdown).toContain('[SYSTEM]');
    expect(result.markdown).toContain('[USER]');
    expect(result.markdown).toContain('[FILE: a.txt]');
    expect(result.composerText).not.toContain(DEFAULT_SYSTEM_PROMPT);
    expect(result.composerText).toBe('Explain the bug');
    expect(result.composerText).not.toContain('[SYSTEM]');
    expect(result.composerText).not.toContain('[USER]');
    expect(result.composerText).not.toContain('[FILE:');
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
    expect(result.attachments).toEqual([
      expect.objectContaining({ path: '/repo/a.txt', displayPath: 'a.txt' }),
    ]);
    expect(result.inlineFileCount).toBe(0);
    expect(result.tokenEstimateIncludesInlineFiles).toBe(false);
  });

  test('respects custom cwd and multiple files', async () => {
    const options = buildOptions({ file: ['docs/one.md', 'docs/two.md'] });
    const result = await assembleBrowserPrompt(options, {
      cwd: '/root/project',
      readFilesImpl: async (paths) =>
        paths.map((entry, index) => ({ path: path.resolve('/root/project', entry), content: `file-${index}` })),
    });
    expect(result.markdown).toContain('[FILE: docs/one.md]');
    expect(result.markdown).toContain('[FILE: docs/two.md]');
    expect(result.composerText).not.toContain('[FILE: docs/one.md]');
    expect(result.composerText).not.toContain('[FILE: docs/two.md]');
    expect(result.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: path.resolve('/root/project', 'docs/one.md'), displayPath: 'docs/one.md' }),
        expect.objectContaining({ path: path.resolve('/root/project', 'docs/two.md'), displayPath: 'docs/two.md' }),
      ]),
    );
  });

  test('inlines files when browserInlineFiles enabled', async () => {
    const options = buildOptions({ file: ['a.txt'], browserInlineFiles: true } as Partial<RunOracleOptions>);
    const result = await assembleBrowserPrompt(options as RunOracleOptions, {
      cwd: '/repo',
      readFilesImpl: async () => [{ path: '/repo/a.txt', content: 'inline test' }],
    });
    expect(result.composerText).toContain('[FILE: a.txt]');
    expect(result.composerText).not.toContain('[SYSTEM]');
    expect(result.composerText).not.toContain('[USER]');
    expect(result.attachments).toEqual([]);
    expect(result.inlineFileCount).toBe(1);
    expect(result.tokenEstimateIncludesInlineFiles).toBe(true);
  });

  test('inline file mode increases token estimates', async () => {
    const baseOptions = buildOptions({ file: ['doc.md'] });
    const readFilesImpl = async () => [{ path: '/repo/doc.md', content: 'hello world' }];
    const base = await assembleBrowserPrompt(baseOptions, { cwd: '/repo', readFilesImpl });
    const inline = await assembleBrowserPrompt(
      { ...baseOptions, browserInlineFiles: true } as RunOracleOptions,
      { cwd: '/repo', readFilesImpl },
    );
    expect(inline.estimatedInputTokens).toBeGreaterThanOrEqual(base.estimatedInputTokens);
    expect(inline.tokenEstimateIncludesInlineFiles).toBe(true);
  });

  test('bundles attachments when more than 10 files', async () => {
    const fileNames = Array.from({ length: 11 }, (_, i) => `file${i + 1}.txt`);
    const options = buildOptions({ file: fileNames });
    const result = await assembleBrowserPrompt(options, {
      cwd: '/repo',
      readFilesImpl: async (paths) =>
        paths.map((entry) => ({
          path: path.resolve('/repo', entry),
          content: `content for ${entry}`,
        })),
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.displayPath).toMatch(/attachments-bundle\.txt$/);
    expect(result.inlineFileCount).toBe(0);
    expect(result.bundled).toEqual({
      originalCount: 11,
      bundlePath: result.attachments[0]?.displayPath,
    });
  });
});
