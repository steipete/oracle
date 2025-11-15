import { describe, expect, test } from 'vitest';
import { InvalidArgumentError } from 'commander';
import {
  collectPaths,
  parseFloatOption,
  parseIntOption,
  parseSearchOption,
  resolvePreviewMode,
  resolveApiModel,
  inferModelFromLabel,
} from '../../src/cli/options.ts';

describe('collectPaths', () => {
  test('merges repeated flags and splits comma-separated values', () => {
    const result = collectPaths(['src/a', 'src/b,src/c'], ['existing']);
    expect(result).toEqual(['existing', 'src/a', 'src/b', 'src/c']);
  });

  test('returns previous list when value is undefined', () => {
    expect(collectPaths(undefined, ['keep'])).toEqual(['keep']);
  });
});

describe('parseFloatOption', () => {
  test('parses numeric strings', () => {
    expect(parseFloatOption('12.5')).toBeCloseTo(12.5);
  });

  test('throws for NaN input', () => {
    expect(() => parseFloatOption('nope')).toThrow(InvalidArgumentError);
  });
});

describe('parseIntOption', () => {
  test('parses integers and allows undefined', () => {
    expect(parseIntOption(undefined)).toBeUndefined();
    expect(parseIntOption('42')).toBe(42);
  });

  test('throws for invalid integers', () => {
    expect(() => parseIntOption('not-a-number')).toThrow(InvalidArgumentError);
  });
});

describe('resolvePreviewMode', () => {
  test('returns explicit mode', () => {
    expect(resolvePreviewMode('json')).toBe('json');
  });

  test('defaults boolean true to summary', () => {
    expect(resolvePreviewMode(true)).toBe('summary');
  });

  test('returns undefined for falsey values', () => {
    expect(resolvePreviewMode(undefined)).toBeUndefined();
    expect(resolvePreviewMode(false)).toBeUndefined();
  });
});

describe('parseSearchOption', () => {
  test('accepts on/off variants', () => {
    expect(parseSearchOption('on')).toBe(true);
    expect(parseSearchOption('OFF')).toBe(false);
    expect(parseSearchOption('Yes')).toBe(true);
    expect(parseSearchOption('0')).toBe(false);
  });

  test('throws on invalid input', () => {
    expect(() => parseSearchOption('maybe')).toThrow(InvalidArgumentError);
  });
});

describe('resolveApiModel', () => {
  test('accepts canonical names regardless of case', () => {
    expect(resolveApiModel('gpt-5-pro')).toBe('gpt-5-pro');
    expect(resolveApiModel('GPT-5.1')).toBe('gpt-5.1');
  });

  test('rejects unknown names', () => {
    expect(() => resolveApiModel('instant')).toThrow(InvalidArgumentError);
  });
});

describe('inferModelFromLabel', () => {
  test('returns canonical names when label already matches', () => {
    expect(inferModelFromLabel('gpt-5-pro')).toBe('gpt-5-pro');
    expect(inferModelFromLabel('gpt-5.1')).toBe('gpt-5.1');
  });

  test('infers ChatGPT Instant variants as gpt-5.1', () => {
    expect(inferModelFromLabel('ChatGPT 5.1 Instant')).toBe('gpt-5.1');
    expect(inferModelFromLabel('5.1 thinking')).toBe('gpt-5.1');
  });

  test('falls back to pro when the label references pro', () => {
    expect(inferModelFromLabel('ChatGPT Pro')).toBe('gpt-5-pro');
  });
});
