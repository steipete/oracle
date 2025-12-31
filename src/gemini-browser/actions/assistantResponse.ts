/**
 * Gemini Assistant Response Capture
 */

import type { ChromeClient } from '../../browser/types.js';
import type { BrowserLogger, GeminiResponseSnapshot, GeminiThinkingStatus } from '../types.js';
import {
  GEMINI_RESPONSE_SELECTORS,
  GEMINI_THINKING_SELECTORS,
  GEMINI_STOP_BUTTON_SELECTOR,
  GEMINI_TIMEOUTS,
} from '../constants.js';
import { delay } from '../../browser/utils.js';

/**
 * Wait for and capture Gemini's response
 */
export async function waitForGeminiResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number = GEMINI_TIMEOUTS.response,
  logger: BrowserLogger,
  baselineSnapshot?: GeminiResponseSnapshot | null,
): Promise<GeminiResponseSnapshot> {
  const deadline = Date.now() + timeoutMs;
  const baselineText = baselineSnapshot?.text?.trim() ?? '';

  let lastSnapshot: GeminiResponseSnapshot | null = null;
  let stableCount = 0;
  let lastThinkingLog = 0;

  while (Date.now() < deadline) {
    // Check thinking status
    const thinking = await readThinkingStatus(Runtime);

    // Log thinking progress periodically
    if (thinking.isThinking) {
      const now = Date.now();
      if (now - lastThinkingLog > GEMINI_TIMEOUTS.thinkingPoll) {
        const elapsed = Math.round((now - (deadline - timeoutMs)) / 1000);
        logger(`[thinking] ${thinking.message ?? 'Processing...'} (${elapsed}s)`);
        lastThinkingLog = now;
      }
      await delay(500);
      continue;
    }

    // Check if generation is still in progress
    const isGenerating = await isResponseGenerating(Runtime);
    if (isGenerating) {
      await delay(300);
      continue;
    }

    // Read current response
    const snapshot = await readGeminiResponse(Runtime);

    if (!snapshot || !snapshot.text.trim()) {
      await delay(300);
      continue;
    }

    // Skip if this is the baseline (previous response)
    if (baselineText && snapshot.text.trim() === baselineText) {
      await delay(300);
      continue;
    }

    // Check stability (response hasn't changed for a few polls)
    if (lastSnapshot && snapshot.text === lastSnapshot.text) {
      stableCount++;
      if (stableCount >= 3) {
        logger(`Response captured (${snapshot.text.length} chars)`);
        return snapshot;
      }
    } else {
      stableCount = 0;
      lastSnapshot = snapshot;
    }

    await delay(400);
  }

  // Timeout - return whatever we have
  if (lastSnapshot?.text.trim()) {
    logger(`Response timeout, returning partial (${lastSnapshot.text.length} chars)`);
    return lastSnapshot;
  }

  throw new Error('Gemini response not received before timeout');
}

/**
 * Read the current Gemini response from the page
 */
