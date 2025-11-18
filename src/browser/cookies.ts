import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COOKIE_URLS } from './constants.js';
import type { BrowserLogger, ChromeClient, CookieParam, ChromeCookiesSecureModule, PuppeteerCookie } from './types.js';

export class ChromeCookieSyncError extends Error {}

export async function syncCookies(
  Network: ChromeClient['Network'],
  url: string,
  profile: string | null | undefined,
  logger: BrowserLogger,
  allowErrors = false,
) {
  try {
    const cookies = await readChromeCookies(url, profile);
    if (!cookies.length) {
      return 0;
    }
    let applied = 0;
    for (const cookie of cookies) {
      const cookieWithUrl: CookieParam = { ...cookie };
      if (!cookieWithUrl.domain || cookieWithUrl.domain === 'localhost') {
        cookieWithUrl.url = url;
      } else if (!cookieWithUrl.domain.startsWith('.')) {
        cookieWithUrl.url = `https://${cookieWithUrl.domain}`;
      }
      try {
        const result = await Network.setCookie(cookieWithUrl);
        if (result?.success) {
          applied += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`Failed to set cookie ${cookie.name}: ${message}`);
      }
    }
    return applied;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (allowErrors) {
      logger(`Cookie sync failed (continuing with override): ${message}`);
      return 0;
    }
    throw error instanceof ChromeCookieSyncError ? error : new ChromeCookieSyncError(message);
  }
}

async function readChromeCookies(url: string, profile?: string | null): Promise<CookieParam[]> {
  const chromeModule = await loadChromeCookiesModule();
  const urlsToCheck = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const merged = new Map<string, CookieParam>();
  for (const candidateUrl of urlsToCheck) {
    let rawCookies: unknown;
    rawCookies = await chromeModule.getCookiesPromised(candidateUrl, 'puppeteer', profile ?? undefined);
    if (!Array.isArray(rawCookies)) {
      continue;
    }
    const fallbackHostname = new URL(candidateUrl).hostname;
    for (const cookie of rawCookies) {
      const normalized = normalizeCookie(cookie as PuppeteerCookie, fallbackHostname);
      if (!normalized) {
        continue;
      }
      const key = `${normalized.domain ?? fallbackHostname}:${normalized.name}`;
      if (!merged.has(key)) {
        merged.set(key, normalized);
      }
    }
  }
  return Array.from(merged.values());
}

