import { describe, expect, test } from 'vitest';
import { formatThinkingLog } from '../../src/browser/index.js';

describe('formatThinkingLog', () => {
  test('renders progress bar without emoji', () => {
    const line = formatThinkingLog(0, 300_000, 'planning', '');
    expect(line).toMatch(/^\[5m 0s \/ ~10m] [█░]{10} \s*\d{1,3}% — planning$/);
    expect(line).not.toMatch(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u);
  });

  test('caps at 100% when exceeding target', () => {
    const line = formatThinkingLog(0, 900_000, 'finishing', '');
    expect(line).toContain('100%');
  });
});
