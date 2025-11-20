import type CDP from 'chrome-remote-interface';
import type Protocol from 'devtools-protocol';

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
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
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
  userDataDir?: string;
}

export type ResolvedBrowserConfig = Required<
  Omit<BrowserAutomationConfig, 'chromeProfile' | 'chromePath' | 'chromeCookiePath' | 'desiredModel' | 'remoteChrome'>
> & {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  desiredModel?: string | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
};
