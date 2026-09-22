import { COOKIE_URLS } from "./constants.js";
import type { BrowserLogger, ChromeClient, CookieParam } from "./types.js";
import { delay } from "./utils.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";

export class ChromeCookieSyncError extends Error {}

/**
 * Thrown when we skip the macOS Keychain read entirely because no interactive
 * session is available to answer the one-time "Always Allow" prompt. Distinct
 * from ChromeCookieSyncError (a real Keychain/CDP failure) so callers can tell
 * "we didn't even try" apart from "we tried and it failed".
 */
export class ChromeKeychainNonInteractiveError extends ChromeCookieSyncError {}

export interface KeychainInteractivityContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

/**
 * macOS's Keychain ACL prompt has nowhere to render and nobody to click when
 * Oracle is invoked from a non-interactive/background process (e.g. an agent
 * or automation with no attached WindowServer session): `security
 * find-generic-password` just hangs until its timeout and then fails. Detect
 * that up front so we can fail fast instead of waiting out the timeout.
 */
export function isLikelyNonInteractiveKeychainSession(
  context: KeychainInteractivityContext = {},
): boolean {
  const platform = context.platform ?? process.platform;
  if (platform !== "darwin") {
    // The Keychain prompt hang is macOS-specific; other platforms take other paths.
    return false;
  }
  const env = context.env ?? process.env;
  if (env.ORACLE_ASSUME_INTERACTIVE === "1") {
    return false;
  }
  if (env.VITEST) {
    // Learned: the test suite mocks sweet-cookie's getCookies entirely, so it never
    // touches the real Keychain; don't let this check trip on CI's non-TTY runners.
    return false;
  }
  if (env.ORACLE_NONINTERACTIVE === "1" || env.CI === "true" || env.CI === "1") {
    return true;
  }
  const stdinIsTTY = context.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = context.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  return !stdinIsTTY && !stdoutIsTTY;
}

export function nonInteractiveKeychainErrorMessage(): string {
  return (
    "No interactive session detected: skipping the macOS Keychain read for Chrome cookie copy " +
    "instead of waiting for a prompt nobody can answer. Cookie-copy mode needs a one-time human " +
    '"Always Allow" approval in Keychain Access, so it cannot work unattended from an automation ' +
    "or agent process.\n" +
    "Recommended: use --browser-manual-login (add --browser-manual-login-profile-dir for a persistent, " +
    "reusable profile) instead of Chrome cookie copy for automation/agent runs. If you're already using " +
    "--browser-manual-login with --browser-manual-login-cookie-sync, drop --browser-manual-login-cookie-sync " +
    "or complete one interactive login first so no Keychain read is required.\n" +
    "Set ORACLE_ASSUME_INTERACTIVE=1 to bypass this check if you know a human is available to approve the prompt."
  );
}

