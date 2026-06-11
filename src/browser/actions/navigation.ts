import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  CLOUDFLARE_SCRIPT_SELECTOR,
  CLOUDFLARE_TITLE,
  CONVERSATION_TURN_SELECTOR,
  INPUT_SELECTORS,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

export function installJavaScriptDialogAutoDismissal(
  Page: ChromeClient["Page"],
  logger: BrowserLogger,
): () => void {
  type DialogEvent = { type?: string; message?: string };
  const pageAny = Page as unknown as {
    on?: (event: string, listener: (params: DialogEvent) => void) => void;
    off?: (event: string, listener: (params: DialogEvent) => void) => void;
    removeListener?: (event: string, listener: (params: DialogEvent) => void) => void;
    handleJavaScriptDialog?: (params: { accept: boolean; promptText?: string }) => Promise<void>;
  };

  if (typeof pageAny.on !== "function" || typeof pageAny.handleJavaScriptDialog !== "function") {
    return () => {};
  }

  const handler = async (params: DialogEvent) => {
    const type = typeof params?.type === "string" ? params.type : "unknown";
    const message = typeof params?.message === "string" ? params.message : "";
    logger(`[nav] dismissing JS dialog (${type})${message ? `: ${message.slice(0, 140)}` : ""}`);
    try {
      await pageAny.handleJavaScriptDialog?.({ accept: true, promptText: "" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger(`[nav] failed to dismiss JS dialog: ${msg}`);
    }
  };

  pageAny.on("javascriptDialogOpening", handler);
  return () => {
    try {
      pageAny.off?.("javascriptDialogOpening", handler);
    } catch {
      try {
        pageAny.removeListener?.("javascriptDialogOpening", handler);
      } catch {
        // ignore
      }
    }
  };
}

export async function navigateToChatGPT(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
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

async function dismissBlockingUi(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<boolean> {
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
    logger(`[nav] dismissed blocking UI (${value.action ?? "unknown"})`);
    return true;
  }
  return false;
}

export async function navigateToPromptReadyWithFallback(
  Page: ChromeClient["Page"],
  Runtime: ChromeClient["Runtime"],
  options: PromptReadyNavigationOptions,
  deps: PromptReadyNavigationDeps = {},
): Promise<{ usedFallback: boolean }> {
  const { url, fallbackUrl, timeoutMs, fallbackTimeoutMs, headless, logger } = options;
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
    await navigate(Page, Runtime, "about:blank", logger);
    await delay(250);
    await navigate(Page, Runtime, fallbackUrl, logger);
    await ensureBlocked(Runtime, headless, logger);
    await dismissBlockingUi(Runtime, logger).catch(() => false);
    await ensureReady(Runtime, fallbackTimeout, logger);
    return { usedFallback: true };
  }
}

export async function ensureNotBlocked(
  Runtime: ChromeClient["Runtime"],
  headless: boolean,
  logger: BrowserLogger,
) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? "Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge."
      : "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.";
    logger("Cloudflare anti-bot page detected");
    throw new BrowserAutomationError(message, { stage: "cloudflare-challenge", headless });
  }
  if (await isChatGptAccountSecurityBlock(Runtime)) {
    const message =
      "ChatGPT account security block detected. Open chatgpt.com in Chrome, secure the account, then rerun Oracle.";
    logger("ChatGPT account security block detected");
    throw new BrowserAutomationError(message, { stage: "chatgpt-account-blocked" });
  }
}

const LOGIN_CHECK_TIMEOUT_MS = 5_000;
const CHATGPT_ACCOUNT_EMAIL_ENV = "ORACLE_CHATGPT_ACCOUNT_EMAIL";

function preferredChatGptAccountEmail(): string | null {
  const email = process.env[CHATGPT_ACCOUNT_EMAIL_ENV]?.trim().toLowerCase();
  return email ? email : null;
}

