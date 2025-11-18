import { describe, expect, test } from 'vitest';
import { shouldRequirePrompt } from '../../src/cli/promptRequirement.js';
import { resolvePreviewMode } from '../../src/cli/options.js';

describe('no prompt help', () => {
  test('requires prompt for root command when nothing else provided', () => {
    const requires = shouldRequirePrompt([], {});
    expect(requires).toBe(true);
  });

  test('message alias satisfies prompt requirement', () => {
    const rawArgs = ['--preview'];
    const opts = { preview: resolvePreviewMode(true), prompt: undefined, message: 'via message' } as {
      preview: string;
      prompt?: string;
      message?: string;
    };
    // simulate hidden alias normalization
    if (!opts.prompt && opts.message) {
      opts.prompt = opts.message;
    }
    const requires = shouldRequirePrompt(rawArgs, opts);
    expect(requires).toBe(false);
  });

  test('positional prompt prevents help trigger', () => {
    const requires = shouldRequirePrompt(['Hello world'], { prompt: 'Hello world' });
    expect(requires).toBe(false);
  });

  test('preview still requires prompt when absent', () => {
    const opts = { preview: resolvePreviewMode(true) } as { preview: string; prompt?: string };
    const requires = shouldRequirePrompt([], opts);
    expect(requires).toBe(true);
  });
});
