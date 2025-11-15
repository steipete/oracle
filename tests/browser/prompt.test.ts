import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { assembleBrowserPrompt } from '../../src/browser/prompt.js';
import type { RunOracleOptions } from '../../src/oracle.js';

function buildOptions(overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  return {
    prompt: overrides.prompt ?? 'Explain the bug',
    model: overrides.model ?? 'gpt-5-pro',
    file: overrides.file ?? ['a.txt'],
    system: overrides.system,
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
    expect(result.estimatedInputTokens).toBeGreaterThan(0);
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
  });
});