function normalizeCookie(cookie: PuppeteerCookie, fallbackHost: string): CookieParam | null {
  if (!cookie?.name) {
    return null;
  }

  const domain = cookie.domain?.startsWith('.') ? cookie.domain : cookie.domain ?? fallbackHost;
  const expires = normalizeExpiration(cookie.expires);
  const secure = typeof cookie.Secure === 'boolean' ? cookie.Secure : true;
  const httpOnly = typeof cookie.HttpOnly === 'boolean' ? cookie.HttpOnly : false;

  return {
    name: cookie.name,
    value: cookie.value ?? '',
    domain,
    path: cookie.path ?? '/',
    expires,
    secure,
    httpOnly,
  } satisfies CookieParam;
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeExpiration(expires?: number): number | undefined {
  if (!expires || Number.isNaN(expires)) {
    return undefined;
  }
  const value = Number(expires);
  if (value <= 0) {
    return undefined;
  }
  if (value > 1_000_000_000_000) {
    return Math.round(value / 1_000_000 - 11644473600);
  }
  if (value > 1_000_000_000) {
    return Math.round(value / 1000);
  }
  return Math.round(value);
}

const WORKSPACE_MANIFEST_PATH = fileURLToPath(new URL('../../pnpm-workspace.yaml', import.meta.url));
const HAS_PNPM_WORKSPACE = existsSync(WORKSPACE_MANIFEST_PATH);
const SQLITE_NODE_PATTERN = /node_sqlite3\.node/i;
const SQLITE_BINDINGS_PATTERN = /bindings file/i;
const SQLITE_SELF_REGISTER_PATTERN = /Module did not self-register/i;
const SQLITE_BINDING_HINT = [
  'Chrome cookie sync needs sqlite3 bindings for Node 25.',
  'If the automatic rebuild fails, run:',
  '  PYTHON=/usr/bin/python3 npm_config_build_from_source=1 pnpm rebuild chrome-cookies-secure sqlite3 keytar --workspace-root',
].join('\n');
let attemptedSqliteRebuild: boolean = false;

async function loadChromeCookiesModule(): Promise<ChromeCookiesSecureModule> {
  let imported: unknown;
  try {
    imported = await import('chrome-cookies-secure');
  } catch (error) {
    console.warn('Failed to load chrome-cookies-secure to copy cookies:', error);
    if (isSqliteBindingError(error)) {
      const rebuilt = await attemptSqliteRebuild();
      if (rebuilt) {
        return loadChromeCookiesModule();
      }
      console.warn(SQLITE_BINDING_HINT);
    } else {
      console.warn('If this persists, run `pnpm rebuild chrome-cookies-secure sqlite3 keytar --workspace-root`.');
    }
    throw new ChromeCookieSyncError('Unable to load chrome-cookies-secure. Cookie copy is required.');
  }

  const secureModule = resolveChromeCookieModule(imported);
  if (!secureModule) {
    console.warn('chrome-cookies-secure does not expose getCookiesPromised(); skipping cookie copy.');
    throw new ChromeCookieSyncError('chrome-cookies-secure did not expose getCookiesPromised');
  }
  return secureModule;
}

function resolveChromeCookieModule(candidate: unknown): ChromeCookiesSecureModule | null {
  if (hasGetCookiesPromised(candidate)) {
    return candidate;
  }
  if (typeof candidate === 'object' && candidate !== null) {
    const defaultExport: unknown = Reflect.get(candidate, 'default');
    if (hasGetCookiesPromised(defaultExport)) {
      return defaultExport;
    }
  }
  return null;
}

function hasGetCookiesPromised(value: unknown): value is ChromeCookiesSecureModule {
  return Boolean(value && typeof (value as ChromeCookiesSecureModule).getCookiesPromised === 'function');
}

function isSqliteBindingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? '';
  return (
    SQLITE_NODE_PATTERN.test(message) ||
    SQLITE_BINDINGS_PATTERN.test(message) ||
    SQLITE_SELF_REGISTER_PATTERN.test(message)
  );
}

async function attemptSqliteRebuild(): Promise<boolean> {
  if (attemptedSqliteRebuild) {
    return false;
  }
  attemptedSqliteRebuild = true;
  if (process.env.ORACLE_ALLOW_SQLITE_REBUILD !== '1') {
    console.warn(
      '[oracle] sqlite3 bindings missing. Set ORACLE_ALLOW_SQLITE_REBUILD=1 if you want oracle to attempt an automatic rebuild, or run `pnpm rebuild chrome-cookies-secure sqlite3 keytar --workspace-root` manually.',
    );
    return false;
  }
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['rebuild', 'chrome-cookies-secure', 'sqlite3', 'keytar'];
  if (HAS_PNPM_WORKSPACE) {
    args.push('--workspace-root');
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  childEnv.npm_config_build_from_source = '1';
  childEnv.PYTHON = childEnv.PYTHON ?? '/usr/bin/python3';
  console.warn('[oracle] Attempting to rebuild sqlite3 bindings automatically…');
  console.warn(
    `[oracle] Running: npm_config_build_from_source=1 PYTHON=${childEnv.PYTHON} ${pnpmCommand} ${args.join(' ')}`,
  );
  return new Promise((resolve) => {
    const child = spawn(pnpmCommand, args, { stdio: 'inherit', env: childEnv });
    child.on('exit', (code) => {
      if (code === 0) {
        console.warn('[oracle] sqlite3 rebuild completed successfully.');
        resolve(true);
      } else {
        console.warn('[oracle] sqlite3 rebuild failed with exit code', code ?? 0);
        resolve(false);
      }
    });
    child.on('error', (error) => {
      console.warn('[oracle] Unable to spawn pnpm to rebuild sqlite3:', error);
      resolve(false);
    });
  });
}
