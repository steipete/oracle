import type { ChromeClient, BrowserLogger } from '../types.js';
import type { ThinkingTimeLevel } from '../../oracle/types.js';
import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR } from '../constants.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

type ThinkingTimeOutcome =
  | { status: 'already-selected'; label?: string | null }
  | { status: 'switched'; label?: string | null }
  | { status: 'chip-not-found' }
  | { status: 'menu-not-found' }
  | { status: 'option-not-found' };

/**
 * Selects a specific thinking time level in ChatGPT's composer pill menu.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient['Runtime'],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

  switch (result?.status) {
    case 'already-selected':
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case 'switched':
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case 'chip-not-found': {
      await logDomFailure(Runtime, logger, 'thinking-chip');
      throw new Error('Unable to find the Thinking chip button in the composer area.');
    }
    case 'menu-not-found': {
      await logDomFailure(Runtime, logger, 'thinking-time-menu');
      throw new Error('Unable to find the Thinking time dropdown menu.');
    }
    case 'option-not-found': {
      await logDomFailure(Runtime, logger, `${level}-option`);
      throw new Error(`Unable to find the ${capitalizedLevel} option in the Thinking time menu.`);
    }
    default: {
      await logDomFailure(Runtime, logger, 'thinking-time-unknown');
      throw new Error(`Unknown error selecting ${capitalizedLevel} thinking time.`);
    }
  }
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient['Runtime'],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case 'already-selected':
        logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
        return true;
      case 'switched':
        logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
        return true;
      case 'chip-not-found':
      case 'menu-not-found':
      case 'option-not-found':
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll('-', ' ')}; continuing with default.`);
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

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient['Runtime'],
  level: ThinkingTimeLevel,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(level: ThinkingTimeLevel): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};

    const CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];

    const INITIAL_WAIT_MS = 150;
    const MAX_WAIT_MS = 10000;

    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

    const findThinkingChip = () => {
      for (const selector of CHIP_SELECTORS) {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          if (aria.includes('thinking') || text.includes('thinking')) {
            return btn;
          }

          // In some cases the pill is labeled "Pro".
          if (aria.includes('pro') || text.includes('pro')) {
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
        const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
        for (const menu of menus) {
          const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
          if (normalize(label?.textContent ?? '').includes('thinking time')) {
            return menu;
          }
          const text = normalize(menu.textContent ?? '');
          if (text.includes('standard') && text.includes('extended')) {
            return menu;
          }
        }
        return null;
      };

      const findTargetOption = (menu) => {
        const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
        for (const item of items) {
          const text = normalize(item.textContent ?? '');
          if (text.includes(TARGET_LEVEL)) {
            return item;
          }
        }
        return null;
      };

      const optionIsSelected = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const ariaChecked = node.getAttribute('aria-checked');
        const dataState = (node.getAttribute('data-state') || '').toLowerCase();
        if (ariaChecked === 'true') return true;
        if (dataState === 'checked' || dataState === 'selected' || dataState === 'on') return true;
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

        const targetOption = findTargetOption(menu);
        if (!targetOption) {
          resolve({ status: 'option-not-found' });
          return;
        }

        const alreadySelected =
          optionIsSelected(targetOption) ||
          optionIsSelected(targetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
        const label = targetOption.textContent?.trim?.() || null;
        dispatchClickSequence(targetOption);
        resolve({ status: alreadySelected ? 'already-selected' : 'switched', label });
      };

      setTimeout(attempt, INITIAL_WAIT_MS);
    });
  })()`;
}

export function buildThinkingTimeExpressionForTest(level: ThinkingTimeLevel = 'extended'): string {
  return buildThinkingTimeExpression(level);
}
