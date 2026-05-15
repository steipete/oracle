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
  | { status: "option-not-found" }
  | { status: "model-kind-not-found"; modelKind?: string | null };

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
  desiredModel?: string | null,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);
  const targetModelKind = inferThinkingTargetModelKind(desiredModel);
  const strictProEffort = targetModelKind === "pro" && level === "extended";

  switch (result?.status) {
    case "already-selected":
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case "switched":
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case "chip-not-found":
    case "menu-not-found":
    case "option-not-found":
    case "model-kind-not-found": {
      await logDomFailure(Runtime, logger, `thinking-${result.status}`);
      const kindHint =
        result.status === "model-kind-not-found" && result.modelKind
          ? ` for ${result.modelKind}`
          : targetModelKind
            ? ` for ${targetModelKind}`
            : "";
      const message = `Thinking time: ${result.status.replaceAll("-", " ")}${kindHint} (requested ${capitalizedLevel})`;
      if (
        strictProEffort &&
        (result.status === "option-not-found" || result.status === "model-kind-not-found")
      ) {
        throw new Error(`${message}; refusing to submit without confirmed Pro Extended.`);
      }
      logger(`${message}; continuing with ChatGPT default.`);
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
  desiredModel?: string | null,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
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
      case "model-kind-not-found":
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
  desiredModel?: string | null,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level, desiredModel),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(
  level: ThinkingTimeLevel,
  desiredModel?: string | null,
): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());
  const targetModelKindLiteral = JSON.stringify(inferThinkingTargetModelKind(desiredModel));

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const TARGET_MODEL_KIND = ${targetModelKindLiteral};

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
    const matchesLevel = (text) => {
      const t = normalize(text);
      return targetTokens.some((tok) => t.includes(String(tok).toLowerCase()));
    };
    const hasToken = (text, token) => normalize(text).split(' ').includes(token);
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
    const KIND_NOT_FOUND = { kindNotFound: true };
    const findEffortRow = (node) => {
      let current = node instanceof HTMLElement ? node.parentElement : null;
      while (current && current !== document.body) {
        if (current.getAttribute?.('data-model-picker-thinking-effort-row') === 'true') {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const rowIsSelected = (row) => {
      if (!(row instanceof HTMLElement)) return false;
      const modelItem = row.querySelector('[data-model-picker-thinking-effort-menu-item="true"], [role="menuitemradio"]');
      if (optionIsSelected(modelItem)) return true;
      return Boolean(
        row.querySelector(
          '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], [data-selected="true"], [data-state="checked"], [data-state="selected"], [data-state="on"]',
        ),
      );
    };
    const rowForTrailing = (trailing) =>
      trailing.closest('[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]');
    const rowTextForTrailing = (trailing) => {
      const row = rowForTrailing(trailing) || findEffortRow(trailing);
      return normalize(
        (row?.getAttribute?.('aria-label') ?? '') + ' ' +
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (row?.textContent ?? '') + ' ' +
        (trailing.getAttribute?.('aria-label') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
    };
    const testIdTextForTrailing = (trailing) => {
      const row = rowForTrailing(trailing) || findEffortRow(trailing);
      return normalize(
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
    };
    const modelKindFromTrailing = (trailing) => {
      const idText = testIdTextForTrailing(trailing);
      if (!idText.includes('model switcher')) return null;
      const modelPart = normalize(idText.replace(/\\bthinking effort\\b.*$/, ''));
      if (hasToken(modelPart, 'pro')) return 'pro';
      if (hasToken(modelPart, 'thinking')) return 'thinking';
      if (hasToken(modelPart, 'instant')) return 'instant';
      return null;
    };
    const trailingMatchesTargetModelKind = (trailing) => {
      if (!TARGET_MODEL_KIND) return false;
      const idKind = modelKindFromTrailing(trailing);
      if (idKind) return idKind === TARGET_MODEL_KIND;
      const text = rowTextForTrailing(trailing);
      if (TARGET_MODEL_KIND === 'pro') {
        return hasToken(text, 'pro') && !hasToken(text, 'thinking');
      }
      if (TARGET_MODEL_KIND === 'thinking') {
        return hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      if (TARGET_MODEL_KIND === 'instant') {
        return hasToken(text, 'instant') && !hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      return false;
    };
    const hasStableBox = (node) => {
      const r = node.getBoundingClientRect?.();
      return Boolean(r && r.width > 0 && r.height > 0 && node.getAttribute?.('aria-hidden') !== 'true');
    };
    const pickSingleStableTrailing = (trailings) => {
      const visible = trailings.filter((t) => hasStableBox(t));
      return visible.length === 1 ? visible[0] : null;
    };
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      if (trailings.length === 1) return trailings[0];
      // Prefer the trailing button whose model row is currently selected.
      for (const t of trailings) {
        const row = findEffortRow(t);
        if (rowIsSelected(row)) return t;
      }
      if (TARGET_MODEL_KIND) {
        const targetTrailings = trailings.filter((t) => trailingMatchesTargetModelKind(t));
        return pickSingleStableTrailing(targetTrailings) || KIND_NOT_FOUND;
      }
      return null;
    };

    const modelBtn = findModelButton();
    if (!modelBtn) {
      return { status: 'chip-not-found' };
    }
    const modelButtonLabel = normalize(
      (modelBtn.getAttribute?.('aria-label') ?? '') + ' ' + (modelBtn.textContent ?? '')
    );
    if (
      TARGET_MODEL_KIND === 'pro' &&
      TARGET_LEVEL === 'extended' &&
      hasToken(modelButtonLabel, 'pro') &&
      hasToken(modelButtonLabel, 'extended') &&
      !hasToken(modelButtonLabel, 'thinking')
    ) {
      return { status: 'already-selected', label: modelBtn.textContent?.trim?.() || null };
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
    if (trailing.kindNotFound) {
      closeOpenMenus();
      return { status: 'model-kind-not-found', modelKind: TARGET_MODEL_KIND };
    }

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

    const already = optionIsSelected(targetOption);
    const label = targetOption.textContent?.trim?.() || null;
    dispatchClickSequence(targetOption);
    await sleep(STEP_WAIT_MS);
    closeOpenMenus();
    return { status: already ? 'already-selected' : 'switched', label };
  })()`;
}

export function buildThinkingTimeExpressionForTest(
  level: ThinkingTimeLevel = "extended",
  desiredModel?: string | null,
): string {
  return buildThinkingTimeExpression(level, desiredModel);
}

function inferThinkingTargetModelKind(
  desiredModel?: string | null,
): "pro" | "thinking" | "instant" | null {
  const normalized = (desiredModel ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  if (tokens.includes("pro")) return "pro";
  if (tokens.includes("thinking")) return "thinking";
  if (tokens.includes("instant")) return "instant";
  return null;
}

export function inferThinkingTargetModelKindForTest(
  desiredModel?: string | null,
): "pro" | "thinking" | "instant" | null {
  return inferThinkingTargetModelKind(desiredModel);
}
