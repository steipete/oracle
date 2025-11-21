import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildPrompt,
  renderPromptMarkdown,
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  buildRequestBody,
  extractTextOutput,
  formatUSD,
  formatNumber,
  formatElapsed,
  getFileTokenStats,
  printFileTokenStats,
} from '../../src/oracle.ts';
import { collectPaths, parseIntOption } from '../../src/cli/options.ts';
import { createMockFs, createTempFile } from './helpers.ts';

const testNonWindows = process.platform === 'win32' ? test.skip : test;

describe('buildPrompt', () => {
  test('includes attached file sections with relative paths', async () => {
    const { dir, filePath } = await createTempFile('hello from file');
    try {
      const prompt = buildPrompt('Base', [{ path: filePath, content: 'hello from file' }], dir);
      expect(prompt).toContain('### File 1: sample.txt');
      expect(prompt).toContain('hello from file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderPromptMarkdown', () => {
  test('emits markdown bundle with system and files', async () => {
    const { dir, filePath } = await createTempFile('rendered content');
    try {
      const markdown = await renderPromptMarkdown(
        {
          prompt: 'Hello world',
          file: [filePath],
        },
        { cwd: dir },
      );
      expect(markdown).toContain('[SYSTEM]');
      expect(markdown).toContain('[USER]');
      expect(markdown).toContain('### File: sample.txt');
      expect(markdown).toContain('rendered content');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('warns when render-markdown exceeds token threshold', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'oracle-warn-'));
    const filePath = path.join(cwd, 'big.txt');
    const chunk = 'a'.repeat(50_000);
    await writeFile(filePath, chunk.repeat(4), 'utf8'); // ~200k chars → ~50k tokens
    const logs: string[] = [];
    try {
      await renderPromptMarkdown(
        {
          prompt: 'Hello world',
          file: [filePath],
        },
        { cwd },
      );
      const { warnIfOversizeBundle } = await import('../../src/cli/bundleWarnings.js');
      const warned = warnIfOversizeBundle(200_000, 196_000, (msg: string) => logs.push(msg));
      expect(warned).toBe(true);
      expect(logs.join('\n')).toMatch(/Warning: bundle is ~200,000 tokens/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('oracle utility helpers', () => {
  test('collectPaths flattens inputs and trims whitespace', () => {
    const result = collectPaths([' alpha, beta ', 'gamma', '']);
    expect(result).toEqual(['alpha', 'beta', 'gamma']);
    const unchanged = collectPaths(undefined, ['start']);
    expect(unchanged).toEqual(['start']);
  });

  test('collectPaths honors multiple flags and comma-separated batches', () => {
    const initial = collectPaths(['src/docs', 'tests,examples'], []);
    expect(initial).toEqual(['src/docs', 'tests', 'examples']);
    const appended = collectPaths(['more', 'assets,notes'], initial);
    expect(appended).toEqual(['src/docs', 'tests', 'examples', 'more', 'assets', 'notes']);
  });

  test('parseIntOption handles undefined and invalid values', () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption('42')).toBe(42);
    expect(() => parseIntOption('not-a-number')).toThrow('Value must be an integer.');
  });

  testNonWindows('readFiles deduplicates and expands directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-'));
    try {
      const nestedDir = path.join(dir, 'nested');
      await mkdir(nestedDir, { recursive: true });
      const nestedFile = path.join(nestedDir, 'note.txt');
      await writeFile(nestedFile, 'nested', 'utf8');

      const duplicateFiles = await readFiles([nestedFile, nestedFile], { cwd: dir });
      expect(duplicateFiles).toHaveLength(1);
      expect(duplicateFiles[0].content).toBe('nested');

      const expandedFiles = await readFiles([dir], { cwd: dir });
      expect(expandedFiles.map((file) => path.basename(file.path))).toContain('note.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles rejects immediately when a referenced file is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-missing-'));
    try {
      await expect(readFiles(['ghost.txt'], { cwd: dir })).rejects.toThrow(/Missing file or directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles respects glob include/exclude syntax and size limits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-glob-'));
    try {
      const nestedDir = path.join(dir, 'src', 'nested');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(dir, 'src', 'alpha.ts'), 'alpha', 'utf8');
      await writeFile(path.join(dir, 'src', 'beta.test.ts'), 'beta', 'utf8');
      await writeFile(path.join(nestedDir, 'gamma.ts'), 'gamma', 'utf8');

      const files = await readFiles(['src/**/*.ts', '!src/**/*.test.ts'], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('alpha.ts');
      expect(basenames).toContain('gamma.ts');
      expect(basenames).not.toContain('beta.test.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles skips dotfiles by default when expanding directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-dot-'));
    try {
      const dotFile = path.join(dir, '.env');
      const visibleFile = path.join(dir, 'app.ts');
      await writeFile(dotFile, 'SECRET=1', 'utf8');
      await writeFile(visibleFile, 'console.log(1)', 'utf8');

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('app.ts');
      expect(basenames).not.toContain('.env');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles can opt-in to dotfiles with explicit globs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-dot-include-'));
    try {
      const dotFile = path.join(dir, '.env');
      await writeFile(dotFile, 'SECRET=1', 'utf8');

      const files = await readFiles(['**/.env'], { cwd: dir });
      expect(files).toHaveLength(1);
      expect(path.basename(files[0].path)).toBe('.env');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles honors .gitignore when present', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-gitignore-'));
    try {
      const gitignore = path.join(dir, '.gitignore');
      const ignoredFile = path.join(dir, 'secret.log');
      const nestedIgnored = path.join(dir, 'build', 'asset.js');
      const keptFile = path.join(dir, 'kept.txt');
      await mkdir(path.join(dir, 'dist'), { recursive: true });
      await mkdir(path.join(dir, 'build'), { recursive: true });
      await writeFile(gitignore, 'secret.log\nbuild/\n', 'utf8');
      await writeFile(ignoredFile, 'should skip', 'utf8');
      await writeFile(nestedIgnored, 'ignored build asset', 'utf8');
      await writeFile(keptFile, 'keep me', 'utf8');

      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('kept.txt');
      expect(basenames).not.toContain('secret.log');
      expect(basenames).not.toContain('asset.js');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles honors nested .gitignore files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-gitignore-nested-'));
    try {
      const subdir = path.join(dir, 'dist');
      await mkdir(subdir, { recursive: true });
      await writeFile(path.join(subdir, '.gitignore'), '*.map\n', 'utf8');
      const ignored = path.join(subdir, 'bundle.js.map');
      const kept = path.join(subdir, 'bundle.js');
      await writeFile(ignored, 'ignored', 'utf8');
      await writeFile(kept, 'kept', 'utf8');

      const files = await readFiles([path.join(dir, 'dist')], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('bundle.js');
      expect(basenames).not.toContain('bundle.js.map');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles skips default-ignored dirs when walking project roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-ignore-default-'));
    try {
      const nodeModules = path.join(dir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      const ignoredFile = path.join(nodeModules, 'leftpad.ts');
      const keptFile = path.join(dir, 'src', 'index.ts');
      await mkdir(path.dirname(keptFile), { recursive: true });
      await writeFile(ignoredFile, 'ignored', 'utf8');
      await writeFile(keptFile, 'kept', 'utf8');

      const logSpy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const files = await readFiles(['**/*.ts'], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('index.ts');
      expect(basenames).not.toContain('leftpad.ts');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('node_modules'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles allows explicitly passed default-ignored dirs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-allow-default-'));
    try {
      const nodeModules = path.join(dir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      const filePath = path.join(nodeModules, 'package.json');
      await writeFile(filePath, '{"name":"ok"}', 'utf8');

      const files = await readFiles([nodeModules], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));
      expect(basenames).toContain('package.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  testNonWindows('readFiles logs and skips default-ignored dirs under project roots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-ignore-logs-'));
    const ignoredDirs = ['node_modules', 'dist', 'coverage'];
    try {
      for (const ignored of ignoredDirs) {
        const ignoredDir = path.join(dir, ignored);
        await mkdir(ignoredDir, { recursive: true });
        await writeFile(path.join(ignoredDir, `${ignored}-ignored.txt`), 'ignored', 'utf8');
      }
      const keepFile = path.join(dir, 'src', 'keep.ts');
      await mkdir(path.dirname(keepFile), { recursive: true });
      await writeFile(keepFile, 'keep', 'utf8');

      const { vi } = await import('vitest');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const files = await readFiles([dir], { cwd: dir });
      const basenames = files.map((file) => path.basename(file.path));

      expect(basenames).toContain('keep.ts');
      for (const ignored of ignoredDirs) {
        expect(basenames.some((name) => name.includes(`${ignored}-ignored.txt`))).toBe(false);
        const logged = logSpy.mock.calls.flat().some((arg) => String(arg ?? '').includes(ignored));
        expect(logged).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('readFiles rejects files larger than 1 MB', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'oracle-readfiles-large-'));
    try {
      const largeFile = path.join(dir, 'huge.bin');
      await writeFile(largeFile, 'a'.repeat(1_200_000), 'utf8');
      await expect(readFiles([largeFile], { cwd: dir })).rejects.toThrow(/exceed the 1 MB limit/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('createFileSections renders relative paths', () => {
    const sections = createFileSections([{ path: '/tmp/example/file.txt', content: 'contents' }], '/tmp/example');
    expect(sections[0].displayPath).toBe('file.txt');
    expect(sections[0].sectionText).toContain('### File 1: file.txt');
  });

  test('buildRequestBody respects search toggles', () => {
    const base = buildRequestBody({
      modelConfig: MODEL_CONFIGS['gpt-5.1-pro'],
      systemPrompt: 'sys',
      userPrompt: 'user',
      searchEnabled: false,
      maxOutputTokens: 222,
    });
    expect(base.tools).toBeUndefined();
    expect(base.max_output_tokens).toBe(222);

    const withSearch = buildRequestBody({
      modelConfig: MODEL_CONFIGS['gpt-5.1'],
      systemPrompt: 'sys',
      userPrompt: 'user',
      searchEnabled: true,
      maxOutputTokens: undefined,
    });
    expect(withSearch.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(withSearch.reasoning).toEqual({ effort: 'high' });
  });

  test('extractTextOutput combines multiple event styles', () => {
    const responseWithOutputText = {
      output_text: ['First chunk', 'Second chunk'],
      output: [],
    };
    expect(extractTextOutput(responseWithOutputText)).toBe('First chunk\nSecond chunk');

    const responseWithMessages = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'output_text', text: 'World' },
          ],
        },
        {
          type: 'output_text',
          text: '!!!',
        },
      ],
    };
    expect(extractTextOutput(responseWithMessages)).toBe('Hello\nWorld\n!!!');
  });

  test('formatting helpers render friendly output', () => {
    expect(formatUSD(12.345)).toBe('$12.3450');
    expect(formatUSD(0.05)).toBe('$0.0500');
    expect(formatUSD(0.000123)).toBe('$0.0001');
    expect(formatUSD(Number.NaN)).toBe('n/a');

    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(4200, { estimated: true })).toBe('4,200 (est.)');
    expect(formatNumber(null)).toBe('n/a');

    expect(formatElapsed(12345)).toBe('12.35s');
    expect(formatElapsed(125000)).toBe('2m 5s');
  });

  test('getFileTokenStats orders files by tokens and reports totals', () => {
    const files = [
      { path: '/tmp/a.txt', content: 'aaa' },
      { path: '/tmp/b.txt', content: 'bbbbbb' },
    ];
    const tokenizer = (input: unknown) => String(input).length;
    const { stats, totalTokens } = getFileTokenStats(files, {
      cwd: '/tmp',
      tokenizer,
      tokenizerOptions: {},
      inputTokenBudget: 100,
    });
    expect(totalTokens).toBeGreaterThan(0);
    expect(stats[0].displayPath).toBe('b.txt');
    expect(stats[1].displayPath).toBe('a.txt');

    const logs: string[] = [];
    printFileTokenStats({ stats, totalTokens }, { inputTokenBudget: 100, log: (msg: string) => logs.push(msg) });
    expect(logs[0]).toBe('File Token Usage');
    expect(logs.some((line) => line.includes('Total:'))).toBe(true);
  });
});
