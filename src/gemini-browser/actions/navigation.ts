/**
 * Gemini Browser Navigation and Login Detection
 */

import type { ChromeClient } from '../../browser/types.js';
import type { BrowserLogger, GeminiLoginProbeResult } from '../types.js';
import {
  GEMINI_APP_URL,
  GEMINI_INPUT_SELECTORS,
  GEMINI_LOGIN_SELECTORS,
  GEMINI_TIMEOUTS,
} from '../constants.js';
import { delay } from '../../browser/utils.js';

/**
 * Navigate to Gemini app
 */
export async function navigateToGemini(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string = GEMINI_APP_URL,
  logger: BrowserLogger,
): Promise<void> {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, GEMINI_TIMEOUTS.navigation);
}

/**
 * Wait for document to reach ready state
 */
async function waitForDocumentReady(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time');
}

/**
 * Handle Google consent screen if present
 */
export async function handleGeminiConsent(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<boolean> {
  const expression = `(() => {
    // Check if we're on consent page
    const isConsentPage = location.href.includes('consent.google.com');
    if (!isConsentPage) return { onConsent: false };

    // Try to find and click "Accept all" button
    const buttons = Array.from(document.querySelectorAll('button'));
    const acceptBtn = buttons.find(btn =>
      btn.textContent?.toLowerCase().includes('accept all')
    );

    if (acceptBtn) {
      acceptBtn.click();
      return { onConsent: true, clicked: true };
    }

    return { onConsent: true, clicked: false };
  })()`;

  const { result } = await Runtime.evaluate({
    expression,
    returnByValue: true,
  });

  const outcome = result?.value as { onConsent?: boolean; clicked?: boolean } | undefined;

  if (outcome?.onConsent) {
    if (outcome.clicked) {
      logger('Accepted Google consent dialog');
      await delay(1500); // Wait for redirect
      return true;
    }
    logger('On consent page but could not find accept button');
  }

  return false;
}

/**
 * Check if user is logged into Gemini
 */
export async function probeGeminiLogin(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number = 5000,
): Promise<GeminiLoginProbeResult> {
  const expression = buildLoginProbeExpression(timeoutMs);

  const { result } = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  return normalizeLoginProbe(result?.value);
}

/**
 * Ensure user is logged into Gemini
 */
export async function ensureGeminiLoggedIn(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  options: { appliedCookies?: number; manualLogin?: boolean; remoteSession?: boolean } = {},
): Promise<void> {
  const probe = await probeGeminiLogin(Runtime);

  if (probe.ok) {
    logger(`Gemini login verified (url=${probe.pageUrl ?? 'n/a'})`);
    return;
  }

  // Try account picker if present
  const accountSelected = await attemptGeminiAccountSelection(Runtime, logger);
  if (accountSelected) {
    await delay(2000);
    const retryProbe = await probeGeminiLogin(Runtime);
    if (retryProbe.ok) {
      logger('Gemini login restored via account picker');
      return;
    }
  }

  // Handle manual login mode
  if (options.manualLogin) {
    logger('Manual login mode: waiting for user to sign into Google...');
    const deadline = Date.now() + GEMINI_TIMEOUTS.login;

    while (Date.now() < deadline) {
      const checkProbe = await probeGeminiLogin(Runtime);
      if (checkProbe.ok) {
        logger('Gemini login detected after manual sign-in');
        return;
      }
      await delay(2000);
    }

    throw new Error('Manual login timed out. Please sign into Google and try again.');
  }

  // Build error message with hints
  const cookieHint = options.remoteSession
    ? 'The remote Chrome session is not signed into Google. Sign in there, then rerun.'
    : (options.appliedCookies ?? 0) === 0
      ? 'No Google cookies were applied. Sign into gemini.google.com in Chrome first.'
      : 'Google session appears missing. Sign into gemini.google.com in Chrome.';

  throw new Error(`Gemini login not detected. ${cookieHint}`);
}

/**
 * Try to select an account from Google account picker
 */
async function attemptGeminiAccountSelection(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<boolean> {
  const expression = `(() => {
    // Look for account picker elements
    const accountElements = document.querySelectorAll('[data-identifier], .account-picker [role="button"]');

    for (const el of accountElements) {
      const identifier = el.getAttribute('data-identifier') || el.textContent || '';
      // Click the first account that looks like an email
      if (identifier.includes('@')) {
        el.click?.();
        return { clicked: true, account: identifier };
      }
    }

    return { clicked: false };
  })()`;

  const { result } = await Runtime.evaluate({
    expression,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked?: boolean; account?: string } | undefined;

  if (outcome?.clicked) {
    logger(`Selected Google account: ${outcome.account ?? 'unknown'}`);
    return true;
  }

  return false;
}

/**
 * Wait for Gemini prompt input to be ready
 */
export async function ensureGeminiPromptReady(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number = GEMINI_TIMEOUTS.promptReady,
  logger: BrowserLogger,
): Promise<void> {
  const ready = await waitForGeminiPrompt(Runtime, timeoutMs);

  if (!ready) {
    // Check if we're stuck on auth page
    const currentUrl = await getCurrentUrl(Runtime);
    if (currentUrl && isGoogleAuthUrl(currentUrl)) {
      logger('Google auth page detected; waiting for login to complete...');
      const extended = Math.min(timeoutMs * 4, GEMINI_TIMEOUTS.login);
      const loggedIn = await waitForGeminiPrompt(Runtime, extended);
      if (loggedIn) {
        return;
      }
    }
    throw new Error('Gemini prompt input did not appear before timeout');
  }
}

/**
 * Wait for prompt input element
 */
async function waitForGeminiPrompt(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const selectorsJson = JSON.stringify(GEMINI_INPUT_SELECTORS);

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${selectorsJson};
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

/**
 * Get current page URL
 */
async function getCurrentUrl(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: 'typeof location === "object" && location.href ? location.href : null',
    returnByValue: true,
  });
  return typeof result?.value === 'string' ? result.value : null;
}

/**
 * Check if URL is a Google auth page
 */
function isGoogleAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes('accounts.google.com') ||
      parsed.pathname.includes('/signin') ||
      parsed.pathname.includes('/login')
    );
  } catch {
    return false;
  }
}

