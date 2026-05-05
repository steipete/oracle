import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

type ThinkingTimeOutcome =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found" }
  | { status: "menu-not-found" }
  | { status: "option-not-found" };

/**
 * Selects a specific thinking time level in ChatGPT's composer.
 *
 * Best-effort: if the chip / menu / option is missing (e.g. ChatGPT moved the
 * effort selector into the per-model trailing button and we can't navigate it,
 * or the language pack uses tokens we don't yet match), we log a debug dump
 * and continue with whatever effort the UI defaults to.
 *
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
  targetModel?: string | null,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level, targetModel);
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
  targetModel?: string | null,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level, targetModel),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(
  level: ThinkingTimeLevel,
  targetModel?: string | null,
): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());
  const targetModelLiteral = JSON.stringify(targetModel?.trim() || null);

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const TARGET_MODEL = ${targetModelLiteral};

    // Bilingual matchers: English level token + observed Chinese variants.
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
    // Keep CJK characters so we can match Chinese labels against LEVEL_TOKENS.
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const normalizedTargetModel = normalize(TARGET_MODEL);
    const targetModelVersion = normalizedTargetModel.includes('5 5')
      ? '5-5'
      : normalizedTargetModel.includes('5 4')
        ? '5-4'
        : normalizedTargetModel.includes('5 2')
          ? '5-2'
          : normalizedTargetModel.includes('5 1')
            ? '5-1'
            : normalizedTargetModel.includes('5 0')
              ? '5-0'
              : null;
    const targetWantsPro = normalizedTargetModel.includes('pro');
    const targetWantsThinking = normalizedTargetModel.includes('thinking');
    const targetWantsInstant = normalizedTargetModel.includes('instant');
    const matchesLevel = (text) => {
      const t = normalize(text);
      return targetTokens.some((tok) => t.includes(String(tok).toLowerCase()));
    };
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true') return true;
      return dataState === 'checked' || dataState === 'selected' || dataState === 'on';
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };

    // ---------- OLD UI: standalone composer chip labelled "Thinking" ----------
    const OLD_CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];
    const findOldChip = () => {
      for (const selector of OLD_CHIP_SELECTORS) {
        for (const btn of document.querySelectorAll(selector)) {
          if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
          // The new model picker pill also reuses .__composer-pill — skip it.
          if (btn.matches?.(MODEL_BUTTON_SELECTOR)) continue;
          const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
          const text = normalize(btn.textContent ?? '');
          if (aria.includes('thinking') || text.includes('thinking')) return btn;
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
      return { status: 'menu-not-found' };
    }

    // ---------- NEW UI: thinking effort lives inside the model picker ----------
    // Each eligible model row carries a trailing button:
    //   [data-model-picker-thinking-effort-action="true"] (role="menuitem", aria-haspopup="menu")
    // Clicking it expands a submenu of effort options. We use aria-controls to
    // resolve the submenu deterministically rather than scoring menu contents.
    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';

    const findModelButton = () => document.querySelector(MODEL_BUTTON_SELECTOR);
    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const normalizeModelRowText = (node) => {
      if (!(node instanceof HTMLElement)) return '';
      const parts = [
        node.textContent ?? '',
        node.getAttribute('aria-label') ?? '',
        node.getAttribute('data-testid') ?? '',
      ];
      return normalize(parts.join(' '));
    };
    const modelRowMatchesTarget = (row) => {
      if (!normalizedTargetModel || !(row instanceof HTMLElement)) return false;
      const text = normalizeModelRowText(row);
      if (!text) return false;
      if (targetModelVersion === '5-5') {
        const has55 = text.includes('5 5') || text.includes('gpt55') || text.includes('gpt 5 5');
        const isCurrentProAlias = targetWantsPro && text.includes('pro') && !text.includes('thinking');
        if (!has55 && !isCurrentProAlias) return false;
      } else if (targetModelVersion === '5-4' && !text.includes('5 4')) {
        return false;
      } else if (targetModelVersion === '5-2' && !text.includes('5 2')) {
        return false;
      } else if (targetModelVersion === '5-1' && !text.includes('5 1')) {
        return false;
      } else if (targetModelVersion === '5-0' && !text.includes('5 0')) {
        return false;
      }
      if (targetWantsPro && !text.includes('pro')) return false;
      if (!targetWantsPro && text.includes('pro')) return false;
      if (targetWantsThinking && !text.includes('thinking')) return false;
      if (!targetWantsThinking && text.includes('thinking')) return false;
      if (targetWantsInstant && !text.includes('instant')) return false;
      if (!targetWantsInstant && text.includes('instant')) return false;
      return true;
    };
    const getModelRowForTrailing = (trailing) => {
      const rowContainer = trailing?.closest?.('[class*="model-picker-thinking-effort-row"]');
      const row = rowContainer?.querySelector?.(
        '[data-model-picker-thinking-effort-menu-item="true"], [role="menuitemradio"][data-testid*="model-switcher-"]',
      );
      if (row) return row;
      return trailing?.closest?.('[role="menuitemradio"], [data-radix-collection-item]');
    };
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      if (trailings.length === 1) return trailings[0];
      // Prefer the trailing effort button on the model row Oracle just selected.
      for (const t of trailings) {
        const row = getModelRowForTrailing(t);
        if (modelRowMatchesTarget(row)) return t;
      }
      // Prefer the trailing button whose model row is currently selected.
      for (const t of trailings) {
        const row = getModelRowForTrailing(t);
        if (row && (optionIsSelected(row) || row.querySelector('[aria-checked="true"]'))) return t;
      }
      // Fallback: first one with non-zero box.
      for (const t of trailings) {
        const r = t.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) return t;
      }
      return trailings[0];
    };

    const modelBtn = findModelButton();
    if (!modelBtn) {
      return { status: 'chip-not-found' };
    }

    // Open model menu (idempotent — leaves it open if already open).
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
      return { status: 'chip-not-found' };
    }

    const targetModelRow = getModelRowForTrailing(trailing);
    const targetModelAlreadySelected = !TARGET_MODEL || optionIsSelected(targetModelRow);

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    // Resolve the effort submenu via aria-controls when ChatGPT exposes it,
    // otherwise fall back to scanning newly opened menus for our level tokens.
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

    const effortAlreadySelected = optionIsSelected(targetOption);
    const label = targetOption.textContent?.trim?.() || null;
    if (!effortAlreadySelected) {
      dispatchClickSequence(targetOption);
      await sleep(STEP_WAIT_MS);
    }
    if (
      TARGET_MODEL &&
      targetModelRow instanceof HTMLElement &&
      targetModelRow.isConnected &&
      !optionIsSelected(targetModelRow)
    ) {
      dispatchClickSequence(targetModelRow);
      await sleep(STEP_WAIT_MS);
    }
    closeOpenMenus();
    return { status: effortAlreadySelected && targetModelAlreadySelected ? 'already-selected' : 'switched', label };
  })()`;
}

export function buildThinkingTimeExpressionForTest(
  level: ThinkingTimeLevel = "extended",
  targetModel?: string | null,
): string {
  return buildThinkingTimeExpression(level, targetModel);
}
