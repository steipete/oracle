import type { BrowserSessionConfig } from '../sessionManager.js';
import type { ModelName } from '../oracle.js';
import { DEFAULT_MODEL_TARGET, parseDuration } from '../browserMode.js';

const DEFAULT_BROWSER_TIMEOUT_MS = 900_000;
const DEFAULT_BROWSER_INPUT_TIMEOUT_MS = 30_000;
const DEFAULT_CHROME_PROFILE = 'Default';

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
  browserAllowCookieErrors?: boolean;
  remoteChrome?: string;
  model: ModelName;
  verbose?: boolean;
}

export function buildBrowserConfig(options: BrowserFlagOptions): BrowserSessionConfig {
  const desiredModelOverride = options.browserModelLabel?.trim();
  const normalizedOverride = desiredModelOverride?.toLowerCase() ?? '';
  const baseModel = options.model.toLowerCase();
  const shouldUseOverride = normalizedOverride.length > 0 && normalizedOverride !== baseModel;

  let remoteChrome: { host: string; port: number } | undefined;
  if (options.remoteChrome) {
    const parts = options.remoteChrome.split(':');
    if (parts.length === 2) {
      const port = Number.parseInt(parts[1], 10);

      // Validate port is a valid number in valid range
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(
          `Invalid remote-chrome port: "${parts[1]}". Expected a number between 1 and 65535.`
        );
      }

      remoteChrome = { host: parts[0], port };
    } else {
      throw new Error(`Invalid remote-chrome format: ${options.remoteChrome}. Expected host:port`);
    }
  }

  return {
    chromeProfile: options.browserChromeProfile ?? DEFAULT_CHROME_PROFILE,
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
    allowCookieErrors: options.browserAllowCookieErrors ? true : undefined,
    remoteChrome,
  };
}

export function mapModelToBrowserLabel(model: ModelName): string {
  return BROWSER_MODEL_LABELS[model] ?? DEFAULT_MODEL_TARGET;
}

export function resolveBrowserModelLabel(input: string | undefined, model: ModelName): string {
  const trimmed = input?.trim?.() ?? '';
  if (!trimmed) {
    return mapModelToBrowserLabel(model);
  }
  const normalizedInput = trimmed.toLowerCase();
  if (normalizedInput === model.toLowerCase()) {
    return mapModelToBrowserLabel(model);
  }
  return trimmed;
}
