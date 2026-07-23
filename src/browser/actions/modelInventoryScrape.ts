// Discovery: read the ChatGPT model picker's *actual* options from the live DOM
// and turn them into a ModelInventory. This is the browser-side counterpart to the
// pure classifier in ../../oracle/modelInventory.ts.
//
// Grounded in a real GPT-5.6 "Sol" era capture (see DOM-FINDINGS.md):
//   - trigger:  button.__composer-pill[aria-haspopup="menu"] (text = current effort)
//   - top menu: [role="menuitemradio"] efforts + one [role="menuitem"][aria-haspopup="menu"]
//               version trigger (text = current version)
//   - submenu:  [role="menuitemradio"] version options
//   - current:  aria-checked="true" / data-state="checked"
//   - NOTE: this UI dropped every data-testid, so selection is role + text + aria only.
//
// The expression is evaluated inside the ChatGPT tab; keep it self-contained.

import {
  buildInventoryFromRawItems,
  type ModelInventory,
  type RawMenuItem,
} from "../../oracle/modelInventory.js";

export const INVENTORY_TRIGGER_SELECTOR =
  '[data-testid="model-switcher-dropdown-button"], button.__composer-pill[aria-haspopup="menu"]';
export const INVENTORY_MENU_SELECTOR = '[role="menu"], [data-radix-collection-root]';
export const INVENTORY_ITEM_SELECTOR =
  '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]';

/** Minimal shape of the CDP Runtime domain we depend on (keeps us decoupled from CRI types). */
export interface RuntimeLike {
  evaluate(params: {
    expression: string;
    awaitPromise?: boolean;
    returnByValue?: boolean;
  }): Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>;
}

/**
 * Build the browser expression that opens the picker (including the version
 * submenu) and returns RawMenuItem[]. Read-only: it opens submenus to read them
 * but never commits a selection, and closes the menu before returning.
 */
