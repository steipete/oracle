import { describe, expect, test } from 'vitest';
import { buildBrowserConfig } from '../../src/cli/browserConfig.ts';

describe('buildBrowserConfig', () => {
  test('uses defaults when optional flags omitted', () => {
    const config = buildBrowserConfig({ model: 'gpt-5-pro' });
    expect(config).toMatchObject({
      chromeProfile: null,
      chromePath: null,
      url: undefined,
      timeoutMs: undefined,
      inputTimeoutMs: undefined,
      cookieSync: undefined,
      headless: undefined,
      keepBrowser: undefined,
      hideWindow: undefined,
      desiredModel: 'GPT-5 Pro',
      debug: undefined,
    });
  });

  test('honors overrides and converts durations + booleans', () => {
    const config = buildBrowserConfig({
      model: 'gpt-5.1',
      browserChromeProfile: 'Profile 2',
      browserChromePath: '/Applications/Chrome.app',
      browserUrl: 'https://chat.example.com',
      browserTimeout: '120s',
      browserInputTimeout: '5s',
      browserNoCookieSync: true,
      browserHeadless: true,
      browserHideWindow: true,
      browserKeepBrowser: true,
      verbose: true,
    });
    expect(config).toMatchObject({
      chromeProfile: 'Profile 2',
      chromePath: '/Applications/Chrome.app',
      url: 'https://chat.example.com',
      timeoutMs: 120_000,
      inputTimeoutMs: 5_000,
      cookieSync: false,
      headless: true,
      hideWindow: true,
      keepBrowser: true,
      desiredModel: 'ChatGPT 5.1',
      debug: true,
    });
  });

  test('prefers explicit browser model label when provided', () => {
    const config = buildBrowserConfig({
      model: 'gpt-5-pro',
      browserModelLabel: 'Instant',
    });
    expect(config.desiredModel).toBe('Instant');
  });

  test('falls back to canonical label when override matches base model', () => {
    const config = buildBrowserConfig({
      model: 'gpt-5.1',
      browserModelLabel: 'gpt-5.1',
    });
    expect(config.desiredModel).toBe('ChatGPT 5.1');
  });
});
