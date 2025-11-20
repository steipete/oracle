import { describe, expect, test } from 'vitest';
import { resolveBrowserConfig } from '../../src/browser/config.js';
import { CHATGPT_URL } from '../../src/browser/constants.js';

describe('resolveBrowserConfig', () => {
  test('returns defaults when config missing', () => {
    const resolved = resolveBrowserConfig(undefined);
    expect(resolved.url).toBe(CHATGPT_URL);
    expect(resolved.cookieSync).toBe(true);
    expect(resolved.headless).toBe(false);
  });

  test('applies overrides', () => {
    const resolved = resolveBrowserConfig({
      url: 'https://example.com',
      timeoutMs: 123,
      inputTimeoutMs: 456,
      cookieSync: false,
      headless: true,
      desiredModel: 'Custom',
      chromeProfile: 'Profile 1',
      chromePath: '/Applications/Chrome',
      debug: true,
    });
    expect(resolved.url).toBe('https://example.com/');
    expect(resolved.timeoutMs).toBe(123);
    expect(resolved.inputTimeoutMs).toBe(456);
    expect(resolved.cookieSync).toBe(false);
    expect(resolved.headless).toBe(true);
    expect(resolved.desiredModel).toBe('Custom');
    expect(resolved.chromeProfile).toBe('Profile 1');
    expect(resolved.chromePath).toBe('/Applications/Chrome');
    expect(resolved.debug).toBe(true);
  });
});
