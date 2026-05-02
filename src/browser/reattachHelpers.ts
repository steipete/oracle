import type { BrowserLogger, ChromeClient } from "./types.js";
import { CONVERSATION_TURN_SELECTOR } from "./constants.js";
import { delay } from "./utils.js";
import { readAssistantSnapshot } from "./pageActions.js";

export type TargetInfoLite = {
  id?: string;
  targetId?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

export type AssistantPayload = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

type PromptEchoMatcher = { isEcho: (text: string) => boolean };

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: { chromeTargetId?: string; tabUrl?: string },
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) {
    return undefined;
  }
  if (runtime.chromeTargetId) {
    const byId = targets.find((t) => (t.targetId ?? t.id) === runtime.chromeTargetId);
    if (byId) return byId;
  }
  if (runtime.tabUrl) {
    const byUrl =
      targets.find((t) => t.url?.startsWith(runtime.tabUrl as string)) ||
      targets.find((t) => (runtime.tabUrl as string).startsWith(t.url || ""));
    if (byUrl) return byUrl;
  }
  return targets.find((t) => t.type === "page") ?? targets[0];
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

export function buildConversationUrl(
  runtime: { tabUrl?: string; conversationId?: string },
  baseUrl: string,
): string | null {
  if (runtime.tabUrl) {
    if (runtime.tabUrl.includes("/c/")) {
      return runtime.tabUrl;
    }
    return null;
  }
  const conversationId = runtime.conversationId;
  if (!conversationId) {
    return null;
  }
  try {
    const base = new URL(baseUrl);
    const pathRoot = base.pathname.replace(/\/$/, "");
    const prefix = pathRoot === "/" ? "" : pathRoot;
    return `${base.origin}${prefix}/c/${conversationId}`;
  } catch {
    return null;
  }
}

export async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export async function openConversationFromSidebar(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  attempt = 0,
): Promise<boolean> {
  const response = await Runtime.evaluate({
    expression: `(() => {
      const conversationId = ${JSON.stringify(options.conversationId ?? null)};
      const preferProjects = ${JSON.stringify(Boolean(options.preferProjects))};
      const promptPreview = ${JSON.stringify(options.promptPreview ?? null)};
      const attemptIndex = ${Math.max(0, attempt)};
      const promptNeedleFull = promptPreview ? promptPreview.trim().toLowerCase().slice(0, 100) : '';
      const promptNeedleShort = promptNeedleFull.replace(/\\s*\\d{4,}\\s*$/, '').trim();
      const promptNeedles = Array.from(new Set([promptNeedleFull, promptNeedleShort].filter(Boolean)));
      const nav = document.querySelector('nav') || document.querySelector('aside') || document.body;
      if (preferProjects) {
        const projectLink = Array.from(nav.querySelectorAll('a,button'))
          .find((el) => (el.textContent || '').trim().toLowerCase() === 'projects');
        if (projectLink) {
          projectLink.click();
        }
      }
      const allElements = Array.from(
        document.querySelectorAll(
          'a,button,[role="link"],[role="button"],[data-href],[data-url],[data-conversation-id],[data-testid*="conversation"],[data-testid*="history"]',
        ),
      );
      const getHref = (el) =>
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-url') ||
        el.dataset?.href ||
        el.dataset?.url ||
        '';
      const toCandidate = (el) => {
        const clickable = el.closest('a,button,[role="link"],[role="button"]') || el;
        const rawText = (el.textContent || clickable.textContent || '').trim();
        return {
          el,
          clickable,
          href: getHref(clickable) || getHref(el),
          conversationId:
            clickable.getAttribute('data-conversation-id') ||
            el.getAttribute('data-conversation-id') ||
            clickable.dataset?.conversationId ||
            el.dataset?.conversationId ||
            '',
          testId: clickable.getAttribute('data-testid') || el.getAttribute('data-testid') || '',
          text: rawText.replace(/\\s+/g, ' ').slice(0, 400),
          inNav: Boolean(clickable.closest('nav,aside')),
        };
      };
      const candidates = allElements.map(toCandidate);
      const mainCandidates = candidates.filter((item) => !item.inNav);
      const navCandidates = candidates.filter((item) => item.inNav);
      const visible = (item) => {
        const rect = item.clickable.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pick = (items) => (items.find(visible) || items[0] || null);
      const pickWithAttempt = (items) => {
        if (!items.length) return null;
        const visibleItems = items.filter(visible);
        const pool = visibleItems.length > 0 ? visibleItems : items;
        const index = Math.min(attemptIndex, pool.length - 1);
        return pool[index] ?? null;
      };
      let target = null;
      if (conversationId) {
        const byId = (item) =>
          (item.href && item.href.includes('/c/' + conversationId)) ||
          (item.conversationId && item.conversationId === conversationId);
        target = pick(mainCandidates.filter(byId)) || pick(navCandidates.filter(byId));
      }
      if (!target && promptNeedles.length > 0) {
        const byPrompt = (item) => promptNeedles.some((needle) => item.text && item.text.toLowerCase().includes(needle));
        const sortBySpecificity = (items) =>
          items
            .filter(byPrompt)
            .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0));
        target = pickWithAttempt(sortBySpecificity(mainCandidates)) || pickWithAttempt(sortBySpecificity(navCandidates));
      }
      if (!target) {
        const byHref = (item) => item.href && item.href.includes('/c/');
        target = pickWithAttempt(mainCandidates.filter(byHref)) || pickWithAttempt(navCandidates.filter(byHref));
      }
      if (!target) {
        const byTestId = (item) => /conversation|history/i.test(item.testId || '');
        target = pickWithAttempt(mainCandidates.filter(byTestId)) || pickWithAttempt(navCandidates.filter(byTestId));
      }
      if (target) {
        target.clickable.scrollIntoView({ block: 'center' });
        target.clickable.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
        );
        // Fallback: some project-sidebar items don't navigate on click, force the URL.
        if (target.href && target.href.includes('/c/')) {
          const targetUrl = target.href.startsWith('http')
            ? target.href
            : new URL(target.href, location.origin).toString();
          if (targetUrl && targetUrl !== location.href) {
            location.href = targetUrl;
          }
        }
        return {
          ok: true,
          href: target.href || '',
          count: candidates.length,
          scope: target.inNav ? 'nav' : 'main',
        };
      }
      return { ok: false, count: candidates.length };
    })()`,
    returnByValue: true,
  });
  return Boolean(response.result?.value?.ok);
}

