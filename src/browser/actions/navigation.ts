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

export interface PromptReadyNavigationOptions {
  url: string;
  fallbackUrl?: string;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  headless: boolean;
  logger: BrowserLogger;
}

export interface PromptReadyNavigationDeps {
  navigateToChatGPT?: typeof navigateToChatGPT;
  ensureNotBlocked?: typeof ensureNotBlocked;
  ensurePromptReady?: typeof ensurePromptReady;
}

async function dismissBlockingUi(Runtime: ChromeClient['Runtime'], logger: BrowserLogger): Promise<boolean> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const labelFor = (el) => normalize(el?.textContent || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title'));
      const buttonCandidates = (root) =>
        Array.from(root.querySelectorAll('button,[role="button"],a')).filter((el) => isVisible(el));

      const roots = [
        ...Array.from(document.querySelectorAll('[role="dialog"],dialog')),
        document.body,
      ].filter(Boolean);
      for (const root of roots) {
        const buttons = buttonCandidates(root);
        const close = buttons.find((el) => labelFor(el).includes('close'));
        if (close) {
          (close).click();
          return { dismissed: true, action: 'close' };
        }
        const okLike = buttons.find((el) => {
          const label = labelFor(el);
          return (
            label === 'ok' ||
            label === 'got it' ||
            label === 'dismiss' ||
            label === 'continue' ||
            label === 'back' ||
            label.includes('back to chatgpt') ||
            label.includes('go to chatgpt') ||
            label.includes('return') ||
            label.includes('take me')
          );
        });
        if (okLike) {
          (okLike).click();
          return { dismissed: true, action: 'confirm' };
        }
      }
      return { dismissed: false };
    })()`,
    returnByValue: true,
  }).catch(() => null);
  const value = outcome?.result?.value as { dismissed?: boolean; action?: string } | undefined;
  if (value?.dismissed) {
    logger(`[nav] dismissed blocking UI (${value.action ?? 'unknown'})`);
    return true;
  }
  return false;
}

export async function navigateToPromptReadyWithFallback(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  options: PromptReadyNavigationOptions,
  deps: PromptReadyNavigationDeps = {},
): Promise<{ usedFallback: boolean }> {
  const {
    url,
    fallbackUrl,
    timeoutMs,
    fallbackTimeoutMs,
    headless,
    logger,
  } = options;
  const navigate = deps.navigateToChatGPT ?? navigateToChatGPT;
  const ensureBlocked = deps.ensureNotBlocked ?? ensureNotBlocked;
  const ensureReady = deps.ensurePromptReady ?? ensurePromptReady;

  await navigate(Page, Runtime, url, logger);
  await ensureBlocked(Runtime, headless, logger);
  await dismissBlockingUi(Runtime, logger).catch(() => false);
  try {
    await ensureReady(Runtime, timeoutMs, logger);
    return { usedFallback: false };
  } catch (error) {
    if (!fallbackUrl || fallbackUrl === url) {
      throw error;
    }
    const fallbackTimeout = fallbackTimeoutMs ?? Math.max(timeoutMs * 2, 120_000);
    logger(
      `Prompt not ready after ${Math.round(timeoutMs / 1000)}s on ${url}; retrying ${fallbackUrl} with ${Math.round(fallbackTimeout / 1000)}s timeout.`,
    );
    await navigate(Page, Runtime, fallbackUrl, logger);
    await ensureBlocked(Runtime, headless, logger);
    await dismissBlockingUi(Runtime, logger).catch(() => false);
    await ensureReady(Runtime, fallbackTimeout, logger);
    return { usedFallback: true };
  }
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
  options: { appliedCookies?: number | null; remoteSession?: boolean } = {},
) {
  // Learned: ChatGPT can render the UI (project view) while auth silently failed.
  // A backend-api probe plus DOM login CTA check catches both cases.
  const outcome = await Runtime.evaluate({
    expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
    awaitPromise: true,
    returnByValue: true,
  });
  const probe = normalizeLoginProbe(outcome.result?.value);
  if (probe.ok) {
    logger(`Login check passed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)})`);
    return;
  }

  const accepted = await attemptWelcomeBackLogin(Runtime, logger);
  if (accepted) {
    // Learned: "Welcome back" account picker needs a click even when cookies are valid,
    // and the redirect can lag, so re-probe before failing hard.
    await delay(1500);
    const retryOutcome = await Runtime.evaluate({
      expression: buildLoginProbeExpression(LOGIN_CHECK_TIMEOUT_MS),
      awaitPromise: true,
      returnByValue: true,
    });
    const retryProbe = normalizeLoginProbe(retryOutcome.result?.value);
    if (retryProbe.ok) {
      logger('Login restored via Welcome back account picker');
      return;
    }
    logger(
      `Login retry after Welcome back failed (status=${retryProbe.status}, domLoginCta=${Boolean(
        retryProbe.domLoginCta,
      )})`,
    );
  }

  logger(
    `Login probe failed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)}, onAuthPage=${Boolean(
      probe.onAuthPage,
    )}, url=${probe.pageUrl ?? 'n/a'}, error=${probe.error ?? 'none'})`,
  );

  const domLabel = probe.domLoginCta ? ' Login button detected on page.' : '';
  const cookieHint = options.remoteSession
    ? 'The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun.'
    : (options.appliedCookies ?? 0) === 0
      ? 'No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).'
      : 'ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).';

  throw new Error(`ChatGPT session not detected.${domLabel} ${cookieHint}`);
}

async function attemptWelcomeBackLogin(Runtime: ChromeClient['Runtime'], logger: BrowserLogger): Promise<boolean> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      // Learned: "Welcome back" shows as a modal with account chips; click the email chip.
      const TIMEOUT_MS = 30000;
      const getLabel = (node) =>
        (node?.textContent || node?.getAttribute?.('aria-label') || '').trim();
      const isAccount = (label) =>
        Boolean(label) &&
        label.includes('@') &&
        !/log in|sign up|create account|another account/i.test(label);
      const findAccount = () => {
        const candidates = Array.from(document.querySelectorAll('[role="button"],button,a'));
        return candidates.find((node) => isAccount(getLabel(node))) || null;
      };
      const clickAccount = () => {
        const account = findAccount();
        if (!account) return null;
        try {
          (account).click();
        } catch (_error) {
          return { clicked: false, reason: 'click-failed' };
        }
        return { clicked: true, label: getLabel(account) };
      };
      const immediate = clickAccount();
      if (immediate) {
        return immediate;
      }
      const root = document.documentElement || document.body;
      if (!root) {
        return { clicked: false, reason: 'no-root' };
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          resolve({ clicked: false, reason: 'timeout' });
        }, TIMEOUT_MS);
        const observer = new MutationObserver(() => {
          const result = clickAccount();
          if (result) {
            clearTimeout(timer);
            observer.disconnect();
            resolve(result);
          }
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (outcome.exceptionDetails) {
    const details = outcome.exceptionDetails;
    const description =
      (details.exception && typeof details.exception.description === 'string' && details.exception.description) ||
      details.text ||
      'unknown error';
    logger(`Welcome back auto-select probe failed: ${description}`);
  }
  const result = outcome.result?.value as { clicked?: boolean; reason?: string; label?: string } | undefined;
  if (!result) {
    logger('Welcome back auto-select probe returned no result.');
    return false;
  }
  if (result?.clicked) {
    logger(`Welcome back modal detected; selected account ${result.label ?? '(unknown)'}`);
    return true;
  }
  if (result?.reason && result.reason !== 'timeout') {
    logger(`Welcome back modal present but auto-select failed (${result.reason}).`);
  }
  if (result?.reason === 'timeout') {
    logger('Welcome back modal not detected after login probe failure.');
  }
  return false;
}

export async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: BrowserLogger) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    const authUrl = await currentUrl(Runtime);
    if (authUrl && isAuthLoginUrl(authUrl)) {
      // Learned: auth.openai.com/login can appear after cookies are copied; allow manual login window.
      logger('Auth login page detected; waiting for manual login to complete...');
      const extended = Math.min(Math.max(timeoutMs, 60_000), 20 * 60_000);
      const loggedIn = await waitForPrompt(Runtime, extended);
      if (loggedIn) {
        return;
      }
    }
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

async function currentUrl(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: 'typeof location === "object" && location.href ? location.href : null',
    returnByValue: true,
  });
  return typeof result?.value === 'string' ? result.value : null;
}

function isAuthLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('auth.openai.com')) {
      return true;
    }
    return /^\/log-?in/i.test(parsed.pathname);
  } catch {
    return false;
  }
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
  return `(async () => {
    // Learned: /backend-api/me is the most reliable "am I logged in" signal.
    // Some UIs render without a session; use DOM + network for a robust answer.
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

    let status = 0;
    let error = null;
    try {
      if (typeof fetch === 'function') {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          // Credentials included so we see a 200 only when cookies are valid.
          const response = await fetch('/backend-api/me', {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          status = response.status || 0;
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      error = err ? String(err) : 'unknown';
    }

    const domLoginCta = hasLoginCta();
    const loginSignals = domLoginCta || onAuthPage;
    clearTimeout(timer);
    return {
      ok: !loginSignals && (status === 0 || status === 200),
      status,
      redirected: false,
      url: pageUrl,
      pageUrl,
      domLoginCta,
      onAuthPage,
      error,
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
