import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  CLOUDFLARE_SCRIPT_SELECTOR,
  CLOUDFLARE_TITLE,
  INPUT_SELECTORS,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function navigateToChatGPT(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export async function ensureNotBlocked(Runtime: ChromeClient['Runtime'], headless: boolean, logger: BrowserLogger) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? 'Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge.'
      : 'Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.';
    logger('Cloudflare anti-bot page detected');
    throw new Error(message);
  }
}

const LOGIN_CHECK_TIMEOUT_MS = 5_000;

export async function ensureLoggedIn(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  options: { appliedCookies?: number | null; remoteSession?: boolean; profileSync?: boolean } = {},
) {
  const outcome = await Runtime.evaluate({
    expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
    awaitPromise: true,
    returnByValue: true,
  });
  const probe = normalizeLoginProbe(outcome.result?.value);
  if (probe.ok && !probe.domLoginCta && !probe.onAuthPage) {
    logger('Login check passed (no login button detected on page)');
    return;
  }

  const domLabel = probe.domLoginCta ? ' Login button detected on page.' : '';
  const cookieHint = options.remoteSession
    ? 'The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun.'
    : options.profileSync
      ? 'The synced Chrome profile appears logged out. Open chatgpt.com in your main Chrome profile to refresh the session or rerun with --browser-fresh-profile for a fresh profile.'
      : (options.appliedCookies ?? 0) === 0
        ? 'No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).'
        : 'ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).';

  throw new Error(`ChatGPT session not detected.${domLabel} ${cookieHint}`);
}

export async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: BrowserLogger) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    await logDomFailure(Runtime, logger, 'prompt-textarea');
    throw new Error('Prompt textarea did not appear before timeout');
  }
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time');
}

async function waitForPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function isCloudflareInterstitial(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const title = typeof titleResult.value === 'string' ? titleResult.value : '';
  const challengeTitle = CLOUDFLARE_TITLE.toLowerCase();
  if (title.toLowerCase().includes(challengeTitle)) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('${CLOUDFLARE_SCRIPT_SELECTOR}'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

type LoginProbeResult = {
  ok: boolean;
  status: number;
  url?: string | null;
  redirected?: boolean;
  error?: string | null;
  pageUrl?: string | null;
  domLoginCta?: boolean;
  onAuthPage?: boolean;
};

function buildLoginProbeExpression(timeoutMs: number): string {
  return `(() => {
    const timer = setTimeout(() => {}, ${timeoutMs});
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    const hasLoginCta = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    };

    const domLoginCta = hasLoginCta();
    clearTimeout(timer);
    return {
      ok: !domLoginCta && !onAuthPage,
      status: 0,
      redirected: false,
      url: pageUrl,
      pageUrl,
      domLoginCta,
      onAuthPage,
    };
  })()`;
}

function normalizeLoginProbe(raw: unknown): LoginProbeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 0 };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === 'number'
      ? statusRaw
      : typeof statusRaw === 'string' && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;

  return {
    ok: Boolean(value.ok),
    status: Number.isFinite(status) ? (status as number) : 0,
    url: typeof value.url === 'string' ? value.url : null,
    redirected: Boolean(value.redirected),
    error: typeof value.error === 'string' ? value.error : null,
    pageUrl: typeof value.pageUrl === 'string' ? value.pageUrl : null,
    domLoginCta: Boolean(value.domLoginCta),
    onAuthPage: Boolean(value.onAuthPage),
  };
}
