import { COOKIE_URLS } from './constants.js';
import type { BrowserLogger, ChromeClient, CookieParam } from './types.js';
import { delay } from './utils.js';
import { getCookies, type Cookie } from '@steipete/sweet-cookie';

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
    waitMs?: number;
  } = {},
) {
  const { allowErrors = false, filterNames, inlineCookies, cookiePath, waitMs = 0 } = options;
  try {
    // Learned: inline cookies are the most deterministic (avoid Keychain + profile ambiguity).
    const cookies = inlineCookies?.length
      ? normalizeInlineCookies(inlineCookies, new URL(url).hostname)
      : await readChromeCookiesWithWait(
          url,
          profile,
          filterNames ?? undefined,
          cookiePath ?? undefined,
          waitMs,
          logger,
        );
    if (!cookies.length) {
      return 0;
    }
    let applied = 0;
    for (const cookie of cookies) {
      const cookieWithUrl = attachUrl(cookie, url);
      try {
        // Learned: CDP will silently drop cookies without a url; always attach one.
        const result = await Network.setCookie(cookieWithUrl as Parameters<typeof Network.setCookie>[0]);
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

async function readChromeCookiesWithWait(
  url: string,
  profile: string | null | undefined,
  filterNames: string[] | undefined,
  cookiePath: string | null | undefined,
  waitMs: number,
  logger: BrowserLogger,
): Promise<CookieParam[]> {
  if (waitMs <= 0) {
    return readChromeCookies(url, profile, filterNames, cookiePath);
  }
  let cookies: CookieParam[] = [];
  let firstError: unknown;
  try {
    cookies = await readChromeCookies(url, profile, filterNames, cookiePath);
  } catch (error) {
    firstError = error;
  }

  if (cookies.length > 0 && !firstError) {
    return cookies;
  }

  const waitLabel = waitMs >= 1000 ? `${Math.round(waitMs / 1000)}s` : `${waitMs}ms`;
  const message = firstError instanceof Error ? firstError.message : String(firstError ?? '');
  if (firstError) {
    logger(`[cookies] Cookie read failed (${message}); waiting ${waitLabel} then retrying once.`);
  } else {
    logger(`[cookies] No cookies found; waiting ${waitLabel} then retrying once.`);
  }
  await delay(waitMs);
  return readChromeCookies(url, profile, filterNames, cookiePath);
}

async function readChromeCookies(
  url: string,
  profile?: string | null,
  filterNames?: string[],
  cookiePath?: string | null,
): Promise<CookieParam[]> {
  const origins = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const chromeProfile = cookiePath ?? profile ?? undefined;
  const timeoutMs = readDuration('ORACLE_COOKIE_LOAD_TIMEOUT_MS', 5_000);

  // Learned: read from multiple origins to capture auth cookies that land on chat.openai.com + atlas.
  const { cookies, warnings } = await getCookies({
    url,
    origins,
    names: filterNames?.length ? filterNames : undefined,
    browsers: ['chrome'],
    mode: 'merge',
    chromeProfile,
    timeoutMs,
  });

  if (process.env.ORACLE_DEBUG_COOKIES === '1' && warnings.length) {
    // eslint-disable-next-line no-console
    console.log(`[cookies] sweet-cookie warnings:\n- ${warnings.join('\n- ')}`);
  }

  const merged = new Map<string, CookieParam>();
  for (const cookie of cookies) {
    const normalized = toCdpCookie(cookie);
    if (!normalized) continue;
    const key = `${normalized.domain ?? ''}:${normalized.name}`;
    if (!merged.has(key)) merged.set(key, normalized);
  }

  return Array.from(merged.values());
}

function normalizeInlineCookies(rawCookies: CookieParam[], fallbackHost: string): CookieParam[] {
  const merged = new Map<string, CookieParam>();
  for (const cookie of rawCookies) {
    if (!cookie?.name) continue;
    // Learned: inline cookies may omit url/domain; default to current host with a safe path.
    const normalized: CookieParam = {
      name: cookie.name,
      value: cookie.value ?? '',
      url: cookie.url,
      domain: cookie.domain ?? fallbackHost,
      path: cookie.path ?? '/',
      expires: normalizeExpiration(cookie.expires),
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: cookie.sameSite,
    };
    const key = `${normalized.domain ?? fallbackHost}:${normalized.name}`;
    if (!merged.has(key)) {
      merged.set(key, normalized);
    }
  }
  return Array.from(merged.values());
}

function toCdpCookie(cookie: Cookie): CookieParam | null {
  if (!cookie?.name) return null;
  const out: CookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === 'number') out.expires = cookie.expires;
  if (cookie.sameSite === 'Lax' || cookie.sameSite === 'Strict' || cookie.sameSite === 'None') {
    out.sameSite = cookie.sameSite;
  }
  return out;
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
    // Learned: CDP rejects cookies with both url + domain in some cases; drop domain to avoid failures.
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
    // Learned: Chrome may store WebKit microseconds since 1601; convert to Unix seconds.
    return Math.round(value / 1_000_000 - 11644473600);
  }
  if (value > 1_000_000_000) {
    // Likely milliseconds; normalize to seconds for CDP.
    return Math.round(value / 1000);
  }
  return Math.round(value);
}

function readDuration(envKey: string, defaultValueMs: number): number {
  const raw = process.env[envKey];
  if (!raw) return defaultValueMs;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValueMs;
}
