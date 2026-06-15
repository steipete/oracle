import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

// Snapshot of the model-picker / thinking-effort subtree, captured at the moment
// detection fails so a chip-not-found can be diagnosed without re-running with
// --verbose. Loosely typed: the shape is whatever the injected probe returns.
type ThinkingTimePickerDiagnostic = Record<string, unknown>;

type ThinkingTimeOutcome = (
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "menu-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "option-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "selection-unverified"; diagnostic?: ThinkingTimePickerDiagnostic }
  | {
      status: "model-kind-not-found";
      diagnostic?: ThinkingTimePickerDiagnostic;
    }
) & { modelKind?: string | null };

const BROWSER_THINKING_LOG_PREFIX = "[browser] Thinking time:";

function formatBrowserThinkingLog(message: string): string {
  return `${BROWSER_THINKING_LOG_PREFIX} ${message.replace(/^Thinking time:\s*/, "")}`;
}

/**
 * Surfaces the model-picker snapshot captured alongside a failed detection.
 *
 * The browser prefix routes this through the session runner's non-verbose
 * always-print path. The injected probe bounds and redacts all text values.
 */
function logPickerDiagnostic(result: ThinkingTimeOutcome | undefined, logger: BrowserLogger): void {
  const diagnostic =
    result && "diagnostic" in result
      ? (result.diagnostic as ThinkingTimePickerDiagnostic | undefined)
      : undefined;
  if (!diagnostic) {
    return;
  }
  logger(`[browser] Model picker diagnostic: ${JSON.stringify(diagnostic)}`);
}

