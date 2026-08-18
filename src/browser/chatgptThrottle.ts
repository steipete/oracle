import type { BrowserLogger, ChromeClient } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";

/**
 * Detection for ChatGPT's own rate-limit notice.
 *
 * When ChatGPT decides a session is asking for too much at once it puts a modal
 * over the page — "Too many requests … We've temporarily limited access to your
 * conversations … Please wait a few minutes" — with a single "Got it" button.
 *
 * The modal is not marked as an error anywhere a DOM scrape would notice. It is
 * a dialog full of ordinary text, so a menu reader walking the page finds its
 * button and reports it as an available option. That is how a throttle came to be
 * reported as `Unable to find model option matching "Thinking 5.5". Available:
 * Got it` — a message that sends the reader looking for a model-naming bug that
 * does not exist, when the correct response is to wait a few minutes.
 *
 * Observed live: six ChatGPT conversations opened at once triggered it
 * repeatedly, while five did not, and the limit cleared on its own after a
 * pause. Runs must therefore treat this as a transient, recoverable state rather
 * than a failure of the request they were making.
 */

const THROTTLE_PHRASES = [
  "too many requests",
  "making requests too quickly",
  "temporarily limited access to your conversations",
] as const;

export interface ChatGptThrottleNotice {
  /** The notice text as shown, already trimmed and length-bounded. */
  message: string;
}

/** True when the text carries ChatGPT's rate-limit wording. */
export function matchesThrottleNotice(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return THROTTLE_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function buildThrottleProbeExpression(): string {
  return `(() => {
    const PHRASES = ${JSON.stringify(THROTTLE_PHRASES)};
    const matches = (value) => {
      const text = (value || '').toLowerCase();
      return PHRASES.some((phrase) => text.includes(phrase));
    };
    // Dialogs first, because that is what this notice is; the body sweep is a
    // fallback for a variant that does not carry the role.
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
    for (const dialog of dialogs) {
      const text = (dialog.innerText || '').trim();
      if (matches(text)) return { message: text.slice(0, 400) };
    }
    const body = (document.body && document.body.innerText) || '';
    if (matches(body)) {
      const line = body
        .split('\\n')
        .map((entry) => entry.trim())
        .find((entry) => matches(entry));
      return { message: (line || 'ChatGPT is rate limiting this session.').slice(0, 400) };
    }
    return null;
  })()`;
}

/**
 * Looks for the rate-limit notice. Never throws: this runs on paths that are
 * already reporting a different failure, and a probe that failed must not
 * replace the original diagnosis with its own.
 */
export async function detectChatGptThrottleNotice(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptThrottleNotice | null> {
  try {
    const evaluated = await Runtime.evaluate({
      expression: buildThrottleProbeExpression(),
      returnByValue: true,
    });
    const value = evaluated.result?.value as { message?: string } | null | undefined;
    if (value && typeof value.message === "string" && value.message.trim()) {
      return { message: value.message.trim() };
    }
  } catch {
    // fall through: no notice detected
  }
  return null;
}

export function buildThrottleError(
  notice: ChatGptThrottleNotice,
  context: { stage: string },
): BrowserAutomationError {
  return new BrowserAutomationError(
    `ChatGPT is rate limiting this session: ${notice.message} ` +
      "This is a temporary limit on the account, not a problem with the request — " +
      "wait a few minutes and retry, and reduce how many conversations are started at once.",
    {
      stage: "chatgpt-throttled",
      details: {
        // Named so a caller can branch on it rather than parsing the message.
        retryable: true,
        origin: context.stage,
        notice: notice.message,
      },
    },
  );
}

/**
 * Replaces a misleading failure with the real one when the page is throttled.
 * Returns nothing when it is not, leaving the caller's own error intact.
 */
export async function throwIfThrottled(
  Runtime: ChromeClient["Runtime"],
  context: { stage: string },
  logger?: BrowserLogger,
): Promise<void> {
  const notice = await detectChatGptThrottleNotice(Runtime);
  if (!notice) {
    return;
  }
  logger?.(`[browser] ChatGPT rate limit detected during ${context.stage}: ${notice.message}`);
  throw buildThrottleError(notice, context);
}
