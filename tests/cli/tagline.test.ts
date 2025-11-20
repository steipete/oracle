import { describe, expect, test } from 'vitest';
import { pickTagline, formatIntroLine, TAGLINES } from '../../src/cli/tagline.ts';

describe('taglines', () => {
  test('respects env override for deterministic index', () => {
    const tagline = pickTagline({ env: { ['ORACLE_TAGLINE_INDEX']: '3' } as NodeJS.ProcessEnv });
    expect(tagline).toBe(TAGLINES[3]);
  });

  test('wraps index modulo tagline length', () => {
    const tagline = pickTagline({
      env: { ['ORACLE_TAGLINE_INDEX']: String(TAGLINES.length + 2) } as NodeJS.ProcessEnv,
    });
    expect(tagline).toBe(TAGLINES[2]);
  });

  test('falls back to random source when no override', () => {
    const tagline = pickTagline({ random: () => 0.49 });
    expect(TAGLINES).toContain(tagline);
  });

  test('formats intro line with version', () => {
    const intro = formatIntroLine('1.2.3', { env: { ['ORACLE_TAGLINE_INDEX']: '0' } as NodeJS.ProcessEnv });
    expect(intro.startsWith('🧿 oracle v1.2.3 — ')).toBe(true);
    expect(intro).toContain(TAGLINES[0]);
  });
});
