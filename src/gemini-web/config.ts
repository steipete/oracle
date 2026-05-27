import os from "node:os";
import path from "node:path";

import type {
  BrowserArchiveMode,
  BrowserAutomationConfig,
  BrowserModelStrategy,
  BrowserResearchMode,
  ResolvedBrowserConfig,
} from "../browser/types.js";

export const GEMINI_APP_URL = "https://gemini.google.com/app";

export const DEFAULT_GEMINI_COOKIE_NAMES = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "NID",
  "AEC",
  "SOCS",
  "__Secure-BUCKET",
  "__Secure-ENID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PAPISID",
  "SIDCC",
];

const DEFAULT_MAX_CONCURRENT_GEMINI_TABS = 3;
const DEFAULT_GEMINI_MODEL_TARGET = "gemini-3-pro";
const DEFAULT_GEMINI_MODEL_STRATEGY: BrowserModelStrategy = "ignore";
const GEMINI_ALLOWED_URL_HOSTS = new Set(["gemini.google.com"]);

export const DEFAULT_GEMINI_BROWSER_CONFIG: ResolvedBrowserConfig = {
  chromeProfile: null,
  chromePath: null,
  chromeCookiePath: null,
  attachRunning: false,
  browserTabRef: null,
  url: GEMINI_APP_URL,
  chatgptUrl: null,
  timeoutMs: 1_200_000,
  debugPort: null,
  inputTimeoutMs: 60_000,
  attachmentTimeoutMs: 45_000,
  assistantRecheckDelayMs: 0,
  assistantRecheckTimeoutMs: 120_000,
  reuseChromeWaitMs: 10_000,
  profileLockTimeoutMs: 300_000,
  maxConcurrentTabs: DEFAULT_MAX_CONCURRENT_GEMINI_TABS,
  autoReattachDelayMs: 0,
  autoReattachIntervalMs: 0,
  autoReattachTimeoutMs: 120_000,
  cookieSync: true,
  cookieNames: DEFAULT_GEMINI_COOKIE_NAMES,
  cookieSyncWaitMs: 0,
  inlineCookies: null,
  inlineCookiesSource: null,
  headless: false,
  keepBrowser: false,
  hideWindow: false,
  desiredModel: DEFAULT_GEMINI_MODEL_TARGET,
  modelStrategy: DEFAULT_GEMINI_MODEL_STRATEGY,
  debug: false,
  allowCookieErrors: false,
  remoteChrome: null,
  remoteChromeBrowserWSEndpoint: null,
  remoteChromeProfileRoot: null,
  manualLogin: false,
  manualLoginProfileDir: null,
  manualLoginCookieSync: false,
  researchMode: "off",
  archiveConversations: "auto",
};

