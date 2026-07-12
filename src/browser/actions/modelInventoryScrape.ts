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

    const trigger = document.querySelector(TRIGGER);
    if (!trigger) return { error: 'trigger-not-found', items: [] };

    // Open the top menu and wait for the portal to mount.
    openClick(trigger);
    for (let i = 0; i < 25 && menus().length === 0; i++) {
      if (i === 10) openClick(trigger);
      await sleep(200);
    }
    if (menus().length === 0) return { error: 'menu-did-not-open', items: [] };

    const top = collect('top');

    // Open the version submenu: the item that opens a nested menu.
    const menuNodes = menus().flatMap((m) => Array.from(m.querySelectorAll(ITEM)));
    const versionTrigger = menuNodes.find(
      (n) => n.getAttribute('aria-haspopup') === 'menu' ||
        (n.getAttribute('data-has-submenu') !== null && /gpt|sol|o\\d/i.test(n.textContent || '')),
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
