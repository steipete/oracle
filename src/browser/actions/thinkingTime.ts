import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

// Snapshot of the model-picker / thinking-effort subtree, captured at the moment
// detection fails so a chip-not-found can be diagnosed without re-running with
// --verbose. Loosely typed: the shape is whatever the injected probe returns.
type ThinkingTimePickerDiagnostic = Record<string, unknown>;

type ThinkingTimeOutcome = (
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | {
      status: "option-disabled";
      label?: string | null;
      notice?: string | null;
      diagnostic?: ThinkingTimePickerDiagnostic;
    }
  | { status: "chip-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "menu-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "option-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "selection-unverified"; diagnostic?: ThinkingTimePickerDiagnostic }
  | {
      status: "model-kind-not-found";
      diagnostic?: ThinkingTimePickerDiagnostic;
    }
) & { modelKind?: string | null };

export class ThinkingTierUnavailableError extends BrowserAutomationError {
  readonly requestedLevel: string;
  readonly requestedLabel: string;
  readonly optionLabel: string | null;
  readonly notice: string | null;
  readonly confirmedTarget: string;

  constructor(
    requestedLevel: string,
    requestedLabel: string,
    optionLabel: string | null,
    notice: string | null,
    confirmedTarget: string,
  ) {
    const message = `Thinking time: ${optionLabel ?? requestedLabel} is unavailable on this account (${notice ?? "no reason given"}); refusing to submit without confirmed ${confirmedTarget}.`;
    super(message, {
      stage: "thinking-tier-unavailable",
      requestedLevel,
      requestedLabel,
      optionLabel,
      notice,
      confirmedTarget,
    });
    this.name = "ThinkingTierUnavailableError";
    this.requestedLevel = requestedLevel;
    this.requestedLabel = requestedLabel;
    this.optionLabel = optionLabel;
    this.notice = notice;
    this.confirmedTarget = confirmedTarget;
  }
}

function confirmedThinkingTarget(
  level: ThinkingTimeLevel,
  capitalizedLevel: string,
  targetModelKind: "pro" | "thinking" | "instant" | null,
  observedModelKind: string | null | undefined,
): string {
  const strictModelKind = targetModelKind ?? observedModelKind;
  return level === "pro" ? "Pro" : strictModelKind === "pro" ? "Pro Extended" : capitalizedLevel;
}

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
  // Pro is expensive and rate-limited, so a Pro request must never degrade quietly
  // into a cheaper tier. Requesting it explicitly (level "pro") fails closed on its
  // own, independently of the legacy Pro-model + "extended" combination.
  const strictProEffort =
    level === "pro" ||
    ((targetModelKind === "pro" || observedModelKind === "pro") && level === "extended");

  switch (result?.status) {
    case "already-selected":
      logger(formatBrowserThinkingLog(`${result.label ?? capitalizedLevel} (already selected)`));
      return;
    case "switched":
      logger(formatBrowserThinkingLog(result.label ?? capitalizedLevel));
      return;
    case "option-disabled": {
      await logDomFailure(Runtime, logger, "thinking-option-disabled");
      logPickerDiagnostic(result, logger);
      if (strictProEffort) {
        throw new ThinkingTierUnavailableError(
          level,
          capitalizedLevel,
          result.label ?? null,
          result.notice ?? null,
          confirmedThinkingTarget(level, capitalizedLevel, targetModelKind, observedModelKind),
        );
      }
      // A non-strict caller goes on to submit, so this log must not borrow the
      // strict error's "refusing to submit" wording: the request really is sent,
      // at whatever effort ChatGPT already had selected.
      logger(
        formatBrowserThinkingLog(
          `${result.label ?? capitalizedLevel} is unavailable on this account (${result.notice ?? "no reason given"}); keeping the effort already selected in ChatGPT.`,
        ),
      );
      return;
    }
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
        const target = level === "pro" ? "Pro" : "Pro Extended";
        throw new Error(`${message}; refusing to submit without confirmed ${target}.`);
      }
      // "selection-unverified" is the one status here that already dispatched a
      // click, so the effort may or may not have moved. Every other status left
      // the tab on whatever effort it had — which is not necessarily the default.
      const outcome =
        result.status === "selection-unverified"
          ? "the effort in ChatGPT is unconfirmed"
          : "keeping the effort already selected in ChatGPT";
      logger(formatBrowserThinkingLog(`${message}; ${outcome}.`));
      return;
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      logPickerDiagnostic(result, logger);
      if (strictProEffort) {
        const target = level === "pro" ? "Pro" : "Pro Extended";
        throw new Error(
          `Thinking time: unknown outcome selecting ${capitalizedLevel}; refusing to submit without confirmed ${target}.`,
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
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', 'extra-high', 'pro', or 'heavy'
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
      case "option-disabled":
        logger(
          formatBrowserThinkingLog(
            `${result.label ?? capitalizedLevel} is unavailable on this account (${result.notice ?? "no reason given"}); keeping the effort already selected in ChatGPT.`,
          ),
        );
        return false;
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
  const targetIsGpt56ModelLiteral = JSON.stringify(
    /(?:^|[^0-9])5[._ -]6(?:[^0-9]|$)/i.test(desiredModel ?? ""),
  );

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const TARGET_MODEL_KIND = ${targetModelKindLiteral};
    const TARGET_IS_GPT56_MODEL = ${targetIsGpt56ModelLiteral};

    // Multilingual matchers: English level token + observed localized variants.
    const LEVEL_TOKENS = {
      light: ['light', 'instant', 'sofort', 'leicht', '最速', '轻', '极速', '즉시'],
      standard: ['standard', 'medium', 'mittel', '中程度', '标准', '中', '중간'],
      extended: ['extended', 'high', 'hoch', 'erweitert', '高い', '扩展', '深度', '加强', '高', '높음'],
      'extra-high': ['extra high', 'sehr hoch', '非常に高い', '极高', '매우 높음'],
      heavy: ['heavy', 'schwer', '重度', '加重'],
    };
    // Pro is a tier you can request, but it is also a MODEL name, so it must never
    // be used to decide whether a control or a menu is an effort owner: a model pill
    // reading "Pro" would be claimed as the effort pill, and a model menu listing
    // "Instant"/"Pro" would look like a tier list. Keep it to target matching only.
    const TARGET_LEVEL_TOKENS = { ...LEVEL_TOKENS, pro: ['pro'] };
    const targetTokens = TARGET_LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;
    // The "Intelligence" menu renders right after opening the composer pill, so
    // a short probe is enough; if it's absent this is an older UI and we fall
    // back to the legacy paths without paying the full MAX_WAIT_MS.
    const INTELLIGENCE_WAIT_MS = 2500;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Keep CJK characters, including Japanese kana and Hangul, so labels survive
    // normalization before being matched against LEVEL_TOKENS and picker controls.
    const normalize = (value) => (value || '')
      // Compose first so NFD umlauts fold too, then map them onto ASCII before
      // the strip below would drop them (and split the token in half).
      .normalize('NFC')
      .toLowerCase()
      .replace(/ä/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/ü/g, 'u')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9\\u3040-\\u30ff\\u4e00-\\u9fff\\uac00-\\ud7af]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const hasToken = (text, token) => normalize(text).split(' ').includes(token);
    // Whole-word/phrase containment. Latin effort labels are short words that also
    // occur inside unrelated UI text ("Hochladen", "Ermitteln") and inside their own
    // row descriptions ("Hoch – für sehr komplexe Aufgaben"), so plain substring
    // matching misclassifies rows. CJK labels have no word separators, so they keep
    // substring semantics.
    const hasPhrase = (text, phrase) => {
      const haystack = ' ' + normalize(text) + ' ';
      const needle = normalize(phrase);
      if (!needle) return false;
      return /^[a-z0-9 ]+$/.test(needle)
        ? haystack.includes(' ' + needle + ' ')
        : haystack.includes(needle);
    };
    // ChatGPT's Pro effort tiers are "Pro Extended"/"Pro Erweitert" per UI language.
    const hasExtendedWord = (text) => hasPhrase(text, 'extended') || hasPhrase(text, 'erweitert');
    const matchesTokens = (text, tokens) => {
      const t = normalize(text);
      if (!t) return false;
      return tokens.some((tok) => {
        const token = normalize(tok);
        if (!token) return false;
        if (token === 'high') return hasPhrase(t, 'high') && !hasPhrase(t, 'extra high');
        if (token === 'extra high') return hasPhrase(t, 'extra high');
        if (token === 'hoch') return hasPhrase(t, 'hoch') && !hasPhrase(t, 'sehr hoch');
        if (token === 'sehr hoch') return hasPhrase(t, 'sehr hoch');
        if (token === '높음') return hasPhrase(t, '높음') && !hasPhrase(t, '매우 높음');
        if (token === '매우 높음') return hasPhrase(t, '매우 높음');
        if (token === '高い' || token === '非常に高い') {
          return t === token || hasToken(t, token);
        }
        if (token === '极速') {
          const suffix = t.slice(token.length);
          return t === token || hasToken(t, token) || /^[0-9]/.test(suffix);
        }
        if (['中', '高', '极高'].includes(token)) {
          return t === token || hasToken(t, token);
        }
        if (/^[a-z0-9 ]+$/.test(token)) {
          return hasPhrase(t, token);
        }
        return t === token || hasToken(t, token) || t.includes(token);
      });
    };
    const matchesLevel = (text) => matchesTokens(text, targetTokens);
    const matchesAnyEffortLevel = (text) =>
      Object.values(LEVEL_TOKENS).some((tokens) => matchesTokens(text, tokens));
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
    const isOptionDisabled = (node) => {
      if (!node || typeof node.getAttribute !== 'function') return false;
      // data-disabled is Radix's valueless-presence convention, but an explicit
      // "false" must not read as disabled: that would refuse a perfectly usable
      // tier and report it as unavailable.
      const dataDisabled = node.getAttribute('data-disabled');
      const dataDisabledOn = dataDisabled !== null && String(dataDisabled).toLowerCase() !== 'false';
      return (
        node.getAttribute('aria-disabled') === 'true' ||
        dataDisabledOn ||
        (node.getAttribute('data-state') || '').toLowerCase() === 'disabled' ||
        Boolean(node.disabled) ||
        node.getAttribute('disabled') !== null
      );
    };
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
        ariaDisabled: el.getAttribute('aria-disabled'),
        dataDisabled: el.getAttribute('data-disabled'),
        dataState: el.getAttribute('data-state'),
        disabled: isOptionDisabled(el),
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
      if (menu?.querySelector?.(INTELLIGENCE_MENU_SELECTOR)) {
        return true;
      }
      const label = menu?.querySelector?.('.__menu-label, [class*="menu-label"]');
      // 'intelligen' matches both "Intelligence" and German "Intelligenz".
      return normalize(label?.textContent ?? '').includes('intelligen');
    };
    const failure = (status, extra = {}) => ({
      status,
      modelKind: effectiveTargetModelKind(),
      ...extra,
      diagnostic: collectPickerDiagnostic(),
    });
    const findOptionInMenu = (menu, modelKindOverride = null) => {
      // Container controls reveal other controls; they are not tiers you can pick.
      // Two shapes exist and both can collide with a tier label: a submenu opener
      // ("ModelGPT-5.6 Pro" would satisfy a Pro request) and a disclosure toggle
      // (German "Erweitert" is literally one of the extended tokens, so the
      // Advanced toggle would satisfy an extended request and be clicked in place
      // of the tier). Detect them structurally rather than by label: a real tier row
      // carries a checked state, while a container carries expansion state.
      const isContainerControl = (node) =>
        node?.getAttribute?.('aria-haspopup') === 'menu' ||
        (node?.getAttribute?.('aria-expanded') !== null &&
          node?.getAttribute?.('aria-checked') === null);
      const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR)).filter(
        (item) => !isContainerControl(item),
      );
      const modelKind = modelKindOverride || effectiveTargetModelKind();
      if (modelKind === 'pro') {
        // GPT-5.6's unified Intelligence picker exposes Pro as the highest
        // effort radio directly. It no longer has a nested "Pro Extended"
        // row, so preserve the legacy request semantics by selecting Pro.
        if (
          TARGET_LEVEL === 'extended' &&
          isIntelligenceEffortMenu(menu) &&
          !document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR)
        ) {
          for (const item of items) {
            const itemText = normalize(
              (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
            );
            if (itemText === 'pro') return item;
          }
        }
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
      // Generic effort-label match for every model/level. GPT-5.6 heavy used to
      // short-circuit to the Pro row before reaching here; it no longer does, so
      // a UI without a matching tier (e.g. German, which has no "heavy") falls
      // through to null and the caller keeps the current selection.
      for (const item of items) {
        const itemText = normalize(
          (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
        );
        // Pro rows are skipped for non-Pro targets so "High" never resolves to
        // "Pro". Two things lift this: an explicit TARGET_LEVEL of 'pro', and a
        // legacy Pro-model menu (modelKind === 'pro'), whose rows are all Pro
        // variants so excluding them would leave nothing to match.
        if (TARGET_LEVEL !== 'pro' && modelKind !== 'pro' && hasToken(itemText, 'pro')) {
          continue;
        }
        if (
          matchesLevel(item.textContent ?? '') ||
          matchesLevel(item.getAttribute?.('aria-label') ?? '')
        ) {
          return item;
        }
      }
      if (TARGET_LEVEL === 'extra-high') {
        // Older Chinese layouts used bare 高 for the highest non-Pro effort.
        // Keep it only as a second-pass exact fallback so a current 高 row can
        // never win before the primary 极高 row.
        for (const item of items) {
          const itemText = normalize(item.textContent ?? '');
          const ariaLabel = normalize(item.getAttribute?.('aria-label') ?? '');
          if (itemText === '高' || ariaLabel === '高') return item;
        }
      }
      return null;
    };
    // Menu-shape heuristic only. This reads the whole menu's textContent, where
    // adjacent row labels concatenate without a separator ("Pro StandardPro
    // Extended"), so word-boundary matching does not apply here — substring is
    // deliberate. Row-level classification uses matchesLevel/matchesTokens.
    const countEffortLevels = (menu) => {
      const text = normalize(menu?.textContent ?? '');
      let hits = 0;
      for (const tokens of Object.values(LEVEL_TOKENS)) {
        if (tokens.some((token) => text.includes(normalize(token)))) hits += 1;
      }
      return hits;
    };
    const isEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      if (menu.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') return true;
      if (menu.querySelector?.(INTELLIGENCE_MENU_SELECTOR)) return true;
      const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
      const labelText = normalize(label?.textContent ?? '');
      return (
        labelText.includes('intelligen') ||
        labelText.includes('thinking time') ||
        labelText.includes('thinking effort') ||
        labelText.includes('denkdauer') ||
        labelText.includes('denkzeit') ||
        countEffortLevels(menu) >= 2
      );
    };
    const isProEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      const text = normalize(menu?.textContent ?? '');
      // Aggregate menu text, so plain substring only (see countEffortLevels).
      return (
        text.includes('pro standard') &&
        (text.includes('pro extended') || text.includes('pro erweitert'))
      );
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
        return hasPhrase(text, 'pro') && hasPhrase(text, 'standard');
      }
      if (TARGET_LEVEL === 'extended') {
        return hasPhrase(text, 'pro') && hasExtendedWord(text);
      }
      return false;
    };
    const findProEffortOptionInMenu = (menu) => {
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (matchesProEffortLevel(item)) return item;
      }
      return null;
    };
    const freshComposerTrigger = (trigger) => {
      if (!trigger?.matches?.('button.__composer-pill')) return null;
      // React can replace the composer pill after an effort click. Keep using
      // the captured node while it is live, but re-query once it is detached so
      // verification does not read its stale pre-click label.
      if (trigger.isConnected !== false) return trigger;
      return findComposerEffortPill() || findModelButton() || trigger;
    };
    const currentProEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      const button = freshComposerTrigger(trigger) || findModelButton();
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) !== 'pro') {
        return false;
      }
      const label = normalize(button?.textContent ?? '');
      if (TARGET_LEVEL === 'standard') {
        return hasToken(label, 'pro') && !hasExtendedWord(label);
      }
      if (TARGET_LEVEL === 'extended') {
        return hasToken(label, 'pro') && hasExtendedWord(label);
      }
      return false;
    };
    const currentEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      if (currentProEffortPillMatchesTarget(trigger, modelKindOverride)) return true;
      const button = freshComposerTrigger(trigger) || findModelButton();
      const normalizedLabel = normalize(
        (button?.textContent ?? '') + ' ' + (button?.getAttribute?.('aria-label') ?? ''),
      );
      // No 5.6-heavy "a Pro pill counts as heavy" shortcut here: that would also
      // make post-click verification pass on an unchanged Pro pill. selectAndVerify
      // handles the already-on-Pro case explicitly before any click.
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) === 'pro') {
        return false;
      }
      return matchesLevel(normalizedLabel);
    };
    const nonEmptyNotice = (value) => {
      const text = redactDiagnosticText(value, 160);
      return text || null;
    };
    // The notice must be ROW-OWNED, and preferably this hover's own.
    //
    // NOTE: no backticks in this comment — it lives inside the injected template
    // literal, where a backtick would terminate the string.
    //
    // A document-wide role=tooltip scan is what this must never become: novelty is
    // not causality, and an unrelated control with an armed open-delay can mount its
    // tooltip inside this hover's window. Every pass below is anchored on the row.
    //
    // Preference order, strongest provenance first:
    //   1. an id this hover ADDED whose target is role=tooltip — Radix keeps an
    //      application-supplied description and APPENDS its tooltip id when opening,
    //      so the delta is what separates the real notice from a permanent blurb;
    //   2. any other id this hover added;
    //   3. an already-associated role=tooltip target, for a tooltip that was open
    //      before the probe arrived;
    //   4. the row's static title, only once the poll has expired.
    //
    // Passes 3 and 4 are row-owned but NOT causal: a page that permanently points a
    // disabled row at generic role=tooltip help, or gives it a generic title, will
    // have that text reported. That is accepted deliberately — the value is an opaque
    // notice for a human or a caller to interpret, not a parsed reset time — and the
    // verified live target has neither at rest.
    const describedIds = (option) =>
      (option?.getAttribute?.('aria-describedby') || '').split(/\\s+/).filter(Boolean);
    const isTooltipNode = (node) => node?.getAttribute?.('role') === 'tooltip';
    const readDisabledNotice = (option, priorIds, allowTitle) => {
      const ids = describedIds(option);
      const prior = priorIds instanceof Set ? priorIds : new Set();
      const fresh = ids.filter((id) => !prior.has(id));
      for (const pass of [
        fresh.filter((id) => isTooltipNode(document.getElementById?.(id))),
        fresh,
        ids.filter((id) => isTooltipNode(document.getElementById?.(id))),
      ]) {
        for (const id of pass) {
          const notice = nonEmptyNotice(document.getElementById?.(id)?.textContent);
          if (notice) return notice;
        }
      }
      if (!allowTitle) return null;
      return nonEmptyNotice(option?.getAttribute?.('title'));
    };
    const waitForDisabledNotice = async (option, priorIds) => {
      const deadline = performance.now() + 400;
      while (performance.now() < deadline) {
        const notice = readDisabledNotice(option, priorIds, false);
        if (notice) return notice;
        await sleep(50);
      }
      // Only now may a static title speak: the association had its full window.
      return readDisabledNotice(option, priorIds, true);
    };
    // Opening a tooltip stacks another Radix dismissable layer over the menu, and
    // the topmost layer eats the Escape. One blind Escape therefore leaves the
    // effort menu open, which matters for the non-strict caller that goes on to
    // submit. Dismiss, let the layer unmount, and only Escape again while a menu is
    // still there — never two unconditional Escapes, which could close an unrelated
    // outer surface.
    const closeMenusAfterTooltip = async () => {
      closeOpenMenus();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(50);
        if (!Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).some(isVisible)) return;
        closeOpenMenus();
      }
    };
    const selectAndVerify = async (trigger, findOption, modelKindOverride = null) => {
      const triggerModelKind =
        modelKindOverride ||
        TARGET_MODEL_KIND ||
        modelKindFromNode(trigger) ||
        effectiveTargetModelKind();
      const option = findOption();
      if (!option && TARGET_IS_GPT56_MODEL && TARGET_LEVEL === 'heavy') {
        // GPT-5.6 has no "heavy" tier: Pro is the closest thing. Accept a pill that
        // is already on Pro as satisfying the request, but never click Pro to get
        // there, and never let this stand in for post-click verification.
        const pill = freshComposerTrigger(trigger) || findModelButton();
        const pillLabel = normalize(
          (pill?.textContent ?? '') + ' ' + (pill?.getAttribute?.('aria-label') ?? ''),
        );
        if (
          hasToken(pillLabel, 'pro') ||
          currentEffortPillMatchesTarget(trigger, triggerModelKind)
        ) {
          closeOpenMenus();
          return { status: 'already-selected', label: trigger.textContent?.trim?.() || null };
        }
      }
      if (!option) return failure('option-not-found', { modelKind: triggerModelKind });
      const label = option.textContent?.trim?.() || null;
      if (isOptionDisabled(option)) {
        // Captured BEFORE the hover: the ids already here describe the row for other
        // reasons and cannot be this hover's reason.
        const priorIds = new Set(describedIds(option));
        dispatchHoverSequence(option);
        const notice = await waitForDisabledNotice(option, priorIds);
        const result = failure('option-disabled', {
          // The label is page text that reaches logs and diagnostics, so it is
          // redacted like every other reported string.
          label: redactDiagnosticText(option.textContent, 80) || null,
          notice,
          modelKind: triggerModelKind,
        });
        await closeMenusAfterTooltip();
        return result;
      }
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

      const reopenTrigger = freshComposerTrigger(trigger) || trigger;
      if (!refreshed && reopenTrigger?.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(reopenTrigger);
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

    // ---------- Unified Intelligence picker: Advanced -> Effort submenu ----------
    // A newer ChatGPT layout replaces the flat effort rows with a "power" slider
    // (simple view) plus an "Advanced" view holding two submenu openers: Model and
    // Effort. The tier rows only exist inside the Effort submenu, so the flat scan
    // of the top-level menu finds nothing and we must expand and descend.
    const ADVANCED_VIEW_SELECTOR = '[data-testid="composer-model-picker-slider-advanced-view"]';
    const SUBMENU_OPENER_SELECTOR = '[role="menuitem"][aria-haspopup="menu"]';
    const nodeLabel = (node) =>
      normalize((node?.getAttribute?.('aria-label') ?? '') + ' ' + (node?.textContent ?? ''));
    // Row labels in this menu concatenate without separators ("EffortHigh"), so
    // token matching cannot be used here — substring is deliberate, as in
    // countEffortLevels above.
    const ADVANCED_WORDS = [
      'advanced', 'erweitert', '高级', '詳細設定', '詳細表示', '고급',
      'avanzado', 'avancado', 'avance',
    ];
    const EFFORT_WORDS = [
      'effort', 'aufwand', '强度', '努力', '推論レベル', '思考量', '추론 수준',
      'esfuerzo', 'esforco', 'sforzo', 'inspanning', 'wysilek',
    ];
    const containsAny = (label, words) => words.some((word) => label.includes(word));
    const findAdvancedToggle = (menu) => {
      for (const item of (menu || document).querySelectorAll('[role="menuitem"]')) {
        if (!isVisible(item)) continue;
        if (containsAny(nodeLabel(item), ADVANCED_WORDS)) return item;
      }
      return null;
    };
    // Verify the shape rather than trusting the selector: a tier row must never be
    // mistaken for the opener, or hovering it would silently change the effort.
    const isSubmenuOpener = (node) =>
      node?.getAttribute?.('aria-haspopup') === 'menu' &&
      (node?.getAttribute?.('role') ?? '') === 'menuitem';
    // The Effort opener's label is the word "Effort" plus the tier it currently sits
    // on ("EffortHigh"). Positive identification only: the sibling Model opener has
    // the identical shape and can read "ModelGPT-5.6 Pro", so guessing from tier
    // words would pick it and then click model rows as if they were efforts. An
    // unrecognised language yields no opener, and the caller fails instead of
    // gambling on the wrong control.
    const findEffortSubmenuOpener = (menu) => {
      const scope = menu?.querySelector?.(ADVANCED_VIEW_SELECTOR) || menu || document;
      for (const item of scope.querySelectorAll(SUBMENU_OPENER_SELECTOR)) {
        if (!isVisible(item) || !isSubmenuOpener(item)) continue;
        if (containsAny(nodeLabel(item), EFFORT_WORDS)) return item;
      }
      return null;
    };
    // countEffortLevels reads aggregate menu text, where one "Extra High" row scores
    // twice (once as "high", once as "extra high"). Count distinct levels across
    // distinct rows instead, so ">= 2" really means two selectable tiers.
    const countDistinctTierRows = (menu) => {
      if (!menu) return 0;
      const matched = new Set();
      for (const row of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (isSubmenuOpener(row)) continue;
        const text = nodeLabel(row);
        for (const [level, tokens] of Object.entries(LEVEL_TOKENS)) {
          if (matchesTokens(text, tokens)) matched.add(level);
        }
      }
      return matched.size;
    };
    const resolveSubmenuFor = (opener, parentMenu) => {
      const id = opener?.getAttribute?.('aria-controls');
      if (id) {
        const node = document.getElementById?.(id);
        if (isVisible(node) && countDistinctTierRows(node) >= 2) return node;
      }
      let best = null;
      for (const menu of document.querySelectorAll(MENU_CONTAINER_SELECTOR)) {
        if (menu === parentMenu || menu.contains?.(opener) || !isVisible(menu)) continue;
        const hits = countDistinctTierRows(menu);
        if (hits >= 2 && (!best || hits > best.hits)) best = { menu, hits };
      }
      return best?.menu ?? null;
    };
    const selectEffortFromAdvancedSubmenu = async (parentMenu, modelKindOverride = null) => {
      if (!parentMenu) return null;
      // React can mount the advanced view well after the click under load, so poll
      // for the opener to the same deadline the submenu gets instead of assuming it
      // rendered within one STEP_WAIT_MS. Re-expand if the toggle collapses again.
      let opener = null;
      const openerDeadline = performance.now() + MAX_WAIT_MS;
      while (!opener && performance.now() < openerDeadline) {
        const toggle = findAdvancedToggle(parentMenu);
        if (toggle && toggle.getAttribute?.('aria-expanded') === 'false') {
          dispatchClickSequence(toggle);
          await sleep(STEP_WAIT_MS);
        }
        opener = findEffortSubmenuOpener(parentMenu);
        if (opener) break;
        await sleep(100);
      }
      if (!opener) return null;
      dispatchHoverSequence(opener);
      if (opener.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(opener);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const submenu = resolveSubmenuFor(opener, parentMenu);
        if (submenu) {
          return selectAndVerify(
            opener,
            () => {
              const current = resolveSubmenuFor(opener, parentMenu);
              return current ? findOptionInMenu(current, modelKindOverride) : null;
            },
            modelKindOverride,
          );
        }
        await sleep(100);
      }
      return null;
    };

    // The direct-slider rollout removes the Effort submenu entirely. Its keyboard
    // owner announces the actual tier via aria-describedby; neither the pill nor
    // the slider's maximum position alone proves that Pro was selected.
    const selectDirectEffortSlider = async (menu) => {
      const view = menu.querySelector?.('[data-model-selection-view="true"]');
      const simple = view?.querySelector?.('[data-testid="composer-model-picker-slider-simple-view"]');
      if (!simple || simple.getAttribute('data-active') !== 'true' || !isVisible(simple)) return null;
      const resolve = () => {
        const currentView = menu.querySelector?.('[data-model-selection-view="true"]');
        const currentSimple = currentView?.querySelector?.('[data-testid="composer-model-picker-slider-simple-view"]');
        if (currentSimple?.getAttribute('data-active') !== 'true') return null;
        const slider = currentSimple.querySelector('[data-model-reasoning-effort-slider]');
        const control = slider?.closest?.('[role="menuitem"]');
        const thumb = slider?.querySelector?.('[role="slider"]');
        if (!control || !thumb || !isVisible(control)) return null;
        const levels = ['light', 'standard', 'extended', 'extra-high', 'pro'];
        // The selected label leads localized aria-describedby prose, while punctuation
        // and ordinal grammar vary by locale. Match only that leading label and let
        // the thumb's numeric ARIA state independently prove its position.
        const readLeadingLevel = (description) => {
          const value = (description ?? '').normalize('NFC').trim();
          if (!value) return null;
          const matches = levels.flatMap((level, index) => {
            const token = [...TARGET_LEVEL_TOKENS[level]]
              .sort((left, right) => right.length - left.length)
              .find((candidate) => {
                const normalizedCandidate = candidate.normalize('NFC');
                const prefix = value.slice(0, normalizedCandidate.length);
                if (normalize(prefix) !== normalize(normalizedCandidate)) return false;
                const next = normalize(value.slice(prefix.length, prefix.length + 1));
                return !next;
              });
            return token
              ? [{ level, index, label: value.slice(0, token.normalize('NFC').length) }]
              : [];
          });
          return matches.length === 1 ? matches[0] : null;
        };
        const selections = describedIds(control)
          .map((id) => readLeadingLevel(document.getElementById?.(id)?.textContent ?? ''))
          .filter(Boolean);
        if (selections.length !== 1) return null;
        const { label, index, level } = selections[0];
        // This adapter owns the observed five-tier layout only. A different range
        // or contradictory announcement must not turn a numeric guess into proof.
        if (thumb.getAttribute('aria-valuemin') !== '0' || thumb.getAttribute('aria-valuemax') !== '4' ||
            thumb.getAttribute('aria-valuenow') !== String(index)) return null;
        return { control, label, index, level };
      };
      let current = resolve();
      const finish = (result) => { closeOpenMenus(); return result; };
      if (!current) return finish(failure('selection-unverified'));
      // Preserve the legacy Pro-model + extended contract on unified pickers.
      const target = TARGET_MODEL_KIND === 'pro' && TARGET_LEVEL === 'extended' ? 'pro' : TARGET_LEVEL;
      const targetIndex = ['light', 'standard', 'extended', 'extra-high', 'pro'].indexOf(target);
      if (targetIndex < 0) {
        if (TARGET_IS_GPT56_MODEL && TARGET_LEVEL === 'heavy' && current.level === 'pro') {
          return finish({ status: 'already-selected', label: current.label });
        }
        return finish(failure('option-not-found'));
      }
      if (current.level === target) return finish({ status: 'already-selected', label: current.label });
      const deadline = performance.now() + MAX_WAIT_MS;
      for (let attempt = 0; attempt < 4 && performance.now() < deadline; attempt += 1) {
        if (isOptionDisabled(current.control)) return finish(failure('option-disabled', { label: current.label }));
        const previousIndex = current.index;
        const key = targetIndex > previousIndex ? 'ArrowRight' : 'ArrowLeft';
        current.control.focus?.();
        current.control.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        current = null;
        while (performance.now() < deadline) {
          await sleep(100);
          const next = resolve();
          if (next && next.index !== previousIndex) { current = next; break; }
        }
        if (!current) return finish(failure('selection-unverified'));
        if (current.level === target) return finish({ status: 'switched', label: current.label });
      }
      return finish(failure('selection-unverified'));
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
      let gpt56Fallback = null;
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
          if (
            TARGET_IS_GPT56_MODEL &&
            button.matches?.('button.__composer-pill') &&
            normalize(button.textContent ?? '') === 'pro'
          ) {
            gpt56Fallback ||= button;
          }
        }
      }
      return gpt56Fallback;
    };
    let composerEffortPill = findComposerEffortPill();
    let modelBtn = findModelButton();
    const modelKindFromLegacyTrailing = (trailing) => {
      const row = trailing.closest?.(
        '[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]',
      );
      const idText = normalize(
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
      if (!idText.includes('model switcher')) return null;
      const modelPart = normalize(idText.replace(/\\bthinking effort\\b.*$/, ''));
      if (hasToken(modelPart, 'pro')) return 'pro';
      if (hasToken(modelPart, 'thinking')) return 'thinking';
      if (hasToken(modelPart, 'instant')) return 'instant';
      return null;
    };
    const legacyEffortOwnerIsReady = () => {
      if (
        TARGET_MODEL_KIND === 'pro' &&
        TARGET_LEVEL === 'extended' &&
        isVisible(document.querySelector(INTELLIGENCE_MENU_SELECTOR))
      ) {
        return true;
      }
      const expectedKind = TARGET_MODEL_KIND || modelKindFromNode(modelBtn);
      return Boolean(
        expectedKind &&
        findTrailingButtons().some(
          (button) => isVisible(button) && modelKindFromLegacyTrailing(button) === expectedKind,
        ),
      );
    };
    let attemptedModelButton =
      modelBtn?.getAttribute?.('aria-expanded') === 'true' ? modelBtn : null;
    const effortOwnerDeadline = performance.now() + MAX_WAIT_MS;
    while (!composerEffortPill && performance.now() < effortOwnerDeadline) {
      if (
        modelBtn &&
        attemptedModelButton !== modelBtn &&
        modelBtn.getAttribute?.('aria-expanded') !== 'true'
      ) {
        dispatchClickSequence(modelBtn);
        attemptedModelButton = modelBtn;
        await sleep(INITIAL_WAIT_MS);
      }
      if (modelBtn && legacyEffortOwnerIsReady()) break;
      await sleep(100);
      composerEffortPill = findComposerEffortPill();
      modelBtn = findModelButton();
      if (modelBtn?.getAttribute?.('aria-expanded') === 'true') {
        attemptedModelButton = modelBtn;
      }
    }
    if (composerEffortPill) {
      if (attemptedModelButton && attemptedModelButton !== composerEffortPill) closeOpenMenus();
      // In the unified Intelligence picker the composer pill shows the current
      // EFFORT ("Pro", "High"), not the model. Reading a Pro *model* out of it would
      // lift the Pro-row exclusion in findOptionInMenu and let a lower-tier request
      // settle on Pro. Only a pill naming a tier and nothing else qualifies: legacy
      // pills read "Pro Extended" (model + effort) and must keep naming their model,
      // or a Pro Extended user asking for extended would be moved down to High.
      const pillLabel = normalize(
        (composerEffortPill.getAttribute?.('aria-label') ?? '') +
          ' ' +
          (composerEffortPill.textContent ?? ''),
      );
      const pillIsBareEffortTier = Object.values(TARGET_LEVEL_TOKENS).some((tokens) =>
        tokens.some((token) => normalize(token) === pillLabel),
      );
      const pillNamesEffortNotModel =
        TARGET_IS_GPT56_MODEL ||
        (pillIsBareEffortTier && Boolean(document.querySelector(INTELLIGENCE_MENU_SELECTOR)));
      const composerModelKind =
        TARGET_MODEL_KIND ||
        (pillNamesEffortNotModel ? 'versioned' : modelKindFromNode(composerEffortPill));
      if (composerEffortPill.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(composerEffortPill);
        await sleep(INITIAL_WAIT_MS);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const menu = findVisibleEffortMenu(composerEffortPill);
        if (menu) {
          const sliderResult = await selectDirectEffortSlider(menu);
          if (sliderResult) return sliderResult;
          const proEffortResult = await selectProEffortFromSubmenu();
          if (proEffortResult) {
            return proEffortResult;
          }
          // Flat rows win when present; only descend into Advanced -> Effort when
          // this menu has no matching tier of its own (the slider layout).
          if (!findOptionInMenu(menu, composerModelKind)) {
            const advancedResult = await selectEffortFromAdvancedSubmenu(menu, composerModelKind);
            if (advancedResult) {
              return advancedResult;
            }
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
    const modelKindFromTrailing = modelKindFromLegacyTrailing;
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

    const modelButtonDeadline = performance.now() + MAX_WAIT_MS;
    while (!modelBtn && performance.now() < modelButtonDeadline) {
      await sleep(100);
      modelBtn = findModelButton();
    }
    if (!modelBtn) {
      return failure('chip-not-found');
    }
    // Open model menu (idempotent — leaves it open if already open).
    if (
      modelBtn.getAttribute('aria-expanded') !== 'true' &&
      !legacyEffortOwnerIsReady()
    ) {
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
        return hasPhrase(text, 'pro') && hasExtendedWord(text);
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
