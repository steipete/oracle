import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserSessionConfig } from '../sessionStore.js';
import type { ModelName, ThinkingTimeLevel } from '../oracle.js';
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET, isTemporaryChatUrl, normalizeChatgptUrl, parseDuration } from '../browserMode.js';
import { normalizeBrowserModelStrategy } from '../browser/modelStrategy.js';
import type { BrowserModelStrategy } from '../browser/types.js';
import type { CookieParam } from '../browser/types.js';
import { getOracleHomeDir } from '../oracleHome.js';

const DEFAULT_BROWSER_TIMEOUT_MS = 1_200_000;
const DEFAULT_BROWSER_INPUT_TIMEOUT_MS = 60_000;
const DEFAULT_BROWSER_RECHECK_TIMEOUT_MS = 120_000;
const DEFAULT_BROWSER_AUTO_REATTACH_TIMEOUT_MS = 120_000;
const DEFAULT_CHROME_PROFILE = 'Default';

// Ordered array: most specific models first to ensure correct selection.
// The browser label is passed to the model picker which fuzzy-matches against ChatGPT's UI.
const BROWSER_MODEL_LABELS: [ModelName, string][] = [
  // Most specific first (e.g., "gpt-5.2-thinking" before "gpt-5.2")
  ['gpt-5.2-thinking', 'GPT-5.2 Thinking'],
  ['gpt-5.2-instant', 'GPT-5.2 Instant'],
  ['gpt-5.2-pro', 'GPT-5.2 Pro'],
  ['gpt-5.1-pro', 'GPT-5.2 Pro'],
  ['gpt-5-pro', 'GPT-5.2 Pro'],
  // Base models last (least specific)
  ['gpt-5.2', 'GPT-5.2'],       // Selects "Auto" in ChatGPT UI
  ['gpt-5.1', 'GPT-5.2'],       // Legacy alias → Auto
  ['gemini-3-pro', 'Gemini 3 Pro'],
];

export interface BrowserFlagOptions {
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  chatgptUrl?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserRecheckDelay?: string;
  browserRecheckTimeout?: string;
  browserReuseWait?: string;
  browserProfileLockTimeout?: string;
  browserAutoReattachDelay?: string;
  browserAutoReattachInterval?: string;
  browserAutoReattachTimeout?: string;
  browserCookieWait?: string;
  browserNoCookieSync?: boolean;
  browserInlineCookiesFile?: string;
  browserCookieNames?: string;
  browserInlineCookies?: string;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserManualLogin?: boolean;
  browserManualLoginProfileDir?: string | null;
  /** Thinking time intensity: 'light', 'standard', 'extended', 'heavy' */
  browserThinkingTime?: ThinkingTimeLevel;
  browserModelLabel?: string;
  browserModelStrategy?: BrowserModelStrategy;
  browserAllowCookieErrors?: boolean;
  remoteChrome?: string;
  browserPort?: number;
  browserDebugPort?: number;
  model: ModelName;
  verbose?: boolean;
}

export function normalizeChatGptModelForBrowser(model: ModelName): ModelName {
  const normalized = model.toLowerCase() as ModelName;
  if (!normalized.startsWith('gpt-') || normalized.includes('codex')) {
    return model;
  }

  // Pro variants: always resolve to the latest Pro model in ChatGPT.
  if (normalized === 'gpt-5-pro' || normalized === 'gpt-5.1-pro' || normalized.endsWith('-pro')) {
    return 'gpt-5.2-pro';
  }

  // Explicit model variants: keep as-is (they have their own browser labels)
  if (normalized === 'gpt-5.2-thinking' || normalized === 'gpt-5.2-instant') {
    return normalized;
  }

  // Legacy aliases: map to base GPT-5.2 (Auto)
  if (normalized === 'gpt-5.1') {
    return 'gpt-5.2';
  }

  return model;
}