export async function openConversationFromSidebarWithRetry(
  Runtime: ChromeClient["Runtime"],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    // Retry because project list can hydrate after initial navigation.
    const opened = await openConversationFromSidebar(Runtime, options, attempt);
    if (opened) {
      if (options.promptPreview) {
        const matched = await waitForPromptPreview(Runtime, options.promptPreview, 10_000);
        if (matched) {
          return true;
        }
      } else {
        return true;
      }
    }
    attempt += 1;
    await delay(attempt < 5 ? 250 : 500);
  }
  return false;
}

export async function waitForPromptPreview(
  Runtime: ChromeClient["Runtime"],
  promptPreview: string,
  timeoutMs: number,
): Promise<boolean> {
  const needleFull = promptPreview.trim().toLowerCase().slice(0, 120);
  const needleShort = needleFull.replace(/\\s*\\d{4,}\\s*$/, "").trim();
  const needles = Array.from(new Set([needleFull, needleShort].filter(Boolean)));
  if (needles.length === 0) return false;
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const expression = `(() => {
    const needles = ${JSON.stringify(needles)};
    const root =
      document.querySelector('section[data-testid="screen-threadFlyOut"]') ||
      document.querySelector('[data-testid="chat-thread"]') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]');
    if (!root) return false;
    const userTurns = Array.from(root.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
    const collectText = (nodes) =>
      nodes
        .map((node) => (node.innerText || node.textContent || ''))
        .join(' ')
        .toLowerCase();
    let text = collectText(userTurns);
    let hasTurns = userTurns.length > 0;
    if (!text) {
      const turns = Array.from(root.querySelectorAll(${selectorLiteral}));
      hasTurns = hasTurns || turns.length > 0;
      text = collectText(turns);
    }
    if (!text) {
      text = (root.innerText || root.textContent || '').toLowerCase();
    }
    return needles.some((needle) => text.includes(needle));
  })()`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { result } = await Runtime.evaluate({ expression, returnByValue: true });
      if (result?.value === true) {
        return true;
      }
    } catch {
      // ignore
    }
    await delay(300);
  }
  return false;
}

export async function waitForLocationChange(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastHref = "";
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    const href = typeof result?.value === "string" ? result.value : "";
    if (lastHref && href !== lastHref) {
      return;
    }
    lastHref = href;
    await delay(200);
  }
}