export function resolveGeminiBrowserConfig(
  config: BrowserAutomationConfig | undefined,
): ResolvedBrowserConfig {
  const debugPortEnv = parseDebugPort(
    process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT,
  );
  const envAllowCookieErrors =
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim().toLowerCase() === "true" ||
    (process.env.ORACLE_BROWSER_ALLOW_COOKIE_ERRORS ?? "").trim() === "1";
  const rawUrl = config?.url ?? config?.chatgptUrl ?? DEFAULT_GEMINI_BROWSER_CONFIG.url;
  const normalizedUrl = normalizeGeminiUrl(rawUrl, DEFAULT_GEMINI_BROWSER_CONFIG.url);
  const desiredModel =
    config?.desiredModel ??
    DEFAULT_GEMINI_BROWSER_CONFIG.desiredModel ??
    DEFAULT_GEMINI_MODEL_TARGET;
  const modelStrategy =
    normalizeModelStrategy(config?.modelStrategy) ??
    DEFAULT_GEMINI_BROWSER_CONFIG.modelStrategy ??
    DEFAULT_GEMINI_MODEL_STRATEGY;
  const isWindows = process.platform === "win32";
  const manualLogin =
    config?.manualLogin ?? (isWindows ? true : DEFAULT_GEMINI_BROWSER_CONFIG.manualLogin);
  const cookieSyncDefault = isWindows ? false : DEFAULT_GEMINI_BROWSER_CONFIG.cookieSync;
  const resolvedProfileDir = resolveManualLoginProfileDir(
    config?.manualLoginProfileDir,
    process.env.ORACLE_BROWSER_PROFILE_DIR,
  );
  const researchMode = normalizeResearchMode(config?.researchMode);
  const archiveConversations = normalizeArchiveMode(config?.archiveConversations);

  return {
    ...DEFAULT_GEMINI_BROWSER_CONFIG,
    ...config,
    url: normalizedUrl,
    chatgptUrl: null,
    timeoutMs: config?.timeoutMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.timeoutMs,
    debugPort: config?.debugPort ?? debugPortEnv ?? DEFAULT_GEMINI_BROWSER_CONFIG.debugPort,
    inputTimeoutMs: config?.inputTimeoutMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.inputTimeoutMs,
    assistantRecheckDelayMs:
      config?.assistantRecheckDelayMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.assistantRecheckDelayMs,
    assistantRecheckTimeoutMs:
      config?.assistantRecheckTimeoutMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.assistantRecheckTimeoutMs,
    reuseChromeWaitMs: config?.reuseChromeWaitMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.reuseChromeWaitMs,
    profileLockTimeoutMs:
      config?.profileLockTimeoutMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.profileLockTimeoutMs,
    maxConcurrentTabs: normalizeMaxConcurrentTabs(
      config?.maxConcurrentTabs ?? DEFAULT_GEMINI_BROWSER_CONFIG.maxConcurrentTabs,
    ),
    autoReattachDelayMs:
      config?.autoReattachDelayMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.autoReattachDelayMs,
    autoReattachIntervalMs:
      config?.autoReattachIntervalMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.autoReattachIntervalMs,
    autoReattachTimeoutMs:
      config?.autoReattachTimeoutMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.autoReattachTimeoutMs,
    cookieSync: config?.cookieSync ?? cookieSyncDefault,
    cookieNames:
      normalizeCookieNames(config?.cookieNames) ?? DEFAULT_GEMINI_BROWSER_CONFIG.cookieNames,
    cookieSyncWaitMs: config?.cookieSyncWaitMs ?? DEFAULT_GEMINI_BROWSER_CONFIG.cookieSyncWaitMs,
    inlineCookies: config?.inlineCookies ?? DEFAULT_GEMINI_BROWSER_CONFIG.inlineCookies,
    inlineCookiesSource:
      config?.inlineCookiesSource ?? DEFAULT_GEMINI_BROWSER_CONFIG.inlineCookiesSource,
    headless: config?.headless ?? DEFAULT_GEMINI_BROWSER_CONFIG.headless,
    keepBrowser: config?.keepBrowser ?? DEFAULT_GEMINI_BROWSER_CONFIG.keepBrowser,
    hideWindow: config?.hideWindow ?? DEFAULT_GEMINI_BROWSER_CONFIG.hideWindow,
    desiredModel,
    modelStrategy,
    chromeProfile: config?.chromeProfile ?? DEFAULT_GEMINI_BROWSER_CONFIG.chromeProfile,
    chromePath: config?.chromePath ?? DEFAULT_GEMINI_BROWSER_CONFIG.chromePath,
    chromeCookiePath: config?.chromeCookiePath ?? DEFAULT_GEMINI_BROWSER_CONFIG.chromeCookiePath,
    attachRunning: config?.attachRunning ?? DEFAULT_GEMINI_BROWSER_CONFIG.attachRunning,
    browserTabRef: config?.browserTabRef ?? DEFAULT_GEMINI_BROWSER_CONFIG.browserTabRef,
    debug: config?.debug ?? DEFAULT_GEMINI_BROWSER_CONFIG.debug,
    allowCookieErrors:
      config?.allowCookieErrors ??
      envAllowCookieErrors ??
      DEFAULT_GEMINI_BROWSER_CONFIG.allowCookieErrors,
    remoteChrome: config?.remoteChrome ?? DEFAULT_GEMINI_BROWSER_CONFIG.remoteChrome,
    remoteChromeBrowserWSEndpoint:
      config?.remoteChromeBrowserWSEndpoint ??
      DEFAULT_GEMINI_BROWSER_CONFIG.remoteChromeBrowserWSEndpoint,
    remoteChromeProfileRoot:
      config?.remoteChromeProfileRoot ?? DEFAULT_GEMINI_BROWSER_CONFIG.remoteChromeProfileRoot,
    thinkingTime: config?.thinkingTime,
    researchMode,
    archiveConversations,
    manualLogin,
    manualLoginProfileDir: manualLogin ? resolvedProfileDir : null,
    manualLoginCookieSync:
      config?.manualLoginCookieSync ?? DEFAULT_GEMINI_BROWSER_CONFIG.manualLoginCookieSync,
  };
}

export function normalizeGeminiUrl(raw: string | null | undefined, fallback: string): string {
  const input = raw?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid Gemini browser URL: ${input}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Gemini browser URL must use https: ${input}`);
  }
  if (!GEMINI_ALLOWED_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Gemini URL host must be gemini.google.com, got ${parsed.hostname}`);
  }

  return parsed.toString();
}

function normalizeResearchMode(value: unknown): BrowserResearchMode {
  return value === "deep" ? "deep" : "off";
}

function normalizeArchiveMode(value: unknown): BrowserArchiveMode {
  return value === "always" || value === "never" ? value : "auto";
}

function normalizeModelStrategy(value: unknown): BrowserModelStrategy | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "select" || normalized === "current" || normalized === "ignore") {
    return normalized as BrowserModelStrategy;
  }
  return null;
}

function normalizeCookieNames(value: string[] | null | undefined): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names = value
    .map((entry) => entry.trim())
    .filter((entry) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(entry));
  return names.length > 0 ? names : null;
}

function normalizeMaxConcurrentTabs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_CONCURRENT_GEMINI_TABS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CONCURRENT_GEMINI_TABS;
  }
  return Math.max(1, Math.trunc(numeric));
}

function parseDebugPort(raw?: string | null): number | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

function resolveManualLoginProfileDir(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const profileDir = candidate?.trim();
    if (profileDir) return profileDir;
  }
  return path.join(os.homedir(), ".oracle", "browser-profile");
}