export async function buildBrowserConfig(options: BrowserFlagOptions): Promise<BrowserSessionConfig> {
  const desiredModelOverride = options.browserModelLabel?.trim();
  const normalizedOverride = desiredModelOverride?.toLowerCase() ?? '';
  const baseModel = options.model.toLowerCase();
  const isChatGptModel = baseModel.startsWith('gpt-') && !baseModel.includes('codex');
  const shouldUseOverride = !isChatGptModel && normalizedOverride.length > 0 && normalizedOverride !== baseModel;
  const modelStrategy =
    normalizeBrowserModelStrategy(options.browserModelStrategy) ?? DEFAULT_MODEL_STRATEGY;
  const cookieNames = parseCookieNames(options.browserCookieNames ?? process.env.ORACLE_BROWSER_COOKIE_NAMES);
  let inline = await resolveInlineCookies({
    inlineArg: options.browserInlineCookies,
    inlineFileArg: options.browserInlineCookiesFile,
    envPayload: process.env.ORACLE_BROWSER_COOKIES_JSON,
    envFile: process.env.ORACLE_BROWSER_COOKIES_FILE,
    cwd: process.cwd(),
  });
  if (inline?.source?.startsWith('home:') && options.browserNoCookieSync !== true) {
    inline = undefined;
  }

  let remoteChrome: { host: string; port: number } | undefined;
  if (options.remoteChrome) {
    remoteChrome = parseRemoteChromeTarget(options.remoteChrome);
  }
  const rawUrl = options.chatgptUrl ?? options.browserUrl;
  const url = rawUrl ? normalizeChatgptUrl(rawUrl, CHATGPT_URL) : undefined;

  const desiredModel = isChatGptModel
    ? mapModelToBrowserLabel(options.model)
    : shouldUseOverride
      ? desiredModelOverride
      : mapModelToBrowserLabel(options.model);

  if (modelStrategy === 'select' && url && isTemporaryChatUrl(url) && /\bpro\b/i.test(desiredModel ?? '')) {
    throw new Error(
      'Temporary Chat mode does not expose Pro models in the ChatGPT model picker. ' +
        'Remove "temporary-chat=true" from --chatgpt-url (or omit --chatgpt-url), or use a non-Pro model (e.g. --model gpt-5.2).',
    );
  }

  return {
    chromeProfile: options.browserChromeProfile ?? DEFAULT_CHROME_PROFILE,
    chromePath: options.browserChromePath ?? null,
    chromeCookiePath: options.browserCookiePath ?? null,
    url,
    debugPort: selectBrowserPort(options),
    timeoutMs: options.browserTimeout ? parseDuration(options.browserTimeout, DEFAULT_BROWSER_TIMEOUT_MS) : undefined,
    inputTimeoutMs: options.browserInputTimeout
      ? parseDuration(options.browserInputTimeout, DEFAULT_BROWSER_INPUT_TIMEOUT_MS)
      : undefined,
    assistantRecheckDelayMs: options.browserRecheckDelay
      ? parseDuration(options.browserRecheckDelay, 0)
      : undefined,
    assistantRecheckTimeoutMs: options.browserRecheckTimeout
      ? parseDuration(options.browserRecheckTimeout, DEFAULT_BROWSER_RECHECK_TIMEOUT_MS)
      : undefined,
    reuseChromeWaitMs: options.browserReuseWait ? parseDuration(options.browserReuseWait, 0) : undefined,
    profileLockTimeoutMs: options.browserProfileLockTimeout
      ? parseDuration(options.browserProfileLockTimeout, 0)
      : undefined,
    autoReattachDelayMs: options.browserAutoReattachDelay
      ? parseDuration(options.browserAutoReattachDelay, 0)
      : undefined,
    autoReattachIntervalMs: options.browserAutoReattachInterval
      ? parseDuration(options.browserAutoReattachInterval, 0)
      : undefined,
    autoReattachTimeoutMs: options.browserAutoReattachTimeout
      ? parseDuration(options.browserAutoReattachTimeout, DEFAULT_BROWSER_AUTO_REATTACH_TIMEOUT_MS)
      : undefined,
    cookieSyncWaitMs: options.browserCookieWait ? parseDuration(options.browserCookieWait, 0) : undefined,
    cookieSync: options.browserNoCookieSync ? false : undefined,
    cookieNames,
    inlineCookies: inline?.cookies,
    inlineCookiesSource: inline?.source ?? null,
    headless: undefined, // disable headless; Cloudflare blocks it
    keepBrowser: options.browserKeepBrowser ? true : undefined,
    manualLogin: options.browserManualLogin === undefined ? undefined : options.browserManualLogin,
    manualLoginProfileDir: options.browserManualLoginProfileDir ?? undefined,
    hideWindow: options.browserHideWindow ? true : undefined,
    desiredModel,
    modelStrategy,
    debug: options.verbose ? true : undefined,
    // Allow cookie failures by default so runs can continue without Chrome/Keychain secrets.
    allowCookieErrors: options.browserAllowCookieErrors ?? true,
    remoteChrome,
    thinkingTime: options.browserThinkingTime,
  };
}