export async function clearStaleChatGptConversationCookies(
  Network: ChromeClient["Network"],
  Target: ChromeClient["Target"],
  logger: BrowserLogger,
  options: { preserveConversationIds?: readonly (string | null | undefined)[] } = {},
): Promise<number> {
  try {
    const preservedNames = new Set(
      (options.preserveConversationIds ?? [])
        .filter((id): id is string => Boolean(id))
        .map((id) => `conv_key_${id}`),
    );
    try {
      const { targetInfos = [] } = await Target.getTargets();
      for (const target of targetInfos) {
        const conversationId = extractChatGptConversationId(target.url ?? "");
        if (conversationId) {
          preservedNames.add(`conv_key_${conversationId}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `[cookies] Failed to inspect active ChatGPT conversations; skipping stale cookie cleanup: ${message}`,
      );
      return 0;
    }

    const { cookies = [] } = await Network.getAllCookies();
    const targets = cookies.filter(
      (cookie) =>
        isChatGptConversationCookie(cookie) && !preservedNames.has(String(cookie.name ?? "")),
    );
    if (targets.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (const cookie of targets) {
      try {
        await Network.deleteCookies({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path ?? "/",
        });
        deleted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`[cookies] Failed to clear a stale ChatGPT conversation cookie: ${message}`);
      }
    }

    if (deleted > 0) {
      logger(
        `[cookies] Cleared ${deleted} stale ChatGPT conversation cookie${deleted === 1 ? "" : "s"}.`,
      );
    }
    return deleted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[cookies] Failed to inspect ChatGPT conversation cookies: ${message}`);
    return 0;
  }
}

export async function syncCookies(
  Network: ChromeClient["Network"],
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
        const result = await Network.setCookie(
          cookieWithUrl as Parameters<NonNullable<ChromeClient["Network"]>["setCookie"]>[0],
        );
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
    if (error instanceof ChromeKeychainNonInteractiveError) {
      // Learned: this is a "we didn't even try" fail-fast, not a flaky Keychain/CDP error;
      // swallowing it under allowErrors would just trade a clear message for a slower,
      // more confusing "no cookies were applied" failure later. Always surface it.
      throw error;
    }
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

  if (firstError instanceof ChromeKeychainNonInteractiveError) {
    // Learned: waiting and retrying would just re-hit the same "no one can answer
    // the Keychain prompt" condition; fail fast instead of doubling the delay.
    throw firstError;
  }

  const waitLabel = waitMs >= 1000 ? `${Math.round(waitMs / 1000)}s` : `${waitMs}ms`;
  const message = firstError instanceof Error ? firstError.message : String(firstError ?? "");
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
  if (isLikelyNonInteractiveKeychainSession()) {
    throw new ChromeKeychainNonInteractiveError(nonInteractiveKeychainErrorMessage());
  }

  const origins = Array.from(new Set([stripQuery(url), ...COOKIE_URLS]));
  const chromeProfile = cookiePath ?? profile ?? undefined;
  const timeoutMs = readDuration("ORACLE_COOKIE_LOAD_TIMEOUT_MS", 5_000);

  // Learned: read from multiple origins to capture auth cookies that land on chat.openai.com + atlas.
  const { cookies, warnings } = await getCookies({
    url,
    origins,
    names: filterNames?.length ? filterNames : undefined,
    browsers: ["chrome"],
    mode: "merge",
    chromeProfile,
    timeoutMs,
  });

  if (process.env.ORACLE_DEBUG_COOKIES === "1" && warnings.length) {
    // eslint-disable-next-line no-console
    console.log(`[cookies] sweet-cookie warnings:\n- ${warnings.join("\n- ")}`);
  }

  const merged = new Map<string, CookieParam>();
  for (const cookie of cookies) {
    const normalized = toCdpCookie(cookie);
    if (!normalized) continue;
    const key = `${normalized.domain ?? ""}:${normalized.name}`;
    if (!merged.has(key)) merged.set(key, normalized);
  }

  return Array.from(merged.values());
}

function isChatGptConversationCookie(cookie: { name?: string; domain?: string }): boolean {
  if (!cookie.name?.startsWith("conv_key_")) {
    return false;
  }
  const domain = String(cookie.domain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  return domain === "chatgpt.com" || domain === "chat.openai.com";
}

function extractChatGptConversationId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase();
    if (domain !== "chatgpt.com" && domain !== "chat.openai.com") {
      return undefined;
    }
    return parsed.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function normalizeInlineCookies(rawCookies: CookieParam[], fallbackHost: string): CookieParam[] {
  const merged = new Map<string, CookieParam>();
  for (const cookie of rawCookies) {
    if (!cookie?.name) continue;
    // Learned: inline cookies may omit url/domain; default to current host with a safe path.
    const normalized: CookieParam = {
      name: cookie.name,
      value: cookie.value ?? "",
      url: cookie.url,
      domain: cookie.domain ?? fallbackHost,
      path: cookie.path ?? "/",
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
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === "number") out.expires = cookie.expires;
  if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
    out.sameSite = cookie.sameSite;
  }
  return out;
}

function attachUrl(cookie: CookieParam, fallbackUrl: string): CookieParam {
  const cookieWithUrl: CookieParam = { ...cookie };
  if (!cookieWithUrl.url) {
    if (!cookieWithUrl.domain || cookieWithUrl.domain === "localhost") {
      cookieWithUrl.url = fallbackUrl;
    } else if (!cookieWithUrl.domain.startsWith(".")) {
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
    parsed.hash = "";
    parsed.search = "";
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
  // Units by magnitude (do not treat Unix seconds ~1.7e9 as milliseconds):
  // - >= 1e15: Chrome/WebKit FILETIME microseconds since 1601
  // - >= 1e12: Unix milliseconds
  // - else: Unix seconds (sweet-cookie / Chromium Cookie.expires)
  if (value >= 1_000_000_000_000_000) {
    return Math.round(value / 1_000_000 - 11644473600);
  }
  if (value >= 1_000_000_000_000) {
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
