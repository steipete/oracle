import { describe, expect, test } from 'vitest';
import { applyBrowserDefaultsFromConfig, type BrowserDefaultsOptions } from '../../src/cli/browserDefaults.js';
import type { UserConfig } from '../../src/config.js';

const source = (_key: keyof BrowserDefaultsOptions) => undefined;

describe('applyBrowserDefaultsFromConfig', () => {
  test('applies chatgptUrl from user config when flags are absent', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://chatgpt.com/g/g-p-foo/project');
  });

  test('does not override when CLI provided chatgptUrl', () => {
    const options: BrowserDefaultsOptions = { chatgptUrl: 'https://override.example.com/' };
    const config: UserConfig = {
      browser: {
        chatgptUrl: 'https://chatgpt.com/g/g-p-foo/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://override.example.com/');
  });

  test('falls back to browser.url when chatgptUrl missing', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        url: 'https://chatgpt.com/g/g-p-bar/project',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.chatgptUrl).toBe('https://chatgpt.com/g/g-p-bar/project');
  });

  test('applies chrome defaults when CLI flags are untouched or defaulted', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        chromePath: '/Applications/Comet.app/Contents/MacOS/Comet',
        chromeProfile: 'Work',
        chromeCookiePath: '/tmp/cookies',
        timeoutMs: 120_000,
        inputTimeoutMs: 15_000,
        profileLockTimeoutMs: 90_000,
        cookieSyncWaitMs: 4_000,
        headless: true,
        hideWindow: true,
        keepBrowser: true,
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => 'default');

    expect(options.browserChromePath).toBe('/Applications/Comet.app/Contents/MacOS/Comet');
    expect(options.browserChromeProfile).toBe('Work');
    expect(options.browserCookiePath).toBe('/tmp/cookies');
    expect(options.browserTimeout).toBe('120000');
    expect(options.browserInputTimeout).toBe('15000');
    expect(options.browserProfileLockTimeout).toBe('90000');
    expect(options.browserCookieWait).toBe('4000');
    expect(options.browserHeadless).toBe(true);
    expect(options.browserHideWindow).toBe(true);
    expect(options.browserKeepBrowser).toBe(true);
  });

  test('applies thinking time when CLI flag is untouched', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        thinkingTime: 'extended',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => 'default');

    expect(options.browserThinkingTime).toBe('extended');
  });

  test('does not override thinking time when CLI provided a value', () => {
    const options: BrowserDefaultsOptions = { browserThinkingTime: 'light' };
    const config: UserConfig = {
      browser: {
        thinkingTime: 'heavy',
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) => (key === 'browserThinkingTime' ? 'cli' : 'default');
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserThinkingTime).toBe('light');
  });

  test('applies manual-login defaults from config when CLI flags are untouched', () => {
    const options: BrowserDefaultsOptions = {};
    const config: UserConfig = {
      browser: {
        manualLogin: true,
        manualLoginProfileDir: '/tmp/oracle-profile',
      },
    };

    applyBrowserDefaultsFromConfig(options, config, (_key) => 'default');

    expect(options.browserManualLogin).toBe(true);
    expect(options.browserManualLoginProfileDir).toBe('/tmp/oracle-profile');
  });

  test('does not override manual-login when CLI enabled it', () => {
    const options: BrowserDefaultsOptions = { browserManualLogin: true };
    const config: UserConfig = {
      browser: {
        manualLogin: false,
      },
    };

    const source = (key: keyof BrowserDefaultsOptions) => (key === 'browserManualLogin' ? 'cli' : 'default');
    applyBrowserDefaultsFromConfig(options, config, source);

    expect(options.browserManualLogin).toBe(true);
  });
});
