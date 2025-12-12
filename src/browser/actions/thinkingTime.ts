import type { ChromeClient, BrowserLogger } from '../types.js';
import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR } from '../constants.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

type ThinkingTimeOutcome =
  | { status: 'already-extended'; label?: string | null }
  | { status: 'switched'; label?: string | null }
  | { status: 'trigger-missing' }
  | { status: 'menu-missing' }
  | { status: 'option-missing' }
  | { status: 'not-available' };

/**
 * Best-effort selection of the "Extended" thinking-time option in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 */
export async function ensureExtendedThinkingIfAvailable(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildThinkingTimeSelectionExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as ThinkingTimeOutcome | undefined;
    switch (result?.status) {
      case 'already-extended':
        logger('Thinking time: Extended (already selected)');
        return true;
      case 'switched': {
        const label = result.label ?? 'Extended';
        logger(`Thinking time: ${label}`);
        return true;
      }
      case 'trigger-missing':
      case 'menu-missing':
      case 'option-missing':
      case 'not-available':
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replace('-', ' ')}; continuing with default.`);
        }
        return false;
      default:
        if (logger.verbose) {
          logger('Thinking time: unknown outcome; continuing with default.');
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking time selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, 'thinking-time');
    }
    return false;
  }
}

export function buildThinkingTimeSelectionExpressionForTest(): string {
  return buildThinkingTimeSelectionExpression();
}

function buildThinkingTimeSelectionExpression(): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);

  return `(() => {
    ${buildClickDispatcher()}
    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MAX_WAIT_MS = 4000;
    const POLL_MS = 150;
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

    const TARGET_MENU_LABEL = 'thinking time';
    const EXTENDED_LABEL = 'extended';

    const findFooterRoot = () =>
      document.querySelector('[data-testid="composer-footer-actions"]') ||
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form');

    const findTriggers = () => {
      const root = findFooterRoot();
      if (!root) return [];
      const pillCandidates = Array.from(root.querySelectorAll(
        'button.__composer-pill, button[class*="composer-pill"], button[class*="pill"]'
      ));
      const candidates = pillCandidates.length
        ? pillCandidates
        : Array.from(root.querySelectorAll('button[aria-haspopup="menu"]'));

      return candidates.filter((btn) => {
        const testId = btn.getAttribute('data-testid') || '';
        const aria = normalize(btn.getAttribute('aria-label') || '');
        const className = (btn.getAttribute('class') || '').toLowerCase();
        if (testId.includes('composer-plus')) return false;
        if (aria.includes('add files')) return false;
        if (aria.includes('remove') || className.includes('remove')) return false;
        return true;
      });
    };

    const menusForThinkingTime = () => {
      const menus = Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR));
      return menus.filter((menu) => normalize(menu.textContent).includes(TARGET_MENU_LABEL));
    };

    const findExtendedOption = (menu) => {
      const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR));
      let best = null;
      for (const item of items) {
        const text = normalize(item.textContent);
        if (!text) continue;
        if (text === EXTENDED_LABEL || text.startsWith(EXTENDED_LABEL)) {
          best = item;
          break;
        }
        if (!best && text.includes(EXTENDED_LABEL)) {
          best = item;
        }
      }
      return best;
    };

    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true') return true;
      if (dataState === 'checked' || dataState === 'selected' || dataState === 'on') return true;
      return false;
    };

    return new Promise((resolve) => {
      const triggers = findTriggers();
      if (!triggers.length) {
        resolve({ status: 'trigger-missing' });
        return;
      }

      let triggerIndex = 0;
      let lastTriggerClick = 0;
      const start = performance.now();

      const openNextTrigger = () => {
        if (triggerIndex >= triggers.length) return false;
        const trigger = triggers[triggerIndex++];
        dispatchClickSequence(trigger);
        lastTriggerClick = performance.now();
        return true;
      };

      const attempt = () => {
        const menus = menusForThinkingTime();
        if (menus.length) {
          const menu = menus[0];
          const option = findExtendedOption(menu);
          if (!option) {
            resolve({ status: 'option-missing' });
            return;
          }
          if (optionIsSelected(option)) {
            resolve({ status: 'already-extended', label: option.textContent?.trim?.() || null });
            return;
          }
          dispatchClickSequence(option);
          try {
            if (document.body) {
              dispatchClickSequence(document.body);
            }
          } catch {}
          resolve({ status: 'switched', label: option.textContent?.trim?.() || null });
          return;
        }

        const now = performance.now();
        if (now - start > MAX_WAIT_MS) {
          resolve({ status: 'menu-missing' });
          return;
        }

        if (now - lastTriggerClick > 600) {
          openNextTrigger();
        }

        setTimeout(attempt, POLL_MS);
      };

      openNextTrigger();
      setTimeout(attempt, POLL_MS);
    });
  })()`;
}
