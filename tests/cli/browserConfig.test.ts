import { describe, expect, test } from 'vitest';
import { buildBrowserConfig, resolveBrowserModelLabel } from '../../src/cli/browserConfig.js';

describe('buildBrowserConfig', () => {
  test('uses defaults when optional flags omitted', async () => {
    const config = await buildBrowserConfig({ model: 'gpt-5-pro' });
    expect(config).toMatchObject({
      chromeProfile: 'Default',
      chromePath: null,
      chromeCookiePath: null,
      url: undefined,
      timeoutMs: undefined,
      inputTimeoutMs: undefined,
      cookieSync: undefined,
      headless: undefined,
      keepBrowser: undefined,
      hideWindow: undefined,
      desiredModel: 'GPT-5 Pro',
      debug: undefined,
      allowCookieErrors: undefined,
    });
  });

  test('honors overrides and converts durations + booleans', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1',
      browserChromeProfile: 'Profile 2',
      browserChromePath: '/Applications/Chrome.app',
      browserCookiePath: '/tmp/cookies.db',
      browserUrl: 'https://chat.example.com',
      browserTimeout: '120s',
      browserInputTimeout: '5s',
      browserNoCookieSync: true,
      browserHeadless: true,
      browserHideWindow: true,
      browserKeepBrowser: true,
      browserAllowCookieErrors: true,
      verbose: true,
    });
    expect(config).toMatchObject({
      chromeProfile: 'Profile 2',
      chromePath: '/Applications/Chrome.app',
      chromeCookiePath: '/tmp/cookies.db',
      url: 'https://chat.example.com',
      timeoutMs: 120_000,
      inputTimeoutMs: 5_000,
      cookieSync: false,
      headless: true,
      hideWindow: true,
      keepBrowser: true,
      desiredModel: 'GPT-5.1',
      debug: true,
      allowCookieErrors: true,
    });
  });

  test('prefers explicit browser model label when provided', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5-pro',
      browserModelLabel: 'Instant',
    });
    expect(config.desiredModel).toBe('Instant');
  });

  test('falls back to canonical label when override matches base model', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1',
      browserModelLabel: 'gpt-5.1',
    });
    expect(config.desiredModel).toBe('GPT-5.1');
  });

  test('maps thinking Gemini model to thinking label', async () => {
    const config = await buildBrowserConfig({
      model: 'gemini-3-pro',
    });
    expect(config.desiredModel).toBe('Gemini 3 Pro');
  });

  test('trims whitespace around override labels', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1',
      browserModelLabel: '  ChatGPT 5.1 Instant  ',
    });
    expect(config.desiredModel).toBe('ChatGPT 5.1 Instant');
  });
});

describe('resolveBrowserModelLabel', () => {
  test('returns canonical ChatGPT label when CLI value matches API model', () => {
    expect(resolveBrowserModelLabel('gpt-5-pro', 'gpt-5-pro')).toBe('GPT-5 Pro');
    expect(resolveBrowserModelLabel('GPT-5.1', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('falls back to canonical label when input is empty', () => {
    expect(resolveBrowserModelLabel('', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('preserves descriptive labels to target alternate picker entries', () => {
    expect(resolveBrowserModelLabel('ChatGPT 5.1 Instant', 'gpt-5.1')).toBe('ChatGPT 5.1 Instant');
  });

  test('supports undefined or whitespace-only input', () => {
    expect(resolveBrowserModelLabel(undefined, 'gpt-5-pro')).toBe('GPT-5 Pro');
    expect(resolveBrowserModelLabel('   ', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('trims descriptive labels before returning them', () => {
    expect(resolveBrowserModelLabel('  ChatGPT 5.1 Thinking ', 'gpt-5.1')).toBe('ChatGPT 5.1 Thinking');
  });
});
