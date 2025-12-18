import type { ChromeClient, BrowserLogger } from '../types.js';
import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR } from '../constants.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

type ThinkingTimeOutcome =
  | { status: 'already-selected'; label?: string | null }
  | { status: 'switched'; label?: string | null }
  | { status: 'chip-not-found' }
  | { status: 'menu-not-found' }
  | { status: 'option-not-found' };

export async function ensureThinkingEffort(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  effort: 'standard' | 'extended',
) {
  const result = await evaluateThinkingTimeSelection(Runtime, effort);

  switch (result?.status) {
    case 'already-selected':
      logger(`Thinking effort: ${result.label ?? effort} (already selected)`);
      return;
    case 'switched':
      logger(`Thinking effort: ${result.label ?? effort}`);
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
      await logDomFailure(Runtime, logger, 'thinking-effort-option');
      throw new Error(`Unable to find the ${effort} option in the Thinking effort menu.`);
    }
    default: {
      await logDomFailure(Runtime, logger, 'thinking-time-unknown');
      throw new Error('Unknown error selecting thinking effort.');
    }
  }
}

/**
 * Best-effort selection of the requested thinking-effort option in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 */
export async function ensureThinkingEffortIfAvailable(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  effort: 'standard' | 'extended',
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, effort);

    switch (result?.status) {
      case 'already-selected':
        logger(`Thinking effort: ${result.label ?? effort} (already selected)`);
        return true;
      case 'switched':
        logger(`Thinking effort: ${result.label ?? effort}`);
        return true;
      case 'chip-not-found':
      case 'menu-not-found':
      case 'option-not-found':
        if (logger.verbose) {
          logger(`Thinking effort: ${result.status.replaceAll('-', ' ')}; continuing with default.`);
        }
        return false;
      default:
        if (logger.verbose) {
          logger('Thinking effort: unknown outcome; continuing with default.');
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking effort selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, 'thinking-time');
    }
    return false;
  }
}

export async function ensureExtendedThinking(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  return ensureThinkingEffort(Runtime, logger, 'extended');
}

export async function ensureExtendedThinkingIfAvailable(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  return ensureThinkingEffortIfAvailable(Runtime, logger, 'extended');
}

export async function ensureStandardThinkingIfAvailable(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  return ensureThinkingEffortIfAvailable(Runtime, logger, 'standard');
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient['Runtime'],
  effort: 'standard' | 'extended',
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(effort),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(effort: 'standard' | 'extended'): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const desiredLiteral = JSON.stringify(effort);

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const DESIRED = ${desiredLiteral};

    const CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
      // Fallbacks for evolving ChatGPT UI
      '[data-testid*="composer"] button[aria-haspopup="menu"]',
      '[data-testid*="composer"] [role="button"][aria-haspopup="menu"]',
      'button[aria-haspopup="menu"]',
    ];

    // The effort menu can appear with a small latency after the composer mounts.
    const CHIP_WAIT_MS = 5000;
    const INITIAL_WAIT_MS = 400;
    const MAX_WAIT_MS = 10000;

    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const findCandidateChips = () => {
      const out = [];
      for (const selector of CHIP_SELECTORS) {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          if (!isVisible(btn)) continue;
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          // "Thinking" models may expose this as "Reasoning effort" with options like
          // "Standard" and "Extended", or as a "Thinking time" pill.
          if (
            aria.includes('thinking') ||
            text.includes('thinking') ||
            aria.includes('reasoning') ||
            text.includes('reasoning') ||
            aria.includes('effort') ||
            text.includes('effort') ||
            text.includes('standard') ||
            text.includes('extended')
          ) {
            out.push(btn);
            continue;
          }
          // GPT-5 Pro exposes a "Pro" pill whose menu contains "Standard"/"Extended".
          // Prefer composer pills over unrelated menu buttons.
          if (text === 'pro' || aria.includes('pro')) {
            out.push(btn);
            continue;
          }
        }
      }
      return out;
    };

    const chipStart = performance.now();
    let chips = findCandidateChips();
    while (chips.length === 0 && performance.now() - chipStart < CHIP_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 100));
      chips = findCandidateChips();
    }
    if (chips.length === 0) return { status: 'chip-not-found' };

    const findMenu = () => {
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="menu"], [role="group"]');
      for (const menu of menus) {
        const text = normalize(menu.textContent ?? '');
        if (text.includes('standard') && text.includes('extended')) {
          return menu;
        }
      }
      return null;
    };

    const findDesiredOption = (menu) => {
      const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
      for (const item of items) {
        const text = normalize(item.textContent ?? '');
        if (text.includes(DESIRED)) {
          return item;
        }
      }
      // Fallback: some menus render buttons directly.
      const buttons = menu.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"]');
      for (const btn of buttons) {
        const text = normalize(btn.textContent ?? '');
        if (text.includes(DESIRED)) {
          return btn;
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

    const clickChipAndSelectExtended = async (chip) => {
      dispatchClickSequence(chip);

      const start = performance.now();
      while (performance.now() - start < MAX_WAIT_MS) {
        const menu = findMenu();
        if (!menu) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        const desiredOption = findDesiredOption(menu);
        if (!desiredOption) return { status: 'option-not-found' };

        const alreadySelected =
          optionIsSelected(desiredOption) ||
          optionIsSelected(desiredOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
        const label = desiredOption.textContent?.trim?.() || null;
        dispatchClickSequence(desiredOption);
        return { status: alreadySelected ? 'already-selected' : 'switched', label };
      }
      return { status: 'menu-not-found' };
    };

    // Try likely candidates first, but fall back to probing any visible chip in the footer.
    const seen = new Set();
    const uniqueChips = chips.filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
    for (const chip of uniqueChips) {
      await new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
      const result = await clickChipAndSelectExtended(chip);
      if (result?.status === 'switched' || result?.status === 'already-selected') {
        return result;
      }
    }

    return { status: 'chip-not-found' };
  })()`;
}

export function buildThinkingTimeExpressionForTest(): string {
  return buildThinkingTimeExpression('extended');
}
