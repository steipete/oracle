import type { ChromeClient, BrowserLogger } from '../types.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

export async function ensureExtendedThinking(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
) {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(),
    awaitPromise: true,
    returnByValue: true,
  });

  const result = outcome.result?.value as
    | { status: 'already-extended' }
    | { status: 'switched' }
    | { status: 'chip-not-found' }
    | { status: 'menu-not-found' }
    | { status: 'extended-not-found' }
    | undefined;

  switch (result?.status) {
    case 'already-extended':
      logger('Thinking time: Extended (already selected)');
      return;
    case 'switched':
      logger('Thinking time: Extended');
      return;
    case 'chip-not-found': {
      await logDomFailure(Runtime, logger, 'thinking-chip');
      throw new Error('Unable to find the Thinking chip button in the composer area.');
    }
    case 'menu-not-found': {
      await logDomFailure(Runtime, logger, 'thinking-time-menu');
      throw new Error('Unable to find the Thinking time dropdown menu.');
    }
    case 'extended-not-found': {
      await logDomFailure(Runtime, logger, 'extended-option');
      throw new Error('Unable to find the Extended option in the Thinking time menu.');
    }
    default: {
      await logDomFailure(Runtime, logger, 'thinking-time-unknown');
      throw new Error('Unknown error selecting Extended thinking time.');
    }
  }
}

function buildThinkingTimeExpression(): string {
  return `(async () => {
    ${buildClickDispatcher()}

    const CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];

    const INITIAL_WAIT_MS = 150;
    const MAX_WAIT_MS = 10000;

    const findThinkingChip = () => {
      for (const selector of CHIP_SELECTORS) {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? '';
          if (text.includes('thinking')) {
            return btn;
          }
        }
      }
      return null;
    };

    const chip = findThinkingChip();
    if (!chip) {
      return { status: 'chip-not-found' };
    }

    dispatchClickSequence(chip);

    return new Promise((resolve) => {
      const start = performance.now();

      const findMenu = () => {
        const menus = document.querySelectorAll('[role="group"], [role="menu"], [data-radix-collection-root]');
        for (const menu of menus) {
          const label = menu.querySelector('.__menu-label, [class*="menu-label"]');
          if (label?.textContent?.toLowerCase().includes('thinking time')) {
            return menu;
          }
          const text = menu.textContent?.toLowerCase() ?? '';
          if (text.includes('standard') && text.includes('extended')) {
            return menu;
          }
        }
        return null;
      };

      const findExtendedOption = (menu) => {
        const items = menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"], button');
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? '';
          if (text.includes('extended')) {
            return item;
          }
        }
        return null;
      };

      const isExtendedSelected = (menu) => {
        const items = menu.querySelectorAll('[role="menuitemradio"]');
        for (const item of items) {
          const text = item.textContent?.toLowerCase() ?? '';
          const checked = item.getAttribute('aria-checked') === 'true' ||
                          item.getAttribute('data-state') === 'checked';
          if (text.includes('extended') && checked) {
            return true;
          }
        }
        return false;
      };

      const attempt = () => {
        const menu = findMenu();
        if (!menu) {
          if (performance.now() - start > MAX_WAIT_MS) {
            resolve({ status: 'menu-not-found' });
            return;
          }
          setTimeout(attempt, 100);
          return;
        }

        const extendedOption = findExtendedOption(menu);
        if (!extendedOption) {
          resolve({ status: 'extended-not-found' });
          return;
        }

        const alreadySelected = isExtendedSelected(menu);
        dispatchClickSequence(extendedOption);
        resolve({ status: alreadySelected ? 'already-extended' : 'switched' });
      };

      setTimeout(attempt, INITIAL_WAIT_MS);
    });
  })()`;
}

export function buildThinkingTimeExpressionForTest(): string {
  return buildThinkingTimeExpression();
}