export async function ensureLoggedIn(
  Runtime: ChromeClient["Runtime"],
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
    logger(
      `Login check passed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)}, appAuthenticated=${Boolean(probe.appAuthenticated)})`,
    );
    return;
  }

  const welcomeBack = await attemptWelcomeBackLogin(
    Runtime,
    logger,
    preferredChatGptAccountEmail(),
  );
  if (welcomeBack.accepted) {
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
      logger("Login restored via Welcome back account picker");
      return;
    }
    logger(
      `Login retry after Welcome back failed (status=${retryProbe.status}, domLoginCta=${Boolean(
        retryProbe.domLoginCta,
      )}, appAuthenticated=${Boolean(retryProbe.appAuthenticated)})`,
    );
  }

  logger(
    `Login probe failed (status=${probe.status}, domLoginCta=${Boolean(probe.domLoginCta)}, onAuthPage=${Boolean(
      probe.onAuthPage,
    )}, appAuthenticated=${Boolean(probe.appAuthenticated)}, cfBlocked=${Boolean(probe.cfBlocked)}, url=${probe.pageUrl ?? "n/a"}, error=${probe.error ?? "none"})`,
  );

  const domLabel = probe.domLoginCta ? " Login button detected on page." : "";
  const cookieHint = options.remoteSession
    ? "The remote Chrome session is not signed into ChatGPT. Sign in there, then rerun."
    : (options.appliedCookies ?? 0) === 0
      ? "No ChatGPT cookies were applied; sign in to chatgpt.com in Chrome or pass inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON)."
      : "ChatGPT login appears missing; open chatgpt.com in Chrome to refresh the session or provide inline cookies (--browser-inline-cookies[(-file)] / ORACLE_BROWSER_COOKIES_JSON).";

  const accountHint = welcomeBack.hint ? ` ${welcomeBack.hint}` : "";
  throw new Error(`ChatGPT session not detected.${domLabel}${accountHint} ${cookieHint}`);
}

interface WelcomeBackLoginAttempt {
  accepted: boolean;
  hint?: string;
}

async function attemptWelcomeBackLogin(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  preferredEmail: string | null = null,
): Promise<WelcomeBackLoginAttempt> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let outcome;
    try {
      outcome = await Runtime.evaluate({
        expression: buildWelcomeBackAccountPickerExpression(preferredEmail),
        awaitPromise: false,
        returnByValue: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/navigated or closed|context was destroyed|target closed/i.test(message)) {
        logger("Welcome back account click triggered navigation.");
        return { accepted: true };
      }
      logger(`Welcome back auto-select probe failed: ${message}`);
      return { accepted: false };
    }
    if (outcome.exceptionDetails) {
      const details = outcome.exceptionDetails;
      const description =
        (details.exception &&
          typeof details.exception.description === "string" &&
          details.exception.description) ||
        details.text ||
        "unknown error";
      logger(`Welcome back auto-select probe failed: ${description}`);
      return { accepted: false };
    }
    const result = outcome.result?.value as
      | {
          clicked?: boolean;
          reason?: string;
          selection?: "preferred" | "only-account";
          accountCount?: number;
        }
      | undefined;
    if (!result) {
      logger("Welcome back auto-select probe returned no result.");
      return { accepted: false };
    }
    if (!("clicked" in result) && !("reason" in result)) {
      logger("Welcome back auto-select probe returned an unexpected result.");
      return { accepted: false };
    }
    if (result.clicked) {
      logger(
        result.selection === "preferred"
          ? "Welcome back modal detected; selected configured account."
          : "Welcome back modal detected; selected only saved account.",
      );
      return { accepted: true };
    }
    if (result.reason === "preferred-not-found") {
      logger(
        `Welcome back modal present but ${CHATGPT_ACCOUNT_EMAIL_ENV} did not match any saved account (${result.accountCount ?? 0} account chips found).`,
      );
      return {
        accepted: false,
        hint: `${CHATGPT_ACCOUNT_EMAIL_ENV} did not match a saved account. Set it to the exact account email on the browser host or sign in manually.`,
      };
    }
    if (result.reason === "multiple-accounts") {
      logger(
        `Welcome back modal present with multiple saved accounts; refusing to select one without ${CHATGPT_ACCOUNT_EMAIL_ENV}.`,
      );
      return {
        accepted: false,
        hint: `Multiple saved ChatGPT accounts were found. Set ${CHATGPT_ACCOUNT_EMAIL_ENV} to the exact account email on the browser host.`,
      };
    }
    if (result.reason && result.reason !== "not-found") {
      logger(`Welcome back modal present but auto-select failed (${result.reason}).`);
      return { accepted: false };
    }
    await delay(500);
  }
  logger("Welcome back modal not detected after login probe failure.");
  return { accepted: false };
}

