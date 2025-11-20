import { COOKIE_URLS } from './constants.js';
import type { BrowserLogger, ChromeClient, CookieParam } from './types.js';
import { loadChromeCookies } from './chromeCookies.js';

export class ChromeCookieSyncError extends Error {}

export async function syncCookies(
  Network: ChromeClient['Network'],
  url: string,
  profile: string | null | undefined,
  logger: BrowserLogger,
  options: {
    allowErrors?: boolean;
    filterNames?: string[] | null;
    inlineCookies?: CookieParam[] | null;
    cookiePath?: string | null;
  } = {},
) {
  const { allowErrors = false, filterNames, inlineCookies, cookiePath } = options;
  try {
    const cookies = inlineCookies?.length
      ? normalizeInlineCookies(inlineCookies, new URL(url).hostname)
      : await readChromeCookies(url, profile, filterNames ?? undefined, cookiePath ?? undefined);
    if (!cookies.length) {
      return 0;
    }
    let applied = 0;
    for (const cookie of cookies) {
      const cookieWithUrl = attachUrl(cookie, url);
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

async function readChromeCookies(
  url: string,
  profile?: string | null,
  filterNames?: string[],
  cookiePath?: string | null,
): Promise<CookieParam[]> {
  const urlsToCheck = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const merged = new Map<string, CookieParam>();
  const allowlist = normalizeCookieNames(filterNames);
  for (const candidateUrl of urlsToCheck) {
    const cookies = await loadChromeCookies({
      targetUrl: candidateUrl,
      profile: profile ?? undefined,
      explicitCookiePath: cookiePath ?? undefined,
      filterNames: allowlist ?? undefined,
    });
    const fallbackHostname = new URL(candidateUrl).hostname;
    for (const cookie of cookies) {
      const key = `${cookie.domain ?? fallbackHostname}:${cookie.name}`;
      if (!merged.has(key)) {
        merged.set(key, cookie);
      }
    }
  }
  return Array.from(merged.values());
}

function normalizeInlineCookies(rawCookies: CookieParam[], fallbackHost: string): CookieParam[] {
  const merged = new Map<string, CookieParam>();
  for (const cookie of rawCookies) {
    if (!cookie?.name) continue;
    const normalized: CookieParam = {
      ...cookie,
      name: cookie.name,
      value: cookie.value ?? '',
      domain: cookie.domain ?? fallbackHost,
      path: cookie.path ?? '/',
      expires: normalizeExpiration(cookie.expires),
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? false,
    };
    const key = `${normalized.domain ?? fallbackHost}:${normalized.name}`;
    if (!merged.has(key)) {
      merged.set(key, normalized);
    }
  }
  return Array.from(merged.values());
}

function normalizeCookieNames(names?: string[] | null): Set<string> | null {
  if (!names || names.length === 0) {
    return null;
  }
  return new Set(names.map((name) => name.trim()).filter(Boolean));
}

function attachUrl(cookie: CookieParam, fallbackUrl: string): CookieParam {
  const cookieWithUrl: CookieParam = { ...cookie };
  if (!cookieWithUrl.url) {
    if (!cookieWithUrl.domain || cookieWithUrl.domain === 'localhost') {
      cookieWithUrl.url = fallbackUrl;
    } else if (!cookieWithUrl.domain.startsWith('.')) {
      cookieWithUrl.url = `https://${cookieWithUrl.domain}`;
    }
  }
  // When url is present, let Chrome derive the host from it; keeping domain can trigger CDP sanitization errors.
  if (cookieWithUrl.url) {
    delete (cookieWithUrl as { domain?: string }).domain;
  }
  return cookieWithUrl;
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
