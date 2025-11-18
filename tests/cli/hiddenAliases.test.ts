import { describe, expect, test, vi } from 'vitest';
import { applyHiddenAliases, type HiddenAliasOptions } from '../../src/cli/hiddenAliases.js';

describe('hidden CLI aliases', () => {
  test('maps --message to prompt when prompt is absent', () => {
    const opts: HiddenAliasOptions = { message: 'alias prompt' };
    applyHiddenAliases(opts);
    expect(opts.prompt).toBe('alias prompt');
  });

  test('does not override explicit prompt with message alias', () => {
    const opts: HiddenAliasOptions = { prompt: 'primary', message: 'secondary' };
    applyHiddenAliases(opts);
    expect(opts.prompt).toBe('primary');
  });

  test('appends include paths to existing file list', () => {
    const opts: HiddenAliasOptions = { file: ['a'], include: ['b', 'c'] };
    applyHiddenAliases(opts);
    expect(opts.file).toEqual(['a', 'b', 'c']);
  });

  test('sets commander values when setter is provided', () => {
    const setOptionValue = vi.fn();
    const opts: HiddenAliasOptions = { include: ['x', 'y'] };
    applyHiddenAliases(opts, setOptionValue);
    expect(opts.file).toEqual(['x', 'y']);
    expect(setOptionValue).toHaveBeenCalledWith('file', ['x', 'y']);
  });
});
