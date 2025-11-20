import { CHATGPT_URL, DEFAULT_MODEL_TARGET } from './constants.js';
import type { BrowserAutomationConfig, ResolvedBrowserConfig } from './types.js';
import { normalizeChatgptUrl } from './utils.js';

export const DEFAULT_BROWSER_CONFIG: ResolvedBrowserConfig = {
  chromeProfile: null,
  chromePath: null,
  chromeCookiePath: null,
  url: CHATGPT_URL,
  chatgptUrl: CHATGPT_URL,
  timeoutMs: 1_200_000,
  inputTimeoutMs: 30_000,
  cookieSync: true,
  cookieNames: null,
  inlineCookies: null,
  inlineCookiesSource: null,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  desiredModel: DEFAULT_MODEL_TARGET,
  debug: false,
  allowCookieErrors: false,
  remoteChrome: null,
};

export function resolveBrowserConfig(config: BrowserAutomationConfig | undefined): ResolvedBrowserConfig {
  const envAllowCookieErrors =
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? '').trim().toLowerCase() === 'true' ||
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? '').trim() === '1';
  const rawUrl = config?.chatgptUrl ?? config?.url ?? DEFAULT_BROWSER_CONFIG.url;
  const normalizedUrl = normalizeChatgptUrl(rawUrl ?? DEFAULT_BROWSER_CONFIG.url, DEFAULT_BROWSER_CONFIG.url);
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...(config ?? {}),
    url: normalizedUrl,
    chatgptUrl: normalizedUrl,
    timeoutMs: config?.timeoutMs ?? DEFAULT_BROWSER_CONFIG.timeoutMs,
    inputTimeoutMs: config?.inputTimeoutMs ?? DEFAULT_BROWSER_CONFIG.inputTimeoutMs,
    cookieSync: config?.cookieSync ?? DEFAULT_BROWSER_CONFIG.cookieSync,
    cookieNames: config?.cookieNames ?? DEFAULT_BROWSER_CONFIG.cookieNames,
    inlineCookies: config?.inlineCookies ?? DEFAULT_BROWSER_CONFIG.inlineCookies,
    inlineCookiesSource: config?.inlineCookiesSource ?? DEFAULT_BROWSER_CONFIG.inlineCookiesSource,
    headless: config?.headless ?? DEFAULT_BROWSER_CONFIG.headless,
    keepBrowser: config?.keepBrowser ?? DEFAULT_BROWSER_CONFIG.keepBrowser,
    hideWindow: config?.hideWindow ?? DEFAULT_BROWSER_CONFIG.hideWindow,
    desiredModel: config?.desiredModel ?? DEFAULT_BROWSER_CONFIG.desiredModel,
    chromeProfile: config?.chromeProfile ?? DEFAULT_BROWSER_CONFIG.chromeProfile,
    chromePath: config?.chromePath ?? DEFAULT_BROWSER_CONFIG.chromePath,
    chromeCookiePath: config?.chromeCookiePath ?? DEFAULT_BROWSER_CONFIG.chromeCookiePath,
    debug: config?.debug ?? DEFAULT_BROWSER_CONFIG.debug,
    allowCookieErrors: config?.allowCookieErrors ?? envAllowCookieErrors ?? DEFAULT_BROWSER_CONFIG.allowCookieErrors,
  };
}