export function buildInventoryScrapeExpression(): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const TRIGGER = ${JSON.stringify(INVENTORY_TRIGGER_SELECTOR)};
    const MENU = ${JSON.stringify(INVENTORY_MENU_SELECTOR)};
    const ITEM = ${JSON.stringify(INVENTORY_ITEM_SELECTOR)};

    const fire = (el, type, pointer) => {
      try {
        const common = { bubbles: true, cancelable: true, view: window };
        const ev = pointer && 'PointerEvent' in window
          ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
          : new MouseEvent(type, common);
        el.dispatchEvent(ev);
      } catch (e) {}
    };
    const openClick = (el) => {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { el.focus(); } catch (e) {}
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
        .forEach((t) => fire(el, t, t.startsWith('pointer')));
    };
    const hover = (el) => {
      ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
        .forEach((t) => fire(el, t, t.startsWith('pointer')));
      try { el.focus(); } catch (e) {}
    };
    const menus = () => Array.from(document.querySelectorAll(MENU));
    const collect = (scope) => menus().flatMap((m) =>
      Array.from(m.querySelectorAll(ITEM)).map((n) => ({
        text: (n.textContent || '').replace(/\\s+/g, ' ').trim(),
        role: n.getAttribute('role'),
        ariaChecked: n.getAttribute('aria-checked'),
        ariaHaspopup: n.getAttribute('aria-haspopup'),
        dataState: n.getAttribute('data-state'),
        scope,
      })).filter((x) => x.text),
    );

    // Wait for the composer pill to mount (cold pages take ~1-4s).
    let trigger = document.querySelector(TRIGGER);
    for (let i = 0; i < 40 && !trigger; i++) {
      await sleep(200);
      trigger = document.querySelector(TRIGGER);
    }
    if (!trigger) return { error: 'trigger-not-found', items: [] };

    // Open the top menu and wait for the portal to mount.
    openClick(trigger);
    for (let i = 0; i < 25 && menus().length === 0; i++) {
      if (i === 10) openClick(trigger);
      await sleep(200);
    }
    if (menus().length === 0) return { error: 'menu-did-not-open', items: [] };


    const top = collect('top');

    // Open the version submenu: the item that opens a nested menu AND names a version
    // (a spurious empty aria-haspopup item can precede the real version trigger).
    const menuNodes = menus().flatMap((m) => Array.from(m.querySelectorAll(ITEM)));
    const isVer = (t) => /gpt[-\\s]?\\d|(^|[^a-z])o\\d|\\bsol\\b/i.test(t || '');
    const versionTrigger = menuNodes.find(
      (n) => (n.getAttribute('aria-haspopup') === 'menu' || n.getAttribute('data-has-submenu') !== null) &&
        isVer(n.textContent),
    );
    let submenu = [];
    if (versionTrigger) {
      const before = menus().length;
      hover(versionTrigger);
      openClick(versionTrigger);
      for (let i = 0; i < 20 && menus().length <= before; i++) await sleep(100);
      submenu = collect('submenu');
    }

    // Close the menu (best-effort) so discovery leaves no UI open.
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (e) {}

    // De-dupe: top-menu items also appear once the submenu is open. Prefer scope tags.
    const seen = new Set();
    const items = [...top, ...submenu].filter((it) => {
      const k = it.scope + '|' + it.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { items };
  })()`;
}

/**
 * Read the live model inventory from an open ChatGPT tab.
 * Returns a parsed ModelInventory; throws only on evaluation failure.
 */
export async function enumerateModelInventory(Runtime: RuntimeLike): Promise<ModelInventory> {
  const out = await Runtime.evaluate({
    expression: buildInventoryScrapeExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = (out.result?.value ?? {}) as { items?: RawMenuItem[]; error?: string };
  const items = Array.isArray(value.items) ? value.items : [];
  return buildInventoryFromRawItems(items);
}

/** Exposed for a future live/integration test (kept out of unit coverage). */
export function buildInventoryScrapeExpressionForTest(): string {
  return buildInventoryScrapeExpression();
}

// ── Apply ────────────────────────────────────────────────────────────────────
// Click a specific version and/or effort by their exact live DOM text (as read
// during discovery). Version is a submenu selection; effort is top-level. Either
// may be null (leave that axis on its current value).

export interface ApplyResult {
  ok: boolean;
  error?: string;
  currentVersion?: string | null;
  currentEffort?: string | null;
  actions?: string[];
}

/**
 * Browser expression that applies a version/effort selection by exact text.
 * `targetVersion` / `targetEffort` are the raw DOM texts from the inventory
 * (e.g. "GPT-5.6 Sol", "Pro"), or null to leave that axis unchanged.
 */
export function buildApplySelectionExpression(
  targetVersion: string | null,
  targetEffort: string | null,
): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const TARGET_VERSION = ${JSON.stringify(targetVersion)};
    const TARGET_EFFORT = ${JSON.stringify(targetEffort)};
    const TRIGGER = ${JSON.stringify(INVENTORY_TRIGGER_SELECTOR)};
    const MENU = ${JSON.stringify(INVENTORY_MENU_SELECTOR)};
    const ITEM = ${JSON.stringify(INVENTORY_ITEM_SELECTOR)};

    const fire = (el, type, pointer) => {
      try {
        const common = { bubbles: true, cancelable: true, view: window };
        const ev = pointer && 'PointerEvent' in window
          ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
          : new MouseEvent(type, common);
        el.dispatchEvent(ev);
      } catch (e) {}
    };
    const openClick = (el) => {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { el.focus(); } catch (e) {}
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
        .forEach((t) => fire(el, t, t.startsWith('pointer')));
    };
    const hover = (el) => {
      ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
        .forEach((t) => fire(el, t, t.startsWith('pointer')));
      try { el.focus(); } catch (e) {}
    };
    const menus = () => Array.from(document.querySelectorAll(MENU));
    const items = () => menus().flatMap((m) => Array.from(m.querySelectorAll(ITEM)));
    const trigger = () => document.querySelector(TRIGGER);
    const isChecked = (n) => n.getAttribute('aria-checked') === 'true' || (n.getAttribute('data-state') || '') === 'checked';
    const isVersionText = (t) => /gpt[-\\s]?\\d|(^|[^a-z])o\\d|\\bsol\\b/i.test(t || '');
    const openMenu = async () => {
      let t = trigger();
      for (let i = 0; i < 40 && !t; i++) {
        await sleep(200);
        t = trigger();
      }
      if (!t) return false;
      if (menus().length === 0) {
        openClick(t);
        for (let i = 0; i < 20 && menus().length === 0; i++) {
          if (i === 10) openClick(t);
          await sleep(150);
        }
      }
      return menus().length > 0;
    };
    const actions = [];

    if (!(await openMenu())) return { ok: false, error: 'menu-open-failed', actions };

    // Effort (top-level menuitemradio)
    if (TARGET_EFFORT) {
      const want = norm(TARGET_EFFORT);
      const it = items().find(
        (n) => n.getAttribute('role') === 'menuitemradio' && !isVersionText(n.textContent) &&
          (norm(n.textContent) === want || norm(n.textContent).startsWith(want)),
      );
      if (!it) return { ok: false, error: 'effort-not-found', actions };
      if (isChecked(it)) actions.push('effort-already:' + want);
      else { openClick(it); actions.push('effort:' + want); await sleep(700); }
    }

    // Version (open submenu, click radio)
    if (TARGET_VERSION) {
      const want = norm(TARGET_VERSION);
      await openMenu();
      const verTrigger = items().find((n) => n.getAttribute('aria-haspopup') === 'menu' && isVersionText(n.textContent));
      if (verTrigger && norm(verTrigger.textContent).startsWith(want)) {
        actions.push('version-already:' + want);
      } else if (verTrigger) {
        const before = menus().length;
        hover(verTrigger);
        openClick(verTrigger);
        for (let i = 0; i < 20 && menus().length <= before; i++) await sleep(100);
        const opt = items().find(
          (n) => n.getAttribute('role') === 'menuitemradio' &&
            (norm(n.textContent) === want || norm(n.textContent).startsWith(want)),
        );
        if (!opt) return { ok: false, error: 'version-not-found', actions };
        if (isChecked(opt)) actions.push('version-already:' + want);
        else { openClick(opt); actions.push('version:' + want); await sleep(700); }
      } else {
        return { ok: false, error: 'version-trigger-not-found', actions };
      }
    }

    // Snapshot resulting selection (trigger pill = effort, version trigger = version).
    await openMenu();
    const verTrigger = items().find((n) => n.getAttribute('aria-haspopup') === 'menu' && isVersionText(n.textContent));
    const currentVersion = (verTrigger?.textContent || '').replace(/\\s+/g, ' ').trim();
    const currentEffort = (trigger()?.textContent || '').replace(/\\s+/g, ' ').trim();
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (e) {}

    return { ok: true, currentVersion, currentEffort, actions };
  })()`;
}

