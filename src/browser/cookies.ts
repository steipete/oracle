import { COOKIE_URLS } from './constants.js';
import type { BrowserLogger, ChromeClient, CookieParam, ChromeCookiesSecureModule, PuppeteerCookie } from './types.js';

export async function syncCookies(
  Network: ChromeClient['Network'],
  url: string,
  profile: string | null | undefined,
  logger: BrowserLogger,
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
    logger(`Cookie sync failed: ${message}`);
    return 0;
  }
}

async function readChromeCookies(url: string, profile?: string | null): Promise<CookieParam[]> {
  const moduleCandidate = (await import('chrome-cookies-secure')) as
    | ChromeCookiesSecureModule
    | { default?: ChromeCookiesSecureModule };
  let chromeModule: ChromeCookiesSecureModule | undefined;
  if ('getCookiesPromised' in moduleCandidate && typeof moduleCandidate.getCookiesPromised === 'function') {
    chromeModule = moduleCandidate;
  } else if ('default' in moduleCandidate) {
    chromeModule = moduleCandidate.default;
  }
  if (!chromeModule?.getCookiesPromised) {
    throw new Error('chrome-cookies-secure did not expose getCookiesPromised');
  }
  const urlsToCheck = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const merged = new Map<string, CookieParam>();
  for (const candidateUrl of urlsToCheck) {
    let rawCookies: unknown;
    try {
      rawCookies = await chromeModule.getCookiesPromised(candidateUrl, 'puppeteer', profile ?? undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[chatgpt-devtools] Failed to read cookies for ${candidateUrl}: ${message}`);
      continue;
    }
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