/**
 * Build JavaScript expression to probe login state
 */
function buildLoginProbeExpression(_timeoutMs: number): string {
  const loginSelectorsJson = JSON.stringify(GEMINI_LOGIN_SELECTORS);

  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage = pageUrl && (
      pageUrl.includes('accounts.google.com') ||
      pageUrl.includes('/signin') ||
      pageUrl.includes('/login')
    );

    // Check for login buttons/links
    const hasLoginUi = (() => {
      const selectors = ${loginSelectorsJson};
      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            const text = (el.textContent || '').toLowerCase();
            if (text.includes('sign in') || text.includes('log in')) {
              return true;
            }
          }
        } catch {}
      }
      return false;
    })();

    // Check for logged-in indicators (profile image, account button)
    const hasProfileIndicator = (() => {
      const indicators = [
        '[aria-label*="Google Account"]',
        'img[src*="googleusercontent.com"][alt]',
        '[data-ogsr-up]',
        '.gb_d[aria-label]',
      ];
      for (const selector of indicators) {
        if (document.querySelector(selector)) return true;
      }
      return false;
    })();

    // Check if we're on the actual Gemini app (not landing page)
    const onGeminiApp = pageUrl && (
      pageUrl.includes('gemini.google.com/app') ||
      pageUrl.includes('gemini.google.com/chat')
    );

    // Determine login state
    const loggedIn = hasProfileIndicator || (onGeminiApp && !hasLoginUi && !onAuthPage);

    return {
      ok: loggedIn,
      status: loggedIn ? 200 : 401,
      pageUrl,
      loginUiDetected: hasLoginUi,
      onAuthPage,
      error: null,
    };
  })()`;
}

/**
 * Normalize login probe result
 */
function normalizeLoginProbe(raw: unknown): GeminiLoginProbeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 0 };
  }

  const value = raw as Record<string, unknown>;

  return {
    ok: Boolean(value.ok),
    status: typeof value.status === 'number' ? value.status : 0,
    pageUrl: typeof value.pageUrl === 'string' ? value.pageUrl : null,
    loginUiDetected: Boolean(value.loginUiDetected),
    onAuthPage: Boolean(value.onAuthPage),
    error: typeof value.error === 'string' ? value.error : null,
  };
}
