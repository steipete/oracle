import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

type ChatGptUiWarningType = "rate_limit" | "temporary_unavailable" | "auth_or_challenge";

type ChatGptUiWarning = {
  type: ChatGptUiWarningType;
  message: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
};

const MAX_CHATGPT_UI_WARNING_CHARS = 300;
const MAX_CHATGPT_UI_WARNINGS = 3;

export function classifyChatGptUiWarningText(text: string): ChatGptUiWarningType | null {
  const normalized = text.toLowerCase();
  if (
    /\btoo many requests\b/.test(normalized) ||
    /\bsending too many requests\b/.test(normalized) ||
    /\btoo quickly\b/.test(normalized) ||
    /\btemporarily limited access\b/.test(normalized) ||
    /\bplease wait a few minutes\b/.test(normalized) ||
    /\brate limit(?:ed)?\b/.test(normalized) ||
    /\bslow down\b/.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    /\btemporarily unavailable\b/.test(normalized) ||
    /\bsomething went wrong\b/.test(normalized) ||
    /\bfailed to generate\b/.test(normalized) ||
    /\btry again later\b/.test(normalized)
  ) {
    return "temporary_unavailable";
  }
  if (
    /\bverify you are human\b/.test(normalized) ||
    /\bunusual activity\b/.test(normalized) ||
    /\bcloudflare\b/.test(normalized) ||
    /\bchallenge\b/.test(normalized) ||
    /\blogin required\b/.test(normalized) ||
    /\bsign in\b/.test(normalized)
  ) {
    return "auth_or_challenge";
  }
  return null;
}

function sanitizeChatGptUiWarningText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\b((?:access|auth|session)[-_ ]?token|token)\s*[:=]\s*["']?[^\s"',;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk-(?:ant-|or-)?|xai-)[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]");
}

function normalizeUiWarningCandidate(value: unknown): {
  text: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text =
    typeof candidate.text === "string"
      ? sanitizeChatGptUiWarningText(candidate.text.replace(/\s+/g, " ").trim())
      : "";
  if (!text) return null;
  return {
    text: text.slice(0, MAX_CHATGPT_UI_WARNING_CHARS),
    source: typeof candidate.source === "string" ? candidate.source : null,
    role: typeof candidate.role === "string" ? candidate.role : null,
    ariaLive: typeof candidate.ariaLive === "string" ? candidate.ariaLive : null,
    selector: typeof candidate.selector === "string" ? candidate.selector : null,
  };
}

export async function collectChatGptUiWarnings(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptUiWarning[]> {
  try {
    const { result } = await Runtime.evaluate({
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const warningPattern = /too many requests|sending too many requests|too quickly|temporarily limited access|please wait a few minutes|rate limit|rate limited|slow down|try again later|temporarily unavailable|something went wrong|failed to generate|verify you are human|unusual activity|cloudflare|challenge|login required|sign in/i;
        const selectors = [
          '[role="alert"]',
          '[role="status"]',
          '[role="dialog"]',
          '[aria-live]',
          '[data-testid*="toast" i]',
          '[data-testid*="banner" i]',
          '[data-testid*="error" i]',
          '[class*="toast" i]',
          '[class*="banner" i]'
        ];
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          let current = element;
          while (current) {
            const currentStyle = window.getComputedStyle(current);
            if (
              !currentStyle ||
              currentStyle.display === 'none' ||
              currentStyle.visibility === 'hidden' ||
              currentStyle.visibility === 'collapse' ||
              Number.parseFloat(currentStyle.opacity || '1') === 0
            ) {
              return false;
            }
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const describe = (element, source, selector = null) => ({
          text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
          source,
          selector,
          role: element.getAttribute('role'),
          ariaLive: element.getAttribute('aria-live')
        });
        const out = [];
        const seen = new Set();
        const warningContainers = [];
        const overlapsWarningContainer = (element) => warningContainers.some((container) => (
          container !== element && (container.contains(element) || element.contains(container))
        ));
        const add = (element, entry) => {
          if (!entry.text || !warningPattern.test(entry.text)) return;
          const key = entry.text + '|' + (entry.role || '') + '|' + (entry.ariaLive || '');
          if (seen.has(key)) return;
          seen.add(key);
          warningContainers.push(element);
          out.push(entry);
        };
        for (const selector of selectors) {
          if (out.length >= 5) break;
          let elements = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch {
            elements = [];
          }
          for (const element of elements) {
            if (out.length >= 5) break;
            if (overlapsWarningContainer(element)) continue;
            if (isVisible(element)) add(element, describe(element, 'selector', selector));
          }
        }
        return out.slice(0, 5);
      })()`,
    });
    const rawWarnings = Array.isArray(result?.value) ? result.value : [];
    const warnings: ChatGptUiWarning[] = [];
    const seen = new Set<string>();
    for (const raw of rawWarnings) {
      const candidate = normalizeUiWarningCandidate(raw);
      if (!candidate) continue;
      const type = classifyChatGptUiWarningText(candidate.text);
      if (!type) continue;
      const key = `${type}:${candidate.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        type,
        message: candidate.text,
        source: candidate.source,
        role: candidate.role,
        ariaLive: candidate.ariaLive,
        selector: candidate.selector,
      });
      if (warnings.length >= MAX_CHATGPT_UI_WARNINGS) break;
    }
    return warnings;
  } catch {
    return [];
  }
}

function formatChatGptUiWarningType(type: ChatGptUiWarningType): string {
  switch (type) {
    case "rate_limit":
      return "rate-limit";
    case "temporary_unavailable":
      return "temporary-unavailable";
    case "auth_or_challenge":
      return "authentication/challenge";
  }
}

async function createChatGptUiWarningError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
  cause?: unknown;
}): Promise<BrowserAutomationError | null> {
  const [uiWarning] = await collectChatGptUiWarnings(params.Runtime);
  if (!uiWarning) return null;

  params.logger(`[browser] ChatGPT UI warning detected (${uiWarning.type}): ${uiWarning.message}`);
  return new BrowserAutomationError(
    `ChatGPT displayed a ${formatChatGptUiWarningType(uiWarning.type)} warning while waiting for ${params.waitTarget}: ${uiWarning.message}`,
    {
      stage: params.stage,
      code: "chatgpt-ui-warning",
      uiWarning,
      runtime: params.runtime,
      diagnostics: params.diagnostics,
    },
    params.cause,
  );
}

export async function throwChatGptUiWarningIfPresent(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
}): Promise<void> {
  const error = await createChatGptUiWarningError(params);
  if (error) throw error;
}

export async function createAssistantTimeoutError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  diagnostics?: unknown;
  cause: unknown;
}): Promise<BrowserAutomationError> {
  const warningError = await createChatGptUiWarningError({
    Runtime: params.Runtime,
    logger: params.logger,
    runtime: params.runtime,
    stage: "assistant-timeout",
    waitTarget: "the assistant",
    diagnostics: params.diagnostics,
    cause: params.cause,
  });
  if (!warningError) {
    return new BrowserAutomationError(
      "Assistant response timed out before completion; reattach later to capture the answer.",
      { stage: "assistant-timeout", runtime: params.runtime, diagnostics: params.diagnostics },
      params.cause,
    );
  }
  return warningError;
}