function buildWelcomeBackAccountPickerExpression(preferredEmail: string | null = null): string {
  const normalizedPreferredEmail = preferredEmail?.trim().toLowerCase() || null;
  return `(() => {
    // Learned: "Welcome back" can list several saved accounts; substring matching can select the wrong identity.
    const preferredEmail = ${JSON.stringify(normalizedPreferredEmail)};
    const getLabel = (node) =>
      [node?.textContent, node?.getAttribute?.('aria-label')]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' ')
        .trim();
    const extractEmails = (label) =>
      String(label || '')
        .toLowerCase()
        .match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*/g) || [];
    const isAccount = (label) => !/log in|sign up|create account|another account/i.test(label);
    const candidates = Array.from(document.querySelectorAll('[role="button"],button,a'));
    const accounts = candidates
      .map((node) => {
        const label = getLabel(node);
        return { node, emails: isAccount(label) ? extractEmails(label) : [] };
      })
      .filter((entry) => entry.emails.length > 0);
    if (!accounts.length) {
      return { clicked: false, reason: 'not-found' };
    }
    const savedEmails = Array.from(new Set(accounts.flatMap((entry) => entry.emails)));
    if (!preferredEmail && savedEmails.length !== 1) {
      return { clicked: false, reason: 'multiple-accounts', accountCount: savedEmails.length };
    }
    const selectedEmail = preferredEmail || savedEmails[0];
    const account = accounts.find((entry) => entry.emails.includes(selectedEmail));
    if (!account) {
      return { clicked: false, reason: 'preferred-not-found', accountCount: savedEmails.length };
    }
    setTimeout(() => {
      try {
        account.node.click();
      } catch {
        // ignore; caller will re-probe login state
      }
    }, 0);
    return {
      clicked: true,
      selection: preferredEmail ? 'preferred' : 'only-account',
      accountCount: savedEmails.length,
    };
  })()`;
}

export async function ensurePromptReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    const authUrl = await currentUrl(Runtime);
    if (authUrl && isAuthLoginUrl(authUrl)) {
      // Learned: auth.openai.com/login can appear after cookies are copied; allow manual login window.
      logger("Auth login page detected; waiting for manual login to complete...");
      const extended = Math.min(Math.max(timeoutMs, 60_000), 20 * 60_000);
      const loggedIn = await waitForPrompt(Runtime, extended);
      if (loggedIn) {
        return;
      }
    }
    await logDomFailure(Runtime, logger, "prompt-textarea");
    throw new Error("Prompt textarea did not appear before timeout");
  }
}

export interface ResumedConversationHydrationDeps {
  ensurePromptReady?: typeof ensurePromptReady;
  requirePriorTurns?: boolean;
  expectedConversationUrl?: string;
}

function conversationIdFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * After navigating to a *resumed* ChatGPT conversation, its prior turns hydrate
 * asynchronously and ChatGPT can reset the composer mid-hydration — wiping a
 * freshly-typed prompt. A fresh chat has no history, so it never hits this race;
 * a large resumed thread reliably does.
 *
 * Wait for the prior turns to render AND stop growing (a big thread keeps
 * appending turns as it hydrates), let React settle, then re-confirm the
 * composer is ready — before the caller types/submits. Shared by the local and
 * remote browser execution paths so neither loses the submitted prompt.
 *
 * Returns the number of prior turns observed once hydration settled.
 */
