import { describe, expect, test } from 'vitest';
import { buildMarkdownBundle } from '../../src/cli/markdownBundle.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('buildMarkdownBundle', () => {
  test('renders system + user + files into markdown and prompt with files', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'oracle-md-'));
    const filePath = path.join(cwd, 'a.txt');
    await writeFile(filePath, 'hello world', 'utf8');

    const bundle = await buildMarkdownBundle({ prompt: 'Do it', file: [filePath], system: 'SYS' }, { cwd });

    expect(bundle.markdown).toMatch('[SYSTEM]');
    expect(bundle.markdown).toMatch('SYS');
    expect(bundle.markdown).toMatch('[USER]');
    expect(bundle.markdown).toMatch('Do it');
    expect(bundle.markdown).toMatch('[FILE: a.txt]');
    expect(bundle.markdown).toMatch('hello world');
    expect(bundle.promptWithFiles).toContain('Do it');
    expect(bundle.promptWithFiles).toContain('hello world');
    expect(bundle.files).toHaveLength(1);
  });

  test('walks directories and applies excludes in file globs', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'oracle-md-'));
    const keep = path.join(cwd, 'keep.txt');
    const skip = path.join(cwd, 'skip.test.txt');
    await writeFile(keep, 'keep me', 'utf8');
    await writeFile(skip, 'skip me', 'utf8');

    const bundle = await buildMarkdownBundle(
      { prompt: 'Hello', file: [`${cwd}/**/*.txt`, `!${cwd}/**/*.test.txt`] },
      { cwd },
    );

    expect(bundle.markdown).toContain('keep me');
    expect(bundle.markdown).not.toContain('skip me');
  });

  test('handles prompt-only runs (no files) with system/user headers intact', async () => {
    const bundle = await buildMarkdownBundle({ prompt: 'Solo', file: [], system: 'SYS' }, {});
    expect(bundle.markdown).toContain('[SYSTEM]');
    expect(bundle.markdown).toContain('SYS');
    expect(bundle.markdown).toContain('[USER]');
    expect(bundle.markdown).toContain('Solo');
    expect(bundle.markdown).not.toMatch(/\[FILE:/);
    expect(bundle.files).toHaveLength(0);
  });
});
