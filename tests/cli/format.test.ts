import { describe, expect, test } from 'vitest';
import { formatCompactNumber } from '../../src/cli/format.ts';

describe('formatCompactNumber', () => {
  test('renders small numbers with locale formatting', () => {
    expect(formatCompactNumber(999)).toBe('999');
  });

  test('renders thousands with k suffix', () => {
    expect(formatCompactNumber(1_200)).toBe('1.2k');
    expect(formatCompactNumber(10_000)).toBe('10k');
  });

  test('renders millions with m suffix', () => {
    expect(formatCompactNumber(1_500_000)).toBe('1.5m');
    expect(formatCompactNumber(2_000_000)).toBe('2m');
  });

  test('handles negative numbers', () => {
    expect(formatCompactNumber(-12_300)).toBe('-12.3k');
  });

  test('returns 0 on non-finite input', () => {
    expect(formatCompactNumber(Number.NaN)).toBe('0');
    expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
