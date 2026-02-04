import { normalizeChatgptUrl, CHATGPT_URL } from '../browserMode.js';
import type { UserConfig } from '../config.js';
import type { ThinkingTimeLevel } from '../oracle.js';
import type { BrowserModelStrategy } from '../browser/types.js';

export interface BrowserDefaultsOptions {
  chatgptUrl?: string;
  browserUrl?: string;
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  browserTimeout?: string | number;
  browserInputTimeout?: string | number;
  browserRecheckDelay?: string | number;
  browserRecheckTimeout?: string | number;
  browserReuseWait?: string | number;
  browserProfileLockTimeout?: string | number;
  browserAutoReattachDelay?: string | number;
  browserAutoReattachInterval?: string | number;
  browserAutoReattachTimeout?: string | number;
  browserCookieWait?: string | number;
  browserPort?: number;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserModelStrategy?: BrowserModelStrategy;
  browserThinkingTime?: ThinkingTimeLevel;
  browserManualLogin?: boolean;
  browserManualLoginProfileDir?: string | null;
}

type SourceGetter = (key: keyof BrowserDefaultsOptions) => string | undefined;

export function applyBrowserDefaultsFromConfig(
  options: BrowserDefaultsOptions,
  config: UserConfig,
  getSource: SourceGetter,
): void {
  const browser = config.browser;
  if (!browser) return;

  const isUnset = (key: keyof BrowserDefaultsOptions): boolean => {
    const source = getSource(key);
    return source === undefined || source === 'default';
  };

  const configuredChatgptUrl = browser.chatgptUrl ?? browser.url;
  const cliChatgptSet = options.chatgptUrl !== undefined || options.browserUrl !== undefined;
  if (isUnset('chatgptUrl') && !cliChatgptSet && configuredChatgptUrl !== undefined) {
    options.chatgptUrl = normalizeChatgptUrl(configuredChatgptUrl ?? '', CHATGPT_URL);
  }

  if (isUnset('browserChromeProfile') && browser.chromeProfile !== undefined) {
    options.browserChromeProfile = browser.chromeProfile ?? undefined;
  }
  if (isUnset('browserChromePath') && browser.chromePath !== undefined) {
    options.browserChromePath = browser.chromePath ?? undefined;
  }
  if (isUnset('browserCookiePath') && browser.chromeCookiePath !== undefined) {
    options.browserCookiePath = browser.chromeCookiePath ?? undefined;
  }
  if (isUnset('browserUrl') && options.browserUrl === undefined && browser.url !== undefined) {
    options.browserUrl = browser.url;
  }
  if (isUnset('browserTimeout') && typeof browser.timeoutMs === 'number') {
    options.browserTimeout = String(browser.timeoutMs);
  }
  if (isUnset('browserPort') && typeof browser.debugPort === 'number') {
    options.browserPort = browser.debugPort;
  }
  if (isUnset('browserInputTimeout') && typeof browser.inputTimeoutMs === 'number') {
    options.browserInputTimeout = String(browser.inputTimeoutMs);
  }
  if (isUnset('browserRecheckDelay') && typeof browser.assistantRecheckDelayMs === 'number') {
    options.browserRecheckDelay = String(browser.assistantRecheckDelayMs);
  }
  if (isUnset('browserRecheckTimeout') && typeof browser.assistantRecheckTimeoutMs === 'number') {
    options.browserRecheckTimeout = String(browser.assistantRecheckTimeoutMs);
  }
  if (isUnset('browserReuseWait') && typeof browser.reuseChromeWaitMs === 'number') {
    options.browserReuseWait = String(browser.reuseChromeWaitMs);
  }
  if (isUnset('browserProfileLockTimeout') && typeof browser.profileLockTimeoutMs === 'number') {
    options.browserProfileLockTimeout = String(browser.profileLockTimeoutMs);
  }
  if (isUnset('browserAutoReattachDelay') && typeof browser.autoReattachDelayMs === 'number') {
    options.browserAutoReattachDelay = String(browser.autoReattachDelayMs);
  }
  if (isUnset('browserAutoReattachInterval') && typeof browser.autoReattachIntervalMs === 'number') {
    options.browserAutoReattachInterval = String(browser.autoReattachIntervalMs);
  }
  if (isUnset('browserAutoReattachTimeout') && typeof browser.autoReattachTimeoutMs === 'number') {
    options.browserAutoReattachTimeout = String(browser.autoReattachTimeoutMs);
  }
  if (isUnset('browserCookieWait') && typeof browser.cookieSyncWaitMs === 'number') {
    options.browserCookieWait = String(browser.cookieSyncWaitMs);
  }
  if (isUnset('browserHeadless') && browser.headless !== undefined) {
    options.browserHeadless = browser.headless;
  }
  if (isUnset('browserHideWindow') && browser.hideWindow !== undefined) {
    options.browserHideWindow = browser.hideWindow;
  }
  if (isUnset('browserKeepBrowser') && browser.keepBrowser !== undefined) {
    options.browserKeepBrowser = browser.keepBrowser;
  }
  if (isUnset('browserModelStrategy') && browser.modelStrategy !== undefined) {
    options.browserModelStrategy = browser.modelStrategy;
  }
  if (isUnset('browserThinkingTime') && browser.thinkingTime !== undefined) {
    options.browserThinkingTime = browser.thinkingTime;
  }
  if (isUnset('browserManualLogin') && browser.manualLogin !== undefined) {
    options.browserManualLogin = browser.manualLogin;
  }
  if (isUnset('browserManualLoginProfileDir') && browser.manualLoginProfileDir !== undefined) {
    options.browserManualLoginProfileDir = browser.manualLoginProfileDir;
  }
}
