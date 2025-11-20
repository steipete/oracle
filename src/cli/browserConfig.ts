import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { BrowserSessionConfig } from '../sessionStore.js';
import type { ModelName } from '../oracle.js';
import { CHATGPT_URL, DEFAULT_MODEL_TARGET, normalizeChatgptUrl, parseDuration } from '../browserMode.js';
import type { CookieParam } from '../browser/types.js';

const DEFAULT_BROWSER_TIMEOUT_MS = 1_200_000;
const DEFAULT_BROWSER_INPUT_TIMEOUT_MS = 30_000;
const DEFAULT_CHROME_PROFILE = 'Default';

const BROWSER_MODEL_LABELS: Partial<Record<ModelName, string>> = {
  'gpt-5-pro': 'GPT-5 Pro',
  'gpt-5.1-pro': 'GPT-5.1 Pro',
  'gpt-5.1': 'GPT-5.1',
  'gemini-3-pro': 'Gemini 3 Pro',
};

export interface BrowserFlagOptions {
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  chatgptUrl?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserNoCookieSync?: boolean;
  browserInlineCookiesFile?: string;
  browserCookieNames?: string;
  browserInlineCookies?: string;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserModelLabel?: string;
  browserAllowCookieErrors?: boolean;
  remoteChrome?: string;
  model: ModelName;
  verbose?: boolean;
}

export async function buildBrowserConfig(options: BrowserFlagOptions): Promise<BrowserSessionConfig> {
  const desiredModelOverride = options.browserModelLabel?.trim();
  const normalizedOverride = desiredModelOverride?.toLowerCase() ?? '';
  const baseModel = options.model.toLowerCase();
  const shouldUseOverride = normalizedOverride.length > 0 && normalizedOverride !== baseModel;
  const cookieNames = parseCookieNames(options.browserCookieNames ?? process.env.ORACLE_BROWSER_COOKIE_NAMES);
  const inline = await resolveInlineCookies({
    inlineArg: options.browserInlineCookies,
    inlineFileArg: options.browserInlineCookiesFile,
    envPayload: process.env.ORACLE_BROWSER_COOKIES_JSON,
    envFile: process.env.ORACLE_BROWSER_COOKIES_FILE,
    cwd: process.cwd(),
  });

  let remoteChrome: { host: string; port: number } | undefined;
  if (options.remoteChrome) {
    remoteChrome = parseRemoteChromeTarget(options.remoteChrome);
  }
  const rawUrl = options.chatgptUrl ?? options.browserUrl;
  const url = rawUrl ? normalizeChatgptUrl(rawUrl, CHATGPT_URL) : undefined;

  return {
    chromeProfile: options.browserChromeProfile ?? DEFAULT_CHROME_PROFILE,
    chromePath: options.browserChromePath ?? null,
    chromeCookiePath: options.browserCookiePath ?? null,
    url,
    timeoutMs: options.browserTimeout ? parseDuration(options.browserTimeout, DEFAULT_BROWSER_TIMEOUT_MS) : undefined,
    inputTimeoutMs: options.browserInputTimeout
      ? parseDuration(options.browserInputTimeout, DEFAULT_BROWSER_INPUT_TIMEOUT_MS)
      : undefined,
    cookieSync: options.browserNoCookieSync ? false : undefined,
    cookieNames,
    inlineCookies: inline?.cookies,
    inlineCookiesSource: inline?.source ?? null,
    headless: undefined, // disable headless; Cloudflare blocks it
    keepBrowser: options.browserKeepBrowser ? true : undefined,
    hideWindow: options.browserHideWindow ? true : undefined,
    desiredModel: shouldUseOverride ? desiredModelOverride : mapModelToBrowserLabel(options.model),
    debug: options.verbose ? true : undefined,
    // Allow cookie failures by default so runs can continue without Chrome/Keychain secrets.
    allowCookieErrors: options.browserAllowCookieErrors ?? true,
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
  const oracleHome = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), '.oracle');
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
