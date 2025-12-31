/**
 * Gemini Browser Automation Types
 */

import type { BrowserLogger, BrowserAttachment, BrowserRunResult, CookieParam } from '../browser/types.js';
import type { BrowserRuntimeMetadata } from '../sessionStore.js';
import type { GeminiDeepThinkModel } from './constants.js';

export type { BrowserLogger, BrowserAttachment, CookieParam };

export type GeminiThinkingLevel = 'quick' | 'balanced' | 'thorough' | 'max';

export interface GeminiBrowserConfig {
  /** Chrome profile name or path */
  chromeProfile?: string | null;
  /** Path to Chrome executable */
  chromePath?: string | null;
  /** Path to Chrome cookies database */
  chromeCookiePath?: string | null;
  /** Target URL (defaults to gemini.google.com/app) */
  url?: string;
  /** Overall timeout in ms */
  timeoutMs?: number;
  /** Chrome DevTools debugging port */
  debugPort?: number | null;
  /** Timeout for prompt input ready */
  inputTimeoutMs?: number;
  /** Whether to sync cookies from Chrome profile */
  cookieSync?: boolean;
  /** Specific cookie names to sync */
  cookieNames?: string[] | null;
  /** Inline cookies to use instead of Chrome profile */
  inlineCookies?: CookieParam[] | null;
  /** Source description for inline cookies */
  inlineCookiesSource?: string | null;
  /** Run browser in headless mode */
  headless?: boolean;
  /** Keep browser open after completion */
  keepBrowser?: boolean;
  /** Hide browser window (macOS) */
  hideWindow?: boolean;
  /** Desired Gemini model for Deep Think */
  desiredModel?: GeminiDeepThinkModel | string | null;
  /** Enable debug logging */
  debug?: boolean;
  /** Allow cookie sync errors without failing */
  allowCookieErrors?: boolean;
  /** Remote Chrome connection */
  remoteChrome?: { host: string; port: number } | null;
  /** Manual login mode (keep browser visible for user to sign in) */
  manualLogin?: boolean;
  /** Directory for manual login Chrome profile */
  manualLoginProfileDir?: string | null;
  /** Sync cookies even in manual login mode */
  manualLoginCookieSync?: boolean;
  /** Thinking intensity level for Deep Think */
  thinkingLevel?: GeminiThinkingLevel;
  /** Show thinking/reasoning process in output */
  showThinking?: boolean;
}

export interface GeminiBrowserRunOptions {
  /** The prompt to send to Gemini */
  prompt: string;
  /** File attachments to upload */
  attachments?: BrowserAttachment[];
  /** Fallback submission if primary fails */
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
  /** Browser configuration */
  config?: GeminiBrowserConfig;
  /** Logger function */
  log?: BrowserLogger;
  /** Heartbeat interval in ms */
  heartbeatIntervalMs?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Callback to persist runtime info */
  runtimeHintCb?: (hint: BrowserRuntimeMetadata) => void | Promise<void>;
}

export interface GeminiBrowserRunResult extends BrowserRunResult {
  /** Raw thinking/reasoning text if available */
  thinkingText?: string;
  /** Model that was used */
  modelUsed?: string;
  /** Whether Deep Think mode was active */
  deepThinkActive?: boolean;
}

export interface GeminiThinkingStatus {
  /** Whether the model is currently thinking */
  isThinking: boolean;
  /** Current thinking phase/stage */
  phase?: string;
  /** Progress message if available */
  message?: string;
  /** Elapsed thinking time in ms */
  elapsedMs?: number;
}

export interface GeminiResponseSnapshot {
  /** Response text content */
  text: string;
  /** HTML content if available */
  html?: string;
  /** Thinking/reasoning content if shown */
  thinking?: string;
  /** Response metadata */
  meta?: {
    turnId?: string;
    messageId?: string;
    modelId?: string;
  };
}

export interface GeminiLoginProbeResult {
  /** Whether user is logged in */
  ok: boolean;
  /** HTTP status from any API probe */
  status: number;
  /** Current page URL */
  pageUrl?: string | null;
  /** Whether login UI is detected */
  loginUiDetected?: boolean;
  /** Whether on Google auth page */
  onAuthPage?: boolean;
  /** Error message if any */
  error?: string | null;
}
