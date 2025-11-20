import { describe, expect, test, vi } from 'vitest';
import { warnIfOversizeBundle } from '../../src/cli/bundleWarnings.ts';

describe('warnIfOversizeBundle', () => {
  test('logs when over threshold', () => {
    const log = vi.fn();
    const warned = warnIfOversizeBundle(200_000, 196_000, log);
    expect(warned).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/200,000 tokens/);
    expect(log.mock.calls[0][0]).toMatch(/Warning/);
  });

  test('does nothing when under threshold', () => {
    const log = vi.fn();
    const warned = warnIfOversizeBundle(150_000, 196_000, log);
    expect(warned).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  test('skips NaN input', () => {
    const log = vi.fn();
    const warned = warnIfOversizeBundle(Number.NaN, 196_000, log);
    expect(warned).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
