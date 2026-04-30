import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { buildModelPickerDomHelpers } from "./modelPickerDom.js";

type ThinkingTimeOutcome =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found" }
  | { status: "menu-not-found" }
  | { status: "option-not-found" };

/**
 * Selects a specific thinking time level in ChatGPT's composer.
 *
 * Best-effort: if the chip / menu / option is missing (for example because
 * ChatGPT moved the effort selector into the per-model trailing button), log a
 * debug dump and continue with whatever effort the UI defaults to.
 *
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

  switch (result?.status) {
    case "already-selected":
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case "switched":
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case "chip-not-found":
    case "menu-not-found":
    case "option-not-found": {
      await logDomFailure(Runtime, logger, `thinking-${result.status}`);
      logger(
        `Thinking time: ${result.status.replaceAll("-", " ")} (requested ${capitalizedLevel}); continuing with ChatGPT default.`,
      );
      return;
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      logger(
        `Thinking time: unknown outcome selecting ${capitalizedLevel}; continuing with ChatGPT default.`,
      );
      return;
    }
  }
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case "already-selected":
        logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
        return true;
      case "switched":
        logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
        return true;
      case "chip-not-found":
      case "menu-not-found":
      case "option-not-found":
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll("-", " ")}; continuing with default.`);
        }
        return false;
      default:
        if (logger.verbose) {
          logger("Thinking time: unknown outcome; continuing with default.");
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking time selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, "thinking-time");
    }
    return false;
  }
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient["Runtime"],
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
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};

    // English level token + observed Chinese variants.
    const LEVEL_TOKENS = {
      light: ['light', '轻'],
      standard: ['standard', '标准'],
      extended: ['extended', '扩展', '深度', '加强'],
      heavy: ['heavy', '重度', '加重', '高'],
    };
    const targetTokens = LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const matchesLevel = (text) => {
      const t = normalize(text);
      return targetTokens.some((tok) => t.includes(String(tok).toLowerCase()));
    };
    ${buildModelPickerDomHelpers()}
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      return ariaChecked === 'true' || dataState === 'checked' || dataState === 'selected' || dataState === 'on';
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };

    const OLD_CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];
    const findOldChip = () => {
      for (const selector of OLD_CHIP_SELECTORS) {
        for (const btn of document.querySelectorAll(selector)) {
          if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
          const testId = btn.getAttribute?.('data-testid') ?? '';
          if (testId.includes('model-switcher')) continue;
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          const label = [aria, text].filter(Boolean).join(' ');
          const hasVersion = /\\b5\\b/.test(label) || /\\b5\\s+[0-9]\\b/.test(label);
          if (!hasVersion && EFFORT_LABELS.has(text)) return btn;
          if (!hasVersion && (aria.includes('thinking') || text.includes('thinking'))) return btn;
          if (!hasVersion && (aria === 'pro' || text === 'pro')) return btn;
        }
      }
      return null;
    };
    const findOldEffortMenu = () => {
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
      for (const menu of menus) {
        const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
        if (normalize(label?.textContent ?? '').includes('thinking time')) return menu;
        const text = normalize(menu.textContent ?? '');
        if (text.includes('standard') && text.includes('extended')) return menu;
      }
      return null;
    };
    const findOptionInMenu = (menu) => {
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (
          matchesLevel(item.textContent ?? '') ||
          matchesLevel(item.getAttribute?.('aria-label') ?? '')
        ) {
          return item;
        }
      }
      return null;
    };

    const oldChip = findOldChip();
    if (oldChip) {
      dispatchClickSequence(oldChip);
      const start = performance.now();
      while (performance.now() - start < MAX_WAIT_MS) {
        await sleep(100);
        const menu = findOldEffortMenu();
        if (!menu) continue;
        const opt = findOptionInMenu(menu);
        if (!opt) {
          closeOpenMenus();
          return { status: 'option-not-found' };
        }
        const already = optionIsSelected(opt);
        const label = opt.textContent?.trim?.() || null;
        dispatchClickSequence(opt);
        await sleep(STEP_WAIT_MS);
        closeOpenMenus();
        return { status: already ? 'already-selected' : 'switched', label };
      }
      closeOpenMenus();
      // Fall through to the newer model-picker effort flow. Some ChatGPT builds
      // expose Pro/Thinking as a composer pill but keep the effort menu under
      // the selected model row.
    }

    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';
    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const modelLabel = () => normalize(modelBtn.textContent ?? '');
    const findEffortRow = (trailing) =>
      trailing.closest?.('[class*="model-picker-thinking-effort-row"]') ??
      trailing.closest?.('[data-radix-collection-item]') ??
      trailing.parentElement;
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      const currentLabel = modelLabel();
      const currentKind = modelKindFromLabel(currentLabel);
      let best = null;
      for (const t of trailings) {
        const row = findEffortRow(t);
        const testId = (t.getAttribute?.('data-testid') ?? '').toLowerCase();
        const testIdKind = modelKindFromTestId(testId);
        const rowKind = modelKindFromLabel(row?.textContent ?? '');
        let score = 0;
        const rowSelected = row && (optionIsSelected(row) || row.querySelector('[aria-checked="true"]'));
        if (rowSelected) {
          score += 1000;
        }
        if (currentKind) {
          if (testIdKind === currentKind) score += 500;
          else if (testIdKind) score -= 500;
          if (rowKind === currentKind) score += 250;
          else if (rowKind) score -= 250;
        }
        if (!best || score > best.score) best = { trailing: t, score };
      }
      if (best && best.score > 0) return best.trailing;
      return null;
    };

    const modelBtn = findModelButton();
    if (!modelBtn) {
      return { status: 'chip-not-found' };
    }

    if (modelBtn.getAttribute('aria-expanded') !== 'true') {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
    }

    let trailing = null;
    const trailingDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < trailingDeadline) {
      trailing = pickTrailingForCurrentModel();
      if (trailing) break;
      await sleep(100);
    }
    if (!trailing) {
      closeOpenMenus();
      return { status: 'option-not-found' };
    }

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    const resolveEffortMenu = () => {
      const id = trailing.getAttribute('aria-controls');
      if (id) {
        const node = document.getElementById(id);
        if (node) return node;
      }
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
      let best = null;
      for (const menu of menus) {
        if (menu === modelBtn || menu.contains(trailing)) continue;
        const text = normalize(menu.textContent ?? '');
        let hits = 0;
        for (const tokens of Object.values(LEVEL_TOKENS)) {
          if (tokens.some((tok) => text.includes(String(tok).toLowerCase()))) hits += 1;
        }
        if (hits >= 2 && (!best || hits > best.hits)) best = { menu, hits };
      }
      return best?.menu ?? null;
    };

    let effortMenu = null;
    const effortDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < effortDeadline) {
      effortMenu = resolveEffortMenu();
      if (effortMenu) break;
      await sleep(100);
    }
    if (!effortMenu) {
      closeOpenMenus();
      return { status: 'menu-not-found' };
    }

    const targetOption = findOptionInMenu(effortMenu);
    if (!targetOption) {
      closeOpenMenus();
      return { status: 'option-not-found' };
    }

    const already = optionIsSelected(targetOption);
    const label = targetOption.textContent?.trim?.() || null;
    dispatchClickSequence(targetOption);
    await sleep(STEP_WAIT_MS);
    closeOpenMenus();
    return { status: already ? 'already-selected' : 'switched', label };
  })()`;
}

export function buildThinkingTimeExpressionForTest(level: ThinkingTimeLevel = "extended"): string {
  return buildThinkingTimeExpression(level);
}
