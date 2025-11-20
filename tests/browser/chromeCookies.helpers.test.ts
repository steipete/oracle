import { describe, expect, test } from 'vitest';
import { __test__ } from '../../src/browser/chromeCookies.js';

describe('chromeCookies helpers', () => {
  test('cleanValue strips leading control chars', () => {
    expect(__test__.cleanValue('\u0001\u0002hello')).toBe('hello');
    expect(__test__.cleanValue('hello')).toBe('hello');
  });

  test('normalizeExpiration handles Chromium timestamps', () => {
    expect(__test__.normalizeExpiration(undefined)).toBeUndefined();
    expect(__test__.normalizeExpiration(0)).toBeUndefined();
    expect(__test__.normalizeExpiration(1_700_000_000)).toBe(1_700_000);
    expect(__test__.normalizeExpiration(1_700_000_000_000)).toBe(1_700_000 - 11644473600);
  });

  test('looksLikePath detects absolute-like inputs', () => {
    expect(__test__.looksLikePath('/Users/me/Cookies')).toBe(true);
    expect(__test__.looksLikePath('Profile 1')).toBe(false);
  });

  test('defaultProfileRoot returns something platform-specific', async () => {
    const root = await __test__.defaultProfileRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(1);
  });
});