export async function waitForResumedConversationHydration(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  deps: ResumedConversationHydrationDeps = {},
): Promise<number> {
  const ensureReady = deps.ensurePromptReady ?? ensurePromptReady;
  const hydrationDeadline = Date.now() + Math.min(timeoutMs || 30_000, 30_000);
  let priorTurns = 0;
  let stableChecks = 0;
  let settled = false;
  while (Date.now() < hydrationDeadline) {
    let turns = 0;
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${JSON.stringify(
          CONVERSATION_TURN_SELECTOR,
        )}).length`,
        returnByValue: true,
      });
      turns = typeof result?.value === "number" ? result.value : 0;
    } catch {
      // keep polling until the conversation hydrates
    }
    if (turns > 0 && turns === priorTurns) {
      stableChecks += 1;
      if (stableChecks >= 3) {
        settled = true;
        break;
      }
    } else {
      stableChecks = 0;
    }
    priorTurns = turns;
    await delay(250);
  }
  await delay(1_000); // final settle so React won't wipe the composer after we type
  await ensureReady(Runtime, timeoutMs, logger);
  if ((deps.requirePriorTurns ?? false) && (!settled || priorTurns <= 0)) {
    throw new BrowserAutomationError(
      "Saved ChatGPT conversation did not load stable prior turns; refusing to submit follow-up as a fresh chat.",
      {
        stage: "resume-conversation",
        priorTurns,
        settled,
      },
    );
  }
  if (deps.expectedConversationUrl) {
    const { result } = await Runtime.evaluate({
      expression: "location.href",
      returnByValue: true,
    });
    const actualUrl = typeof result?.value === "string" ? result.value : undefined;
    const expectedConversationId = conversationIdFromUrl(deps.expectedConversationUrl);
    const actualConversationId = conversationIdFromUrl(actualUrl);
    if (!expectedConversationId || actualConversationId !== expectedConversationId) {
      throw new BrowserAutomationError(
        "Saved ChatGPT conversation redirected to a different thread; refusing to submit follow-up.",
        {
          stage: "resume-conversation",
          expectedConversationId,
          actualConversationId,
          actualUrl,
        },
      );
    }
  }
  logger(`[browser] Resumed conversation hydrated (${priorTurns} prior turns); composer settled.`);
  return priorTurns;
}

async function waitForDocumentReady(Runtime: ChromeClient["Runtime"], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === "complete" || result?.value === "interactive") {
      return;
    }
    await delay(100);
  }
  throw new Error("Page did not reach ready state in time");
}

async function currentUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: 'typeof location === "object" && location.href ? location.href : null',
    returnByValue: true,
  });
  return typeof result?.value === "string" ? result.value : null;
}

function isAuthLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("auth.openai.com")) {
      return true;
    }
    return /^\/log-?in/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function waitForPrompt(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<boolean> {
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

async function isCloudflareInterstitial(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({
    expression: "document.title",
    returnByValue: true,
  });
  const title = typeof titleResult.value === "string" ? titleResult.value : "";
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

async function isChatGptAccountSecurityBlock(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const outcome = await Runtime.evaluate({
      expression: `(() => {
        const text = String(document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ');
        return text.includes('suspicious activity detected') &&
          text.includes('secure your account') &&
          text.includes('regain access');
      })()`,
      returnByValue: true,
    });
    return Boolean(outcome?.result?.value);
  } catch {
    return false;
  }
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
  appAuthenticated?: boolean;
  cfBlocked?: boolean;
};

function buildLoginProbeExpression(timeoutMs: number): string {
  return `(async () => {
    // Learned: /backend-api/me is the most reliable "am I logged in" signal.
    // Some UIs render without a session; use DOM + network for a robust answer.
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
        return (
          ['log in', 'login', 'sign in', 'signin', 'sign up for free'].includes(normalized) ||
          normalized.startsWith('continue with') ||
          normalized.includes('get responses tailored to you') ||
          normalized.includes('log in to get answers')
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          continue;
        }
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

    // Learned 2026-05-16: ChatGPT's /backend-api/* endpoints now sit behind Cloudflare bot
    // mitigation. Programmatic fetch from the page can return 403 with cf-mitigated:challenge
    // even when the user is logged in via cookies and the SPA renders normally. Detect that
    // case via the response body shape (Cloudflare interstitial HTML) and fall back to a
    // DOM-based logged-in signal instead of looping waitForLogin until the 20-min timeout.
    const isCloudflareBody = (body) => {
      if (typeof body !== 'string' || body.length === 0) return false;
      const head = body.slice(0, 2000).toLowerCase();
      return (
        head.includes('cf-mitigated') ||
        head.includes('cloudflare') ||
        (head.includes('<style global>') && head.includes('scale-appear'))
      );
    };
    const readBackendDetail = async () => {
      try {
        if (typeof fetch !== 'function') return { status: 0, cfBlocked: false, error: null };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ${timeoutMs});
        try {
          const response = await fetch('/backend-api/me', {
            cache: 'no-store',
            credentials: 'include',
            signal: controller.signal,
          });
          let cfBlocked = false;
          if (response.status === 403 || response.status === 503 || response.status === 429) {
            try {
              const text = await response.clone().text();
              cfBlocked = isCloudflareBody(text);
            } catch {}
          }
          return { status: response.status || 0, cfBlocked, error: null };
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        return { status: 0, cfBlocked: false, error: err ? String(err) : 'unknown' };
      }
    };

    const hasAppAuthSignal = () => {
      // Composer must be present and visible — the auth/login page never renders one.
      if (typeof document.querySelector !== 'function') return false;
      const composerSelectors = [
        '#prompt-textarea',
        '.ProseMirror',
        'textarea[data-id="prompt-textarea"]',
        'textarea[name="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"]',
      ];
      const composer = composerSelectors.map((s) => document.querySelector(s)).find(Boolean);
      if (!composer) return false;
      const rect = composer.getBoundingClientRect && composer.getBoundingClientRect();
      const style = window.getComputedStyle(composer);
      if (!rect || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      // Logged-in users should have an account affordance or prior chat history. Generic
      // composer/model pills also appear in guest sessions, so they are not auth proof.
      const profileButton = document.querySelector('[data-testid="accounts-profile-button"]');
      const historyItem = document.querySelector('[data-testid^="history-item-"]');
      return Boolean(profileButton || historyItem);
    };

    let backend = await readBackendDetail();
    let status = backend.status;
    let cfBlocked = backend.cfBlocked;
    let error = backend.error;
    let domLoginCta = hasLoginCta();
    let appAuthenticated = hasAppAuthSignal();
    const isRetryableStatus = () =>
      status === 0 || status === 401 || status === 403 || status === 503 || status === 429;
    const settleDeadline = Date.now() + Math.min(${timeoutMs}, 2500);
    while (!domLoginCta && status !== 200 && isRetryableStatus() && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      domLoginCta = hasLoginCta();
      appAuthenticated = hasAppAuthSignal();
      backend = await readBackendDetail();
      status = backend.status;
      cfBlocked = backend.cfBlocked;
      error = backend.error;
    }

    const loginSignals = domLoginCta || onAuthPage;
    // Accept the SPA-level signal when the legacy cookie-only API probe is blocked,
    // unavailable, or returns 401/403 but the DOM proves an authenticated shell.
    // Auth pages and visible login controls remain authoritative failures.
    const apiBlocked =
      cfBlocked ||
      status === 401 ||
      status === 403 ||
      status === 429 ||
      status === 503 ||
      status === 0;
    const ok = !loginSignals && (status === 200 || (apiBlocked && appAuthenticated));
    return {
      ok,
      status,
      redirected: false,
      url: pageUrl,
      pageUrl,
      domLoginCta,
      onAuthPage,
      appAuthenticated,
      cfBlocked,
      error,
    };
  })()`;
}

function normalizeLoginProbe(raw: unknown): LoginProbeResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 0 };
  }
  const value = raw as Record<string, unknown>;
  const statusRaw = value.status;
  const status =
    typeof statusRaw === "number"
      ? statusRaw
      : typeof statusRaw === "string" && !Number.isNaN(Number(statusRaw))
        ? Number(statusRaw)
        : 0;

  return {
    ok: Boolean(value.ok),
    status: Number.isFinite(status) ? (status as number) : 0,
    url: typeof value.url === "string" ? value.url : null,
    redirected: Boolean(value.redirected),
    error: typeof value.error === "string" ? value.error : null,
    pageUrl: typeof value.pageUrl === "string" ? value.pageUrl : null,
    domLoginCta: Boolean(value.domLoginCta),
    onAuthPage: Boolean(value.onAuthPage),
    appAuthenticated: Boolean(value.appAuthenticated),
    cfBlocked: Boolean(value.cfBlocked),
  };
}

export function buildLoginProbeExpressionForTest(timeoutMs = LOGIN_CHECK_TIMEOUT_MS): string {
  return buildLoginProbeExpression(timeoutMs);
}

export function buildWelcomeBackAccountPickerExpressionForTest(
  preferredEmail: string | null = null,
): string {
  return buildWelcomeBackAccountPickerExpression(preferredEmail);
}