/** Apply a version/effort selection by exact text; returns the resulting state. */
export async function applyInventorySelection(
  Runtime: RuntimeLike,
  targetVersion: string | null,
  targetEffort: string | null,
): Promise<ApplyResult> {
  const out = await Runtime.evaluate({
    expression: buildApplySelectionExpression(targetVersion, targetEffort),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = out.result?.value as ApplyResult | undefined;
  return value ?? { ok: false, error: "no-result" };
}

// ── Read current selection ───────────────────────────────────────────────────
// Robustly read the active version/effort from the TOP menu only (no submenu):
// the version-trigger item's label always reflects the current version, and the
// checked effort radio (or composer pill) reflects the current effort. Used to
// verify a selection without the flaky submenu re-open.

export interface CurrentSelection {
  ok: boolean;
  version?: string | null;
  effort?: string | null;
}

export function buildReadCurrentSelectionExpression(): string {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const TRIGGER = ${JSON.stringify(INVENTORY_TRIGGER_SELECTOR)};
    const MENU = ${JSON.stringify(INVENTORY_MENU_SELECTOR)};
    const ITEM = ${JSON.stringify(INVENTORY_ITEM_SELECTOR)};
    const isVersionText = (t) => /gpt[-\\s]?\\d|(^|[^a-z])o\\d|\\bsol\\b/i.test(t || '');
    const fire = (el, type, pointer) => {
      try {
        const common = { bubbles: true, cancelable: true, view: window };
        const ev = pointer && 'PointerEvent' in window
          ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
          : new MouseEvent(type, common);
        el.dispatchEvent(ev);
      } catch (e) {}
    };
    const openClick = (el) => {
      try { el.focus(); } catch (e) {}
      ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
        .forEach((t) => fire(el, t, t.startsWith('pointer')));
    };
    const menus = () => Array.from(document.querySelectorAll(MENU));
    const items = () => menus().flatMap((m) => Array.from(m.querySelectorAll(ITEM)));
    const trigger = () => document.querySelector(TRIGGER);
    const isChecked = (n) => n.getAttribute('aria-checked') === 'true' || (n.getAttribute('data-state') || '') === 'checked';

    let t = trigger();
    for (let i = 0; i < 40 && !t; i++) { await sleep(200); t = trigger(); }
    if (!t) return { ok: false };
    const pill = clean(t.textContent);
    if (menus().length === 0) {
      openClick(t);
      for (let i = 0; i < 20 && menus().length === 0; i++) { if (i === 10) openClick(t); await sleep(150); }
    }
    const its = items();
    const verTrigger = its.find((n) => n.getAttribute('aria-haspopup') === 'menu' && isVersionText(n.textContent));
    const checkedEffort = its.find(
      (n) => n.getAttribute('role') === 'menuitemradio' && isChecked(n) && !isVersionText(n.textContent),
    );
    const version = clean(verTrigger?.textContent || '');
    const effort = clean(checkedEffort?.textContent || pill);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    } catch (e) {}
    return { ok: true, version, effort };
  })()`;
}

/** Read the active version/effort from the top menu (robust, no submenu). */
export async function readCurrentSelection(Runtime: RuntimeLike): Promise<CurrentSelection> {
  const out = await Runtime.evaluate({
    expression: buildReadCurrentSelectionExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = out.result?.value as CurrentSelection | undefined;
  return value ?? { ok: false };
}