export async function readConversationTurnIndex(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const selectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  try {
    const { result } = await Runtime.evaluate({
      expression: `document.querySelectorAll(${selectorLiteral}).length`,
      returnByValue: true,
    });
    const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
    if (!Number.isFinite(raw)) {
      throw new Error("Turn count not numeric");
    }
    return Math.max(0, Math.floor(raw) - 1);
  } catch (error) {
    if (logger?.verbose) {
      logger(
        `Failed to read conversation turn index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

function normalizeForComparison(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/\\s+/g, " ")
    .trim();
}

export function buildPromptEchoMatcher(promptPreview?: string | null): PromptEchoMatcher | null {
  const normalizedPrompt = normalizeForComparison(promptPreview ?? "");
  if (!normalizedPrompt) {
    return null;
  }
  const promptPrefix =
    normalizedPrompt.length >= 80
      ? normalizedPrompt.slice(0, Math.min(200, normalizedPrompt.length))
      : "";
  const minFragment = Math.min(40, normalizedPrompt.length);
  return {
    isEcho: (text: string) => {
      const normalized = normalizeForComparison(text);
      if (!normalized) return false;
      if (normalized === normalizedPrompt) return true;
      if (promptPrefix.length > 0 && normalized.startsWith(promptPrefix)) return true;
      if (normalized.length >= minFragment && normalizedPrompt.startsWith(normalized)) {
        return true;
      }
      if (normalized.includes("…") || normalized.includes("...")) {
        const marker = normalized.includes("…") ? "…" : "...";
        const [prefixRaw, suffixRaw] = normalized.split(marker);
        const prefix = prefixRaw?.trim() ?? "";
        const suffix = suffixRaw?.trim() ?? "";
        if (!prefix && !suffix) return false;
        if (prefix && !normalizedPrompt.includes(prefix)) return false;
        if (suffix && !normalizedPrompt.includes(suffix)) return false;
        const fragmentLength = prefix.length + suffix.length;
        return fragmentLength >= minFragment;
      }
      return false;
    },
  };
}

export async function recoverPromptEcho(
  Runtime: ChromeClient["Runtime"],
  answer: AssistantPayload,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
  minTurnIndex: number | null,
  timeoutMs: number,
): Promise<AssistantPayload> {
  if (!matcher || !matcher.isEcho(answer.text)) {
    return answer;
  }
  logger("Detected prompt echo while reattaching; waiting for assistant response...");
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  let bestText: string | null = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex ?? undefined).catch(
      () => null,
    );
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    if (!text || matcher.isEcho(text)) {
      await delay(300);
      continue;
    }
    if (!bestText || text.length > bestText.length) {
      bestText = text;
      stableCount = 0;
    } else if (text === bestText) {
      stableCount += 1;
    }
    if (stableCount >= 2) {
      break;
    }
    await delay(300);
  }
  if (bestText) {
    logger("Recovered assistant response after prompt echo during reattach");
    return { ...answer, text: bestText };
  }
  return answer;
}

export function alignPromptEchoPair(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger?: BrowserLogger,
  messages?: { text?: string; markdown?: string },
): {
  answerText: string;
  answerMarkdown: string;
  textEcho: boolean;
  markdownEcho: boolean;
  isEcho: boolean;
} {
  if (!matcher) {
    return { answerText, answerMarkdown, textEcho: false, markdownEcho: false, isEcho: false };
  }
  let textEcho = matcher.isEcho(answerText);
  let markdownEcho = matcher.isEcho(answerMarkdown);
  if (textEcho && !markdownEcho && answerMarkdown) {
    if (logger && messages?.text) {
      logger(messages.text);
    }
    answerText = answerMarkdown;
    textEcho = false;
  }
  if (markdownEcho && !textEcho && answerText) {
    if (logger && messages?.markdown) {
      logger(messages.markdown);
    }
    answerMarkdown = answerText;
    markdownEcho = false;
  }
  return {
    answerText,
    answerMarkdown,
    textEcho,
    markdownEcho,
    isEcho: textEcho || markdownEcho,
  };
}

export function alignPromptEchoMarkdown(
  answerText: string,
  answerMarkdown: string,
  matcher: PromptEchoMatcher | null,
  logger: BrowserLogger,
): { answerText: string; answerMarkdown: string } {
  const aligned = alignPromptEchoPair(answerText, answerMarkdown, matcher, logger, {
    text: "Aligned prompt-echo text to copied markdown during reattach",
    markdown: "Aligned prompt-echo markdown to response text during reattach",
  });
  return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
}