export async function readGeminiResponse(
  Runtime: ChromeClient['Runtime'],
): Promise<GeminiResponseSnapshot | null> {
  const responseSelectorsJson = JSON.stringify(GEMINI_RESPONSE_SELECTORS);
  const thinkingSelectorsJson = JSON.stringify(GEMINI_THINKING_SELECTORS);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const responseSelectors = ${responseSelectorsJson};
      const thinkingSelectors = ${thinkingSelectorsJson};

      // Find response elements
      let responseElements = [];
      for (const selector of responseSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          responseElements = Array.from(elements);
          break;
        }
      }

      // Fallback: find any element that looks like a response
      if (responseElements.length === 0) {
        const candidates = document.querySelectorAll(
          '[class*="response"], [class*="message"], [class*="content"], ' +
          '[data-message-author="model"], [role="article"]'
        );
        responseElements = Array.from(candidates).filter(el => {
          const text = el.textContent?.trim() || '';
          return text.length > 20;
        });
      }

      if (responseElements.length === 0) {
        return null;
      }

      // Get the last (most recent) response
      const lastResponse = responseElements[responseElements.length - 1];
      const text = lastResponse.textContent?.trim() || '';
      const html = lastResponse.innerHTML || '';

      // Try to find thinking content
      let thinking = null;
      for (const selector of thinkingSelectors) {
        const thinkingEl = document.querySelector(selector);
        if (thinkingEl && thinkingEl.textContent?.trim()) {
          thinking = thinkingEl.textContent.trim();
          break;
        }
      }

      // Extract metadata
      const turnId = lastResponse.getAttribute('data-turn-id') ||
                     lastResponse.getAttribute('data-message-id') ||
                     lastResponse.id || undefined;

      return {
        text,
        html,
        thinking,
        meta: {
          turnId,
          messageId: turnId,
        },
      };
    })()`,
    returnByValue: true,
  });

  const snapshot = result?.value as GeminiResponseSnapshot | null | undefined;
  return snapshot ?? null;
}

/**
 * Read thinking status
 */
export async function readThinkingStatus(
  Runtime: ChromeClient['Runtime'],
): Promise<GeminiThinkingStatus> {
  const thinkingSelectorsJson = JSON.stringify(GEMINI_THINKING_SELECTORS);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${thinkingSelectorsJson};

      // Keywords that indicate active thinking
      const thinkingKeywords = [
        'thinking', 'reasoning', 'analyzing', 'processing',
        'generating', 'working', 'computing', 'understanding',
      ];

      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            if (!(el instanceof HTMLElement)) continue;

            // Check visibility
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const text = el.textContent?.trim().toLowerCase() || '';
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

            const isThinking = thinkingKeywords.some(keyword =>
              text.includes(keyword) || ariaLabel.includes(keyword)
            );

            if (isThinking) {
              return {
                isThinking: true,
                phase: 'thinking',
                message: el.textContent?.trim() || 'Thinking...',
              };
            }
          }
        } catch {}
      }

      // Check for loading indicators (spinner, shimmer, etc.)
      const loadingIndicators = document.querySelectorAll(
        '.loading, .spinner, [role="progressbar"], .shimmer, [aria-busy="true"]'
      );
      for (const el of loadingIndicators) {
        if (el instanceof HTMLElement) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return {
              isThinking: true,
              phase: 'loading',
              message: 'Loading...',
            };
          }
        }
      }

      return { isThinking: false };
    })()`,
    returnByValue: true,
  });

  return (result?.value as GeminiThinkingStatus) ?? { isThinking: false };
}

/**
 * Check if response is still being generated
 */
async function isResponseGenerating(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const stopButtonSelector = JSON.stringify(GEMINI_STOP_BUTTON_SELECTOR);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      // Check for stop button (indicates generation in progress)
      const stopBtn = document.querySelector(${stopButtonSelector});
      if (stopBtn && stopBtn instanceof HTMLElement) {
        const style = window.getComputedStyle(stopBtn);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }

      // Check for streaming indicators
      const streamIndicators = document.querySelectorAll(
        '[data-streaming="true"], [data-generating="true"], .typing-indicator'
      );
      for (const el of streamIndicators) {
        if (el instanceof HTMLElement) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none') return true;
        }
      }

      // Check for cursor blinking (indicates text still being typed)
      const cursors = document.querySelectorAll('.cursor, .caret, [data-cursor]');
      for (const cursor of cursors) {
        if (cursor instanceof HTMLElement) {
          const style = window.getComputedStyle(cursor);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
      }

      return false;
    })()`,
    returnByValue: true,
  });

  return Boolean(result?.value);
}

/**
 * Capture response as markdown (if copy button available)
 */
export async function captureGeminiMarkdown(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<string | null> {
  // Try to use copy button if available
  const { result } = await Runtime.evaluate({
    expression: `(async () => {
      // Find copy button
      const copyBtn = document.querySelector(
        'button[aria-label*="Copy"], button[data-testid="copy-button"], ' +
        'button[aria-label*="copy"], button.copy-button'
      );

      if (!copyBtn || !(copyBtn instanceof HTMLElement)) {
        return { success: false, reason: 'no-copy-button' };
      }

      // Clear clipboard
      try {
        await navigator.clipboard.writeText('');
      } catch {}

      // Click copy button
      copyBtn.click();

      // Wait a bit for clipboard to update
      await new Promise(resolve => setTimeout(resolve, 200));

      // Read clipboard
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.length > 0) {
          return { success: true, text };
        }
      } catch (err) {
        return { success: false, reason: 'clipboard-read-failed' };
      }

      return { success: false, reason: 'empty-clipboard' };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const outcome = result?.value as { success?: boolean; text?: string; reason?: string } | undefined;

  if (outcome?.success && outcome.text) {
    logger('Captured markdown via copy button');
    return outcome.text;
  }

  return null;
}
