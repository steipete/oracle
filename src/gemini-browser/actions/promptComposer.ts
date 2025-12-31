/**
 * Gemini Prompt Composer - Submit prompts to Gemini
 */

import type { ChromeClient } from '../../browser/types.js';
import type { BrowserLogger } from '../types.js';
import {
  GEMINI_INPUT_SELECTORS,
  GEMINI_SEND_BUTTON_SELECTORS,
} from '../constants.js';
import { delay } from '../../browser/utils.js';

/**
 * Submit a prompt to Gemini
 */
export async function submitGeminiPrompt(
  deps: {
    runtime: ChromeClient['Runtime'];
    input?: ChromeClient['Input'];
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const { runtime, input } = deps;

  logger(`Submitting prompt (${prompt.length} chars)`);

  // Find and focus the input element
  const inputFound = await focusGeminiInput(runtime, logger);
  if (!inputFound) {
    throw new Error('Could not find Gemini prompt input');
  }

  // Clear any existing content
  await clearGeminiInput(runtime);
  await delay(100);

  // Type the prompt
  await typePrompt(runtime, input, prompt, logger);
  await delay(200);

  // Submit the prompt
  await submitPrompt(runtime, input, logger);
}

/**
 * Focus the Gemini input element
 */
async function focusGeminiInput(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<boolean> {
  const selectorsJson = JSON.stringify(GEMINI_INPUT_SELECTORS);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${selectorsJson};

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && el instanceof HTMLElement) {
          el.focus();
          el.click?.();
          return { found: true, selector, tagName: el.tagName };
        }
      }

      return { found: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { found?: boolean; selector?: string; tagName?: string } | undefined;

  if (outcome?.found) {
    logger(`Focused input: ${outcome.tagName} (${outcome.selector})`);
    return true;
  }

  return false;
}

/**
 * Clear existing content from input
 */
async function clearGeminiInput(Runtime: ChromeClient['Runtime']): Promise<void> {
  const selectorsJson = JSON.stringify(GEMINI_INPUT_SELECTORS);

  await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${selectorsJson};

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;

        // Handle contenteditable
        if (el.getAttribute('contenteditable') === 'true') {
          el.innerHTML = '';
          el.textContent = '';
        }
        // Handle textarea/input
        else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.value = '';
        }

        // Dispatch input event
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    })()`,
  });
}

/**
 * Type the prompt into the input
 */
async function typePrompt(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'] | undefined,
  prompt: string,
  logger: BrowserLogger,
): Promise<void> {
  const selectorsJson = JSON.stringify(GEMINI_INPUT_SELECTORS);

  // For long prompts, use paste approach; for short ones, simulate typing
  const usePaste = prompt.length > 500;

  if (usePaste) {
    // Use clipboard paste for efficiency
    const escapedPrompt = JSON.stringify(prompt);

    const { result } = await Runtime.evaluate({
      expression: `(async () => {
        const selectors = ${selectorsJson};

        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;

          const text = ${escapedPrompt};

          // Handle contenteditable
          if (el.getAttribute('contenteditable') === 'true') {
            el.textContent = text;
            el.innerHTML = text.replace(/\\n/g, '<br>');
          }
          // Handle textarea/input
          else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.value = text;
          }

          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          return { success: true, length: text.length };
        }

        return { success: false };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    const outcome = result?.value as { success?: boolean; length?: number } | undefined;
    if (outcome?.success) {
      logger(`Pasted prompt (${outcome.length} chars)`);
    } else {
      throw new Error('Failed to paste prompt into input');
    }
  } else {
    // Use keyboard input for natural typing
    if (Input) {
      await typeWithKeyboard(Input, prompt, logger);
    } else {
      // Fallback to direct insertion
      const escapedPrompt = JSON.stringify(prompt);

      await Runtime.evaluate({
        expression: `(() => {
          const selectors = ${selectorsJson};

          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!el) continue;

            const text = ${escapedPrompt};

            if (el.getAttribute('contenteditable') === 'true') {
              el.textContent = text;
            } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
              el.value = text;
            }

            el.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        })()`,
      });
    }
    logger(`Typed prompt (${prompt.length} chars)`);
  }
}

/**
 * Type text using keyboard events
 */
async function typeWithKeyboard(
  Input: ChromeClient['Input'],
  text: string,
  _logger: BrowserLogger,
): Promise<void> {
  // Type character by character with slight delays for realism
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '\n') {
      await Input.dispatchKeyEvent({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
      });
      await Input.dispatchKeyEvent({
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
      });
    } else {
      await Input.dispatchKeyEvent({
        type: 'keyDown',
        key: char,
        text: char,
      });
      await Input.dispatchKeyEvent({
        type: 'keyUp',
        key: char,
      });
    }

    // Small random delay for natural typing feel
    if (i % 10 === 0) {
      await delay(Math.random() * 20 + 5);
    }
  }
}

/**
 * Submit the prompt (click send or press Enter)
 */
async function submitPrompt(
  Runtime: ChromeClient['Runtime'],
  Input: ChromeClient['Input'] | undefined,
  logger: BrowserLogger,
): Promise<void> {
  const sendSelectorsJson = JSON.stringify(GEMINI_SEND_BUTTON_SELECTORS);

  // Try to click send button first
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const selectors = ${sendSelectorsJson};

      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn && btn instanceof HTMLElement && !btn.disabled) {
          btn.click();
          return { clicked: true, selector };
        }
      }

      // Try generic send button
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        if ((label.includes('send') || label.includes('submit')) && !btn.disabled) {
          btn.click();
          return { clicked: true, selector: 'aria-label-match' };
        }
      }

      return { clicked: false };
    })()`,
    returnByValue: true,
  });

  const outcome = result?.value as { clicked?: boolean; selector?: string } | undefined;

  if (outcome?.clicked) {
    logger(`Clicked send button (${outcome.selector})`);
    return;
  }

  // Fallback: press Enter
  logger('Send button not found; pressing Enter');
  if (Input) {
    await Input.dispatchKeyEvent({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
    });
    await Input.dispatchKeyEvent({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
    });
  } else {
    await Runtime.evaluate({
      expression: `(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
        });
        document.activeElement?.dispatchEvent(event);
      })()`,
    });
  }
}

/**
 * Clear the prompt composer
 */
export async function clearGeminiPromptComposer(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<void> {
  await focusGeminiInput(Runtime, logger);
  await clearGeminiInput(Runtime);
  logger('Cleared prompt composer');
}
