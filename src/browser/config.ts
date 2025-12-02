import { CHATGPT_URL, DEFAULT_MODEL_TARGET } from './constants.js';
import type { BrowserAutomationConfig, ResolvedBrowserConfig } from './types.js';
import { normalizeChatgptUrl } from './utils.js';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BROWSER_CONFIG: ResolvedBrowserConfig = {
  chromeProfile: null,
  chromePath: null,
  chromeCookiePath: null,
  url: CHATGPT_URL,
  chatgptUrl: CHATGPT_URL,
  timeoutMs: 1_200_000,
  debugPort: null,
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
  manualLogin: false,
  manualLoginProfileDir: null,
};

export function resolveBrowserConfig(config: BrowserAutomationConfig | undefined): ResolvedBrowserConfig {
  const debugPortEnv = parseDebugPort(
    process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT,
  );
  const envAllowCookieErrors =
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? '').trim().toLowerCase() === 'true' ||
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? '').trim() === '1';
  const rawUrl = config?.chatgptUrl ?? config?.url ?? DEFAULT_BROWSER_CONFIG.url;
  const normalizedUrl = normalizeChatgptUrl(rawUrl ?? DEFAULT_BROWSER_CONFIG.url, DEFAULT_BROWSER_CONFIG.url);
  const manualLogin = config?.manualLogin ?? DEFAULT_BROWSER_CONFIG.manualLogin;
  const cookieSyncDefault = DEFAULT_BROWSER_CONFIG.cookieSync;
  const resolvedProfileDir =
    config?.manualLoginProfileDir ??
    process.env.ORACLE_BROWSER_PROFILE_DIR ??
    path.join(os.homedir(), '.oracle', 'browser-profile');
  return {
    ...DEFAULT_BROWSER_CONFIG,
    ...(config ?? {}),
    url: normalizedUrl,
    chatgptUrl: normalizedUrl,
    timeoutMs: config?.timeoutMs ?? DEFAULT_BROWSER_CONFIG.timeoutMs,
    debugPort: config?.debugPort ?? debugPortEnv ?? DEFAULT_BROWSER_CONFIG.debugPort,
    inputTimeoutMs: config?.inputTimeoutMs ?? DEFAULT_BROWSER_CONFIG.inputTimeoutMs,
    cookieSync: config?.cookieSync ?? cookieSyncDefault,
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
    manualLogin,
    manualLoginProfileDir: manualLogin ? resolvedProfileDir : null,
  };
}

function parseDebugPort(raw?: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}
