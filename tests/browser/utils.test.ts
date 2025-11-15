import { describe, expect, test, vi } from 'vitest';
import { parseDuration, estimateTokenCount, delay } from '../../src/browser/utils.js';

describe('parseDuration', () => {
  test.each([
    ['500ms', 1234, 500],
    ['5s', 100, 5000],
    ['2m', 100, 120000],
    ['42', 0, 42],
  ])('parses %s with fallback %d', (input, fallback, expected) => {
    expect(parseDuration(input, fallback)).toBe(expected);
  });

  test('falls back for invalid input', () => {
    expect(parseDuration('oops', 987)).toBe(987);
  });
});

describe('estimateTokenCount', () => {
  test('handles empty text', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  test('estimates based on words and chars', () => {
    const short = 'one two three four';
    expect(estimateTokenCount(short)).toBeGreaterThan(0);
    const long = 'a'.repeat(400);
    expect(estimateTokenCount(long)).toBeGreaterThan(estimateTokenCount(short));
  });
});

describe('delay', () => {
  test('resolves after requested time', async () => {
    vi.useFakeTimers();
    const pending = delay(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