/**
 * Selects a thinking-time level in ChatGPT's composer.
 *
 * Missing controls remain best-effort except Pro Extended, which fails closed
 * unless the selected option is confirmed.
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
  const observedModelKind = result && "modelKind" in result ? result.modelKind : null;
  const strictProEffort =
    (targetModelKind === "pro" || observedModelKind === "pro") && level === "extended";

  switch (result?.status) {
    case "already-selected":
      logger(formatBrowserThinkingLog(`${result.label ?? capitalizedLevel} (already selected)`));
      return;
    case "switched":
      logger(formatBrowserThinkingLog(result.label ?? capitalizedLevel));
      return;
    case "chip-not-found":
    case "menu-not-found":
    case "option-not-found":
    case "selection-unverified":
    case "model-kind-not-found": {
      await logDomFailure(Runtime, logger, `thinking-${result.status}`);
      logPickerDiagnostic(result, logger);
      const kindHint =
        result.status === "model-kind-not-found" && result.modelKind
          ? ` for ${result.modelKind}`
          : targetModelKind
            ? ` for ${targetModelKind}`
            : "";
      const message = `Thinking time: ${result.status.replaceAll("-", " ")}${kindHint} (requested ${capitalizedLevel})`;
      if (strictProEffort) {
        throw new Error(`${message}; refusing to submit without confirmed Pro Extended.`);
      }
      logger(formatBrowserThinkingLog(`${message}; continuing with ChatGPT default.`));
      return;
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      logPickerDiagnostic(result, logger);
      if (strictProEffort) {
        throw new Error(
          `Thinking time: unknown outcome selecting ${capitalizedLevel}; refusing to submit without confirmed Pro Extended.`,
        );
      }
      logger(
        formatBrowserThinkingLog(
          `unknown outcome selecting ${capitalizedLevel}; continuing with ChatGPT default.`,
        ),
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
        logger(formatBrowserThinkingLog(`${result.label ?? capitalizedLevel} (already selected)`));
        return true;
      case "switched":
        logger(formatBrowserThinkingLog(result.label ?? capitalizedLevel));
        return true;
      case "chip-not-found":
      case "menu-not-found":
      case "option-not-found":
      case "selection-unverified":
      case "model-kind-not-found":
        if (logger.verbose) {
          logger(
            formatBrowserThinkingLog(
              `${result.status.replaceAll("-", " ")}; continuing with default.`,
            ),
          );
        }
        return false;
      default:
        if (logger.verbose) {
          logger(formatBrowserThinkingLog("unknown outcome; continuing with default."));
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(formatBrowserThinkingLog(`selection failed (${message}); continuing with default.`));
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
      light: ['light', 'instant', '轻'],
      standard: ['standard', 'medium', '标准'],
      extended: ['extended', 'high', '扩展', '深度', '加强'],
      heavy: ['heavy', 'extra high', '重度', '加重', '高'],
    };
    const targetTokens = LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;
    // The "Intelligence" menu renders right after opening the composer pill, so
    // a short probe is enough; if it's absent this is an older UI and we fall
    // back to the legacy paths without paying the full MAX_WAIT_MS.
    const INTELLIGENCE_WAIT_MS = 2500;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Keep CJK characters so we can match Chinese labels against LEVEL_TOKENS.
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const hasToken = (text, token) => normalize(text).split(' ').includes(token);
    const matchesLevel = (text) => {
      const t = normalize(text);
      if (!t) return false;
      return targetTokens.some((tok) => {
        const token = normalize(tok);
        if (!token) return false;
        if (token === 'high') return hasToken(t, 'high') && !hasToken(t, 'extra');
        if (token === 'extra high') return hasToken(t, 'extra') && hasToken(t, 'high');
        return t === token || hasToken(t, token) || t.includes(token);
      });
    };
    const matchesAnyEffortLevel = (text) => {
      const normalizedText = normalize(text);
      if (!normalizedText) return false;
      for (const tokens of Object.values(LEVEL_TOKENS)) {
        for (const rawToken of tokens) {
          const token = normalize(rawToken);
          if (!token) continue;
          if (token.includes(' ')) {
            if (token.split(' ').every((part) => hasToken(normalizedText, part))) return true;
          } else if (/^[a-z0-9]+$/.test(token)) {
            if (hasToken(normalizedText, token)) return true;
          } else if (normalizedText.includes(token)) {
            return true;
          }
        }
      }
      return false;
    };
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') return true;
      return (
        dataSelected === 'true' ||
        dataState === 'checked' ||
        dataState === 'selected' ||
        dataState === 'on' ||
        dataState === 'true'
      );
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };
    const dispatchHoverSequence = (target) => {
      if (!target || !(target instanceof EventTarget)) return false;
      const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
      for (const type of types) {
        try {
          const common = { bubbles: true, cancelable: true, view: window };
          const event =
            type.startsWith('pointer') && 'PointerEvent' in window
              ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
              : new MouseEvent(type, common);
          target.dispatchEvent(event);
        } catch {}
      }
      try {
        target.focus?.();
      } catch {}
      return true;
    };

    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';
    const INTELLIGENCE_MENU_SELECTOR = '[data-testid="composer-intelligence-picker-content"]';
    const PRO_EFFORT_TRIGGER_SELECTOR = '[data-testid="composer-intelligence-pro-thinking-effort-trigger"]';

    const findModelButton = () => document.querySelector(MODEL_BUTTON_SELECTOR);
    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const KIND_NOT_FOUND = { kindNotFound: true };

    const isVisible = (node) => {
      if (!node || node.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const redactDiagnosticText = (value, maxLength = 120) =>
      String(value ?? '')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/\\b[A-Za-z0-9_-]{32,}\\b/g, '[redacted]')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
    const describeNode = (el) => {
      if (!el || typeof el.getAttribute !== 'function') return null;
      let rect = null;
      try {
        const r = el.getBoundingClientRect?.();
        if (r) {
          rect = {
            w: Math.round(r.width),
            h: Math.round(r.height),
            visible: r.width > 0 && r.height > 0,
          };
        }
      } catch {}
      return {
        tag: el.tagName || null,
        testid: el.getAttribute('data-testid'),
        role: el.getAttribute('role'),
        ariaLabel: redactDiagnosticText(el.getAttribute('aria-label')),
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaSelected: el.getAttribute('aria-selected'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        dataState: el.getAttribute('data-state'),
        text: redactDiagnosticText(el.textContent, 80),
        rect,
      };
    };
    const describeMenu = (menu) => {
      if (!menu || typeof menu.querySelectorAll !== 'function') return null;
      const items = Array.from(
        menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, [data-testid]'),
      )
        .slice(0, 30)
        .map(describeNode);
      return {
        role: menu.getAttribute?.('role') ?? null,
        testid: menu.getAttribute?.('data-testid') ?? null,
        itemCount: items.length,
        items,
      };
    };
    const collectPickerDiagnostic = () => {
      try {
        const trailings = findTrailingButtons();
        const switchers = Array.from(document.querySelectorAll('[data-testid*="model-switcher"]'));
        const composerButtons = Array.from(
          document.querySelectorAll(
            'form button[aria-haspopup="menu"], [data-testid="model-switcher-dropdown-button"]',
          ),
        );
        const menus = Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).filter(
          isVisible,
        );
        const modelBtn = findModelButton();
        return {
          targetModelKind: TARGET_MODEL_KIND,
          targetLevel: TARGET_LEVEL,
          modelButton: describeNode(modelBtn),
          composerButtons: composerButtons.slice(0, 12).map(describeNode),
          trailingCount: trailings.length,
          trailings: trailings.slice(0, 12).map(describeNode),
          modelSwitcherCount: switchers.length,
          modelSwitcher: switchers.slice(0, 12).map(describeNode),
          menuCount: menus.length,
          menus: menus.slice(0, 4).map(describeMenu),
        };
      } catch (err) {
        return { error: redactDiagnosticText(err && err.message ? err.message : err) };
      }
    };
    const modelKindFromNode = (button) => {
      const label = normalize(
        (button?.textContent ?? '') + ' ' + (button?.getAttribute?.('aria-label') ?? ''),
      );
      if (hasToken(label, 'pro')) return 'pro';
      if (hasToken(label, 'thinking')) return 'thinking';
      if (hasToken(label, 'instant')) return 'instant';
      return null;
    };
    const currentModelKind = () => modelKindFromNode(findModelButton());
    const effectiveTargetModelKind = () => TARGET_MODEL_KIND || currentModelKind();
    const isIntelligenceEffortMenu = (menu) => {
      if (menu?.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') {
        return true;
      }
      const label = menu?.querySelector?.('.__menu-label, [class*="menu-label"]');
      return normalize(label?.textContent ?? '').includes('intelligence');
    };
    const failure = (status, extra = {}) => ({
      status,
      modelKind: effectiveTargetModelKind(),
      ...extra,
      diagnostic: collectPickerDiagnostic(),
    });
    const findOptionInMenu = (menu, modelKindOverride = null) => {
      const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR));
      const modelKind = modelKindOverride || effectiveTargetModelKind();
      if (modelKind === 'pro') {
        for (const item of items) {
          const itemText = normalize(
            (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
          );
          if (
            hasToken(itemText, 'pro') &&
            (matchesLevel(item.textContent ?? '') ||
              matchesLevel(item.getAttribute?.('aria-label') ?? ''))
          ) {
            return item;
          }
        }
        if (isIntelligenceEffortMenu(menu)) {
          return null;
        }
      }
      for (const item of items) {
        const itemText = normalize(
          (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
        );
        if (modelKind && modelKind !== 'pro' && hasToken(itemText, 'pro')) {
          continue;
        }
        if (
          matchesLevel(item.textContent ?? '') ||
          matchesLevel(item.getAttribute?.('aria-label') ?? '')
        ) {
          return item;
        }
      }
      return null;
    };
    const countEffortLevels = (menu) => {
      const text = normalize(menu?.textContent ?? '');
      let hits = 0;
      for (const tokens of Object.values(LEVEL_TOKENS)) {
        if (tokens.some((token) => text.includes(String(token).toLowerCase()))) hits += 1;
      }
      return hits;
    };
    const isEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      if (menu.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') return true;
      const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
      const labelText = normalize(label?.textContent ?? '');
      return (
        labelText.includes('intelligence') ||
        labelText.includes('thinking time') ||
        labelText.includes('thinking effort') ||
        countEffortLevels(menu) >= 2
      );
    };
    const isProEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      const text = normalize(menu?.textContent ?? '');
      return text.includes('pro standard') && text.includes('pro extended');
    };
    const controlledMenu = (trigger) => {
      const id = trigger?.getAttribute?.('aria-controls');
      if (!id) return null;
      const menu = document.getElementById?.(id);
      return isEffortMenu(menu) ? menu : null;
    };
    const findVisibleEffortMenu = (trigger) => {
      const controlled = controlledMenu(trigger);
      if (controlled) return controlled;
      for (const menu of document.querySelectorAll(MENU_CONTAINER_SELECTOR)) {
        if (isEffortMenu(menu)) return menu;
      }
      return null;
    };
    const controlledProEffortMenu = (trigger) => {
      const id = trigger?.getAttribute?.('aria-controls');
      if (!id) return null;
      const menu = document.getElementById?.(id);
      return isProEffortMenu(menu) ? menu : null;
    };
    const findVisibleProEffortMenu = (trigger) => {
      const controlled = controlledProEffortMenu(trigger);
      if (controlled) return controlled;
      for (const menu of document.querySelectorAll(MENU_CONTAINER_SELECTOR)) {
        if (isProEffortMenu(menu)) return menu;
      }
      return null;
    };
    const matchesProEffortLevel = (node) => {
      const text = normalize(
        (node?.textContent ?? '') + ' ' + (node?.getAttribute?.('aria-label') ?? ''),
      );
      if (TARGET_LEVEL === 'standard') {
        return text.includes('pro') && text.includes('standard');
      }
      if (TARGET_LEVEL === 'extended') {
        return text.includes('pro') && text.includes('extended');
      }
      return false;
    };
    const findProEffortOptionInMenu = (menu) => {
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (matchesProEffortLevel(item)) return item;
      }
      return null;
    };
    const currentProEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      const button = trigger?.matches?.('button.__composer-pill') ? trigger : findModelButton();
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) !== 'pro') {
        return false;
      }
      const label = normalize(button?.textContent ?? '');
      if (TARGET_LEVEL === 'standard') {
        return hasToken(label, 'pro') && !hasToken(label, 'extended');
      }
      if (TARGET_LEVEL === 'extended') {
        return hasToken(label, 'pro') && hasToken(label, 'extended');
      }
      return false;
    };
    const currentEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      if (currentProEffortPillMatchesTarget(trigger, modelKindOverride)) return true;
      const button = trigger?.matches?.('button.__composer-pill') ? trigger : findModelButton();
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) === 'pro') {
        return false;
      }
      const label = (button?.textContent ?? '') + ' ' + (button?.getAttribute?.('aria-label') ?? '');
      return matchesLevel(label);
    };
    const selectAndVerify = async (trigger, findOption, modelKindOverride = null) => {
      const option = findOption();
      const triggerModelKind =
        modelKindOverride ||
        TARGET_MODEL_KIND ||
        modelKindFromNode(trigger) ||
        effectiveTargetModelKind();
      if (!option) return failure('option-not-found', { modelKind: triggerModelKind });
      const label = option.textContent?.trim?.() || null;
      if (optionIsSelected(option)) {
        closeOpenMenus();
        return { status: 'already-selected', label };
      }

      dispatchClickSequence(option);
      await sleep(STEP_WAIT_MS);
      const refreshed = findOption();
      if (refreshed && optionIsSelected(refreshed)) {
        closeOpenMenus();
        return { status: 'switched', label: refreshed.textContent?.trim?.() || label };
      }
      if (currentEffortPillMatchesTarget(trigger, triggerModelKind)) {
        closeOpenMenus();
        return { status: 'switched', label };
      }

      if (!refreshed && trigger && trigger.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(trigger);
        await sleep(INITIAL_WAIT_MS);
      }
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const selected = findOption();
        if (selected && optionIsSelected(selected)) {
          closeOpenMenus();
          return { status: 'switched', label: selected.textContent?.trim?.() || label };
        }
        if (currentEffortPillMatchesTarget(trigger, triggerModelKind)) {
          closeOpenMenus();
          return { status: 'switched', label };
        }
        await sleep(100);
      }
      const result = failure('selection-unverified', { modelKind: triggerModelKind });
      closeOpenMenus();
      return result;
    };
    const selectProEffortFromSubmenu = async () => {
      if (TARGET_MODEL_KIND !== 'pro' || (TARGET_LEVEL !== 'standard' && TARGET_LEVEL !== 'extended')) {
        return null;
      }
      const trigger = document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR);
      if (!trigger) {
        return null;
      }
      dispatchHoverSequence(trigger);
      if (trigger.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(trigger);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const menu = findVisibleProEffortMenu(trigger);
        if (menu) {
          return selectAndVerify(trigger, () => {
            const currentMenu = findVisibleProEffortMenu(trigger);
            return currentMenu ? findProEffortOptionInMenu(currentMenu) : null;
          });
        }
        await sleep(100);
      }
      return null;
    };

    // Current ChatGPT exposes a standalone Pro or Thinking composer pill whose
    // controlled menu contains the effort levels. Prefer this ownership boundary
    // before probing older model-picker layouts.
    const COMPOSER_EFFORT_PILL_SELECTORS = [
      'form button.__composer-pill',
      '[data-testid="composer-footer-actions"] button.__composer-pill',
      '.__composer-pill-composite button.__composer-pill',
    ];
    const findComposerEffortPill = () => {
      const seen = new Set();
      for (const selector of COMPOSER_EFFORT_PILL_SELECTORS) {
        for (const button of document.querySelectorAll(selector)) {
          if (seen.has(button) || !isVisible(button)) continue;
          seen.add(button);
          if (button.getAttribute?.('data-testid') === 'model-switcher-dropdown-button') continue;
          const label = normalize(
            (button.getAttribute?.('aria-label') ?? '') + ' ' +
            (button.getAttribute?.('data-testid') ?? '') + ' ' +
            (button.textContent ?? ''),
          );
          if (
            (TARGET_MODEL_KIND === 'pro' && hasToken(label, 'pro') && !hasToken(label, 'thinking')) ||
            (TARGET_MODEL_KIND === 'thinking' && hasToken(label, 'thinking') && !hasToken(label, 'pro')) ||
            (!TARGET_MODEL_KIND && hasToken(label, 'thinking')) ||
            (button.matches?.('button.__composer-pill') && matchesAnyEffortLevel(label))
          ) {
            return button;
          }
        }
      }
      return null;
    };

    const composerEffortPill = findComposerEffortPill();
    if (composerEffortPill) {
      const composerModelKind = TARGET_MODEL_KIND || modelKindFromNode(composerEffortPill);
      if (composerEffortPill.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(composerEffortPill);
        await sleep(INITIAL_WAIT_MS);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const menu = findVisibleEffortMenu(composerEffortPill);
        if (menu) {
          const proEffortResult = await selectProEffortFromSubmenu();
          if (proEffortResult) {
            return proEffortResult;
          }
          return selectAndVerify(
            composerEffortPill,
            () => {
              const currentMenu = findVisibleEffortMenu(composerEffortPill);
              return currentMenu ? findOptionInMenu(currentMenu, composerModelKind) : null;
            },
            composerModelKind,
          );
        }
        await sleep(100);
      }
      const result = failure('menu-not-found', {
        modelKind: composerModelKind,
      });
      closeOpenMenus();
      return result;
    }

    // Older ChatGPT layouts attach effort controls to rows inside the model
    // picker. Keep these compatibility paths after the standalone pill owner.
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
    const pickSingleStableTrailing = (trailings) => {
      const visible = trailings.filter((trailing) => isVisible(trailing));
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
      return failure('chip-not-found');
    }
    // Open model menu (idempotent — leaves it open if already open).
    if (modelBtn.getAttribute('aria-expanded') !== 'true') {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
    }

    // ---------- COMPATIBILITY UI: unified "Intelligence" effort picker ----------
    // One observed ChatGPT layout replaced the per-model trailing buttons with a single
    // "Intelligence" menu ([data-testid="composer-intelligence-picker-content"]),
    // whose role="menuitemradio" rows are the effort tiers. We verify the checked
    // radio instead of trusting the composer-pill label; non-Pro targets also
    // explicitly skip Pro rows before matching effort labels.
    if (TARGET_MODEL_KIND === 'pro' && TARGET_LEVEL === 'extended') {
      const matchesProExtended = (node) => {
        const text = normalize(
          (node?.textContent ?? '') + ' ' + (node?.getAttribute?.('aria-label') ?? ''),
        );
        return text.includes('pro') && text.includes('extended');
      };
      const findProExtendedOption = () => {
        const menu = document.querySelector(INTELLIGENCE_MENU_SELECTOR);
        if (!isVisible(menu)) return null;
        for (const item of menu.querySelectorAll(
          '[role="menuitemradio"], [role="menuitem"], [role="option"]',
        )) {
          if (matchesProExtended(item)) return item;
        }
        return null;
      };
      let proExtended = null;
      const intelligenceDeadline = performance.now() + INTELLIGENCE_WAIT_MS;
      while (performance.now() < intelligenceDeadline) {
        proExtended = findProExtendedOption();
        if (proExtended) break;
        await sleep(100);
      }
      if (proExtended) {
        return selectAndVerify(modelBtn, findProExtendedOption);
      }
      // Intelligence menu absent (older UI) or its Pro Extended row is missing:
      // fall through to the legacy trailing-button path below.
    }

    let trailing = null;
    const trailingDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < trailingDeadline) {
      trailing = pickTrailingForCurrentModel();
      if (trailing) break;
      await sleep(100);
    }
    if (!trailing) {
      const result = failure('chip-not-found');
      closeOpenMenus();
      return result;
    }
    if (trailing.kindNotFound) {
      const result = failure('model-kind-not-found', { modelKind: TARGET_MODEL_KIND });
      closeOpenMenus();
      return result;
    }

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    // Resolve the effort submenu via aria-controls when ChatGPT exposes it,
    // otherwise fall back to scanning newly opened menus for our level tokens.
    const resolveEffortMenu = () => {
      const id = trailing.getAttribute('aria-controls');
      if (id) {
        const node = document.getElementById?.(id);
        if (isEffortMenu(node)) return node;
      }
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR);
      let best = null;
      for (const menu of menus) {
        if (menu === modelBtn || menu.contains(trailing)) continue;
        if (!isVisible(menu)) continue;
        const hits = countEffortLevels(menu);
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
      const result = failure('menu-not-found');
      closeOpenMenus();
      return result;
    }

    return selectAndVerify(trailing, () => {
      const currentMenu = resolveEffortMenu();
      return currentMenu ? findOptionInMenu(currentMenu) : null;
    });
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
