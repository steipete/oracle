import { describe, expect, test, vi } from 'vitest';
import clipboard from 'clipboardy';
import { copyToClipboard } from '../../src/cli/clipboard.ts';

vi.mock('clipboardy', () => ({
  default: {
    write: vi.fn(),
  },
}));

describe('copyToClipboard', () => {
  test('returns success when clipboardy.write resolves', async () => {
    (clipboard.write as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await copyToClipboard('hello');
    expect(result).toEqual({ success: true, command: 'clipboardy' });
    expect(clipboard.write).toHaveBeenCalledWith('hello');
  });

  test('returns failure when clipboardy.write throws', async () => {
    const error = new Error('boom');
    (clipboard.write as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    const result = await copyToClipboard('hi');
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
  });

  test('coerces non-string input rejection from clipboardy', async () => {
    const typeError = new TypeError('Expected a string');
    (clipboard.write as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(typeError);
    const result = await copyToClipboard(123 as unknown as string);
    expect(result.success).toBe(false);
    expect(result.error).toBe(typeError);
  });
});
