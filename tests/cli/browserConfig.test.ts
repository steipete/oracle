import { describe, expect, test } from 'vitest';
import { buildBrowserConfig, resolveBrowserModelLabel } from '../../src/cli/browserConfig.js';

describe('buildBrowserConfig', () => {
  test('uses defaults when optional flags omitted', async () => {
    const config = await buildBrowserConfig({ model: 'gpt-5.1-pro' });
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
      desiredModel: 'GPT-5.1 Pro',
      debug: undefined,
      allowCookieErrors: true,
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
      url: 'https://chat.example.com/',
      timeoutMs: 120_000,
      inputTimeoutMs: 5_000,
      cookieSync: false,
      headless: undefined,
      hideWindow: true,
      keepBrowser: true,
      desiredModel: 'GPT-5.1',
      debug: true,
      allowCookieErrors: true,
    });
  });

  test('prefers explicit browser model label when provided', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1-pro',
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

  test('parses remoteChrome host targets', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1-pro',
      remoteChrome: 'remote-host:9333',
    });
    expect(config.remoteChrome).toEqual({ host: 'remote-host', port: 9_333 });
  });

  test('normalizes chatgpt-url alias and adds https when missing', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1',
      chatgptUrl: 'chatgpt.example.com/workspace',
    });
    expect(config.url).toBe('https://chatgpt.example.com/workspace');
  });

  test('rejects invalid chatgpt URL protocols', async () => {
    await expect(
      buildBrowserConfig({
        model: 'gpt-5.1',
        chatgptUrl: 'ftp://chatgpt.example.com',
      }),
    ).rejects.toThrow(/http/i);
  });

  test('accepts IPv6 remoteChrome targets wrapped in brackets', async () => {
    const config = await buildBrowserConfig({
      model: 'gpt-5.1-pro',
      remoteChrome: '[2001:db8::1]:9222',
    });
    expect(config.remoteChrome).toEqual({ host: '2001:db8::1', port: 9_222 });
  });

  test('rejects malformed remoteChrome targets', async () => {
    await expect(
      buildBrowserConfig({
        model: 'gpt-5.1-pro',
        remoteChrome: 'just-a-host',
      }),
    ).rejects.toThrow(/host:port/i);
  });

  test('rejects remoteChrome IPv6 without brackets', async () => {
    await expect(
      buildBrowserConfig({
        model: 'gpt-5.1-pro',
        remoteChrome: '2001:db8::1:9222',
      }),
    ).rejects.toThrow(/Wrap IPv6 addresses/i);
  });

  test('rejects out-of-range remoteChrome ports', async () => {
    await expect(
      buildBrowserConfig({
        model: 'gpt-5.1-pro',
        remoteChrome: 'server:70000',
      }),
    ).rejects.toThrow(/between 1 and 65535/i);
  });
});

describe('resolveBrowserModelLabel', () => {
  test('returns canonical ChatGPT label when CLI value matches API model', () => {
    expect(resolveBrowserModelLabel('gpt-5.1-pro', 'gpt-5.1-pro')).toBe('GPT-5.1 Pro');
    expect(resolveBrowserModelLabel('GPT-5.1', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('falls back to canonical label when input is empty', () => {
    expect(resolveBrowserModelLabel('', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('preserves descriptive labels to target alternate picker entries', () => {
    expect(resolveBrowserModelLabel('ChatGPT 5.1 Instant', 'gpt-5.1')).toBe('ChatGPT 5.1 Instant');
  });

  test('supports undefined or whitespace-only input', () => {
    expect(resolveBrowserModelLabel(undefined, 'gpt-5.1-pro')).toBe('GPT-5.1 Pro');
    expect(resolveBrowserModelLabel('   ', 'gpt-5.1')).toBe('GPT-5.1');
  });

  test('trims descriptive labels before returning them', () => {
    expect(resolveBrowserModelLabel('  ChatGPT 5.1 Thinking ', 'gpt-5.1')).toBe('ChatGPT 5.1 Thinking');
  });
});
