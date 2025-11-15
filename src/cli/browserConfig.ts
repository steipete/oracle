import type { BrowserSessionConfig } from '../sessionManager.js';
import type { ModelName } from '../oracle.js';
import { DEFAULT_MODEL_TARGET, parseDuration } from '../browserMode.js';

const DEFAULT_BROWSER_TIMEOUT_MS = 900_000;
const DEFAULT_BROWSER_INPUT_TIMEOUT_MS = 30_000;

const BROWSER_MODEL_LABELS: Record<ModelName, string> = {
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5.1': 'ChatGPT 5.1',
};

export interface BrowserFlagOptions {
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserNoCookieSync?: boolean;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserModelLabel?: string;
  model: ModelName;
  verbose?: boolean;
}

export function buildBrowserConfig(options: BrowserFlagOptions): BrowserSessionConfig {
  const desiredModelOverride = options.browserModelLabel?.trim();
  const normalizedOverride = desiredModelOverride?.toLowerCase() ?? '';
  const baseModel = options.model.toLowerCase();
  const shouldUseOverride = normalizedOverride.length > 0 && normalizedOverride !== baseModel;
  return {
    chromeProfile: options.browserChromeProfile ?? null,
    chromePath: options.browserChromePath ?? null,
    url: options.browserUrl,
    timeoutMs: options.browserTimeout ? parseDuration(options.browserTimeout, DEFAULT_BROWSER_TIMEOUT_MS) : undefined,
    inputTimeoutMs: options.browserInputTimeout
      ? parseDuration(options.browserInputTimeout, DEFAULT_BROWSER_INPUT_TIMEOUT_MS)
      : undefined,
    cookieSync: options.browserNoCookieSync ? false : undefined,
    headless: options.browserHeadless ? true : undefined,
    keepBrowser: options.browserKeepBrowser ? true : undefined,
    hideWindow: options.browserHideWindow ? true : undefined,
    desiredModel: shouldUseOverride ? desiredModelOverride : mapModelToBrowserLabel(options.model),
    debug: options.verbose ? true : undefined,
  };
}

export function mapModelToBrowserLabel(model: ModelName): string {
  return BROWSER_MODEL_LABELS[model] ?? DEFAULT_MODEL_TARGET;
}
