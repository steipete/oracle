import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from './constants.js';
import { normalizeBrowserModelStrategy } from './modelStrategy.js';
import type { BrowserAutomationConfig, ResolvedBrowserConfig } from './types.js';
import { isTemporaryChatUrl, normalizeChatgptUrl } from './utils.js';
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
  inputTimeoutMs: 60_000,
  assistantRecheckDelayMs: 0,
  assistantRecheckTimeoutMs: 120_000,
  reuseChromeWaitMs: 10_000,
  profileLockTimeoutMs: 300_000,
  autoReattachDelayMs: 0,
  autoReattachIntervalMs: 0,
  autoReattachTimeoutMs: 120_000,
  cookieSync: true,
  cookieNames: null,
  cookieSyncWaitMs: 0,
  inlineCookies: null,
  inlineCookiesSource: null,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  desiredModel: DEFAULT_MODEL_TARGET,
  modelStrategy: DEFAULT_MODEL_STRATEGY,
  debug: false,
  allowCookieErrors: false,
  remoteChrome: null,
  manualLogin: false,
  manualLoginProfileDir: null,
  manualLoginCookieSync: false,
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
  const desiredModel = config?.desiredModel ?? DEFAULT_BROWSER_CONFIG.desiredModel ?? DEFAULT_MODEL_TARGET;
  const modelStrategy =
    normalizeBrowserModelStrategy(config?.modelStrategy) ??
    DEFAULT_BROWSER_CONFIG.modelStrategy ??
    DEFAULT_MODEL_STRATEGY;
  if (modelStrategy === 'select' && isTemporaryChatUrl(normalizedUrl) && /\bpro\b/i.test(desiredModel)) {
    throw new Error(
      'Temporary Chat mode does not expose Pro models in the ChatGPT model picker. ' +
        'Remove "temporary-chat=true" from your browser URL, or use a non-Pro model label (e.g. "GPT-5.2").',
    );
  }
  const isWindows = process.platform === 'win32';
  const manualLogin = config?.manualLogin ?? (isWindows ? true : DEFAULT_BROWSER_CONFIG.manualLogin);
  const cookieSyncDefault = isWindows ? false : DEFAULT_BROWSER_CONFIG.cookieSync;
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
    assistantRecheckDelayMs: config?.assistantRecheckDelayMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs: config?.assistantRecheckTimeoutMs ?? DEFAULT_BROWSER_CONFIG.assistantRecheckTimeoutMs,
    reuseChromeWaitMs: config?.reuseChromeWaitMs ?? DEFAULT_BROWSER_CONFIG.reuseChromeWaitMs,
    profileLockTimeoutMs: config?.profileLockTimeoutMs ?? DEFAULT_BROWSER_CONFIG.profileLockTimeoutMs,
    autoReattachDelayMs: config?.autoReattachDelayMs ?? DEFAULT_BROWSER_CONFIG.autoReattachDelayMs,
    autoReattachIntervalMs: config?.autoReattachIntervalMs ?? DEFAULT_BROWSER_CONFIG.autoReattachIntervalMs,
    autoReattachTimeoutMs: config?.autoReattachTimeoutMs ?? DEFAULT_BROWSER_CONFIG.autoReattachTimeoutMs,
    cookieSync: config?.cookieSync ?? cookieSyncDefault,
    cookieNames: config?.cookieNames ?? DEFAULT_BROWSER_CONFIG.cookieNames,
    cookieSyncWaitMs: config?.cookieSyncWaitMs ?? DEFAULT_BROWSER_CONFIG.cookieSyncWaitMs,
    inlineCookies: config?.inlineCookies ?? DEFAULT_BROWSER_CONFIG.inlineCookies,
    inlineCookiesSource: config?.inlineCookiesSource ?? DEFAULT_BROWSER_CONFIG.inlineCookiesSource,
    headless: config?.headless ?? DEFAULT_BROWSER_CONFIG.headless,
    keepBrowser: config?.keepBrowser ?? DEFAULT_BROWSER_CONFIG.keepBrowser,
    hideWindow: config?.hideWindow ?? DEFAULT_BROWSER_CONFIG.hideWindow,
    desiredModel,
    modelStrategy,
    chromeProfile: config?.chromeProfile ?? DEFAULT_BROWSER_CONFIG.chromeProfile,
    chromePath: config?.chromePath ?? DEFAULT_BROWSER_CONFIG.chromePath,
    chromeCookiePath: config?.chromeCookiePath ?? DEFAULT_BROWSER_CONFIG.chromeCookiePath,
    debug: config?.debug ?? DEFAULT_BROWSER_CONFIG.debug,
    allowCookieErrors: config?.allowCookieErrors ?? envAllowCookieErrors ?? DEFAULT_BROWSER_CONFIG.allowCookieErrors,
    thinkingTime: config?.thinkingTime,
    manualLogin,
    manualLoginProfileDir: manualLogin ? resolvedProfileDir : null,
    manualLoginCookieSync: config?.manualLoginCookieSync ?? DEFAULT_BROWSER_CONFIG.manualLoginCookieSync,
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