function selectBrowserPort(options: BrowserFlagOptions): number | null {
  const candidate = options.browserPort ?? options.browserDebugPort;
  if (candidate === undefined || candidate === null) return null;
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate > 65_535) {
    throw new Error(`Invalid browser port: ${candidate}. Expected a number between 1 and 65535.`);
  }
  return candidate;
}

export function mapModelToBrowserLabel(model: ModelName): string {
  const normalized = normalizeChatGptModelForBrowser(model);
  // Iterate ordered array to find first match (most specific first)
  for (const [key, label] of BROWSER_MODEL_LABELS) {
    if (key === normalized) {
      return label;
    }
  }
  return DEFAULT_MODEL_TARGET;
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

function parseRemoteChromeTarget(raw: string): { host: string; port: number } {
  const target = raw.trim();
  if (!target) {
    throw new Error('Invalid remote-chrome value: expected host:port but received an empty string.');
  }

  const ipv6Match = target.match(/^\[(.+)]:(\d+)$/);
  let host: string | undefined;
  let portSegment: string | undefined;

  if (ipv6Match) {
    host = ipv6Match[1]?.trim();
    portSegment = ipv6Match[2]?.trim();
  } else {
    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Expected host:port (IPv6 must use [host]:port notation).`
      );
    }
    host = target.slice(0, lastColon).trim();
    portSegment = target.slice(lastColon + 1).trim();
    if (host.includes(':')) {
      throw new Error(
        `Invalid remote-chrome format: ${target}. Wrap IPv6 addresses in brackets, e.g. --remote-chrome "[2001:db8::1]:9222".`
      );
    }
  }

  if (!host) {
    throw new Error(
      `Invalid remote-chrome format: ${target}. Host portion is missing; expected host:port.`
    );
  }
  const port = Number.parseInt(portSegment ?? '', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `Invalid remote-chrome port: "${portSegment ?? ''}". Expected a number between 1 and 65535.`
    );
  }
  return { host, port };
}

function parseCookieNames(raw?: string | null): string[] | undefined {
  if (!raw) return undefined;
  const names = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return names.length ? names : undefined;
}

async function resolveInlineCookies({
  inlineArg,
  inlineFileArg,
  envPayload,
  envFile,
  cwd,
}: {
  inlineArg?: string | null;
  inlineFileArg?: string | null;
  envPayload?: string | null;
  envFile?: string | null;
  cwd: string;
}): Promise<{ cookies: CookieParam[]; source: string } | undefined> {
  const tryLoad = async (source: string | undefined | null, allowPathResolution: boolean) => {
    if (!source) return undefined;
    const trimmed = source.trim();
    if (!trimmed) return undefined;
    if (allowPathResolution) {
      const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
      try {
        const stat = await fs.stat(resolved);
        if (stat.isFile()) {
          const fileContent = await fs.readFile(resolved, 'utf8');
          const parsed = parseInlineCookiesPayload(fileContent);
          if (parsed) return parsed;
        }
      } catch {
        // not a file; treat as payload below
      }
    }
    return parseInlineCookiesPayload(trimmed);
  };

  const sources = [
    { value: inlineFileArg, allowPath: true, source: 'inline-file' },
    { value: inlineArg, allowPath: true, source: 'inline-arg' },
    { value: envFile, allowPath: true, source: 'env-file' },
    { value: envPayload, allowPath: false, source: 'env-payload' },
  ];

  for (const { value, allowPath, source } of sources) {
    const parsed = await tryLoad(value, allowPath);
    if (parsed) return { cookies: parsed, source };
  }

  // fallback: ~/.oracle/cookies.{json,base64}
  const oracleHome = getOracleHomeDir();
  const candidates = ['cookies.json', 'cookies.base64'];
  for (const file of candidates) {
    const fullPath = path.join(oracleHome, file);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(fullPath, 'utf8');
      const parsed = parseInlineCookiesPayload(content);
      if (parsed) return { cookies: parsed, source: `home:${file}` };
    } catch {
      // ignore missing/invalid
    }
  }
  return undefined;
}

function parseInlineCookiesPayload(raw?: string | null): CookieParam[] | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  let jsonPayload = text;
  // Attempt base64 decode first; fall back to raw text on failure.
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (decoded.trim().startsWith('[')) {
      jsonPayload = decoded;
    }
  } catch {
    // not base64; continue with raw text
  }
  try {
    const parsed = JSON.parse(jsonPayload) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as CookieParam[];
    }
  } catch {
    // invalid json; skip silently to keep this hidden flag non-fatal
  }
  return undefined;
}
