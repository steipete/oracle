import type CDP from 'chrome-remote-interface';
import type Protocol from 'devtools-protocol';
import type { BrowserRuntimeMetadata } from '../sessionStore.js';

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;

export interface ChromeCookiesSecureModule {
  getCookiesPromised: (
    url: string,
    format: 'puppeteer' | 'object',
    profile?: string
  ) => Promise<PuppeteerCookie[] | Record<string, unknown>>;
}

export interface PuppeteerCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  // biome-ignore lint/style/useNamingConvention: matches Puppeteer cookie shape
  Secure?: boolean;
  // biome-ignore lint/style/useNamingConvention: matches Puppeteer cookie shape
  HttpOnly?: boolean;
}

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
};

export interface BrowserAttachment {
  path: string;
  displayPath: string;
  sizeBytes?: number;
}

export interface BrowserAutomationConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  extendedThinking?: boolean;
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /** Optional hook to persist runtime info (port/url/target) as soon as Chrome is ready. */
  runtimeHintCb?: (hint: BrowserRuntimeMetadata) => void | Promise<void>;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  controllerPid?: number;
}

export type ResolvedBrowserConfig = Required<
  Omit<BrowserAutomationConfig, 'chromeProfile' | 'chromePath' | 'chromeCookiePath' | 'desiredModel' | 'remoteChrome'>
> & {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  desiredModel?: string | null;
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
};
