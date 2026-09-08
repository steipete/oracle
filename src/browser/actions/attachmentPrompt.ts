import { withoutBrowserCancellation } from "../cancellation.js";
import { randomUUID } from "node:crypto";
import type { ChromeClient } from "../types.js";
import { INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  assertComposerNavigationSnapshot,
  buildComposerNavigationValidationExpression,
} from "./attachmentContext.js";
import { buildClickDispatcher } from "./domEvents.js";

/** Bind editing commands and fallback writes to the original renderer and editor. */
export async function stageAttachmentPrompt(
  runtime: ChromeClient["Runtime"],
  prompt: string,
  navigationUrl: string,
): Promise<number> {
  const id = randomUUID();
  const requireSafe = (value: { blocked?: unknown; ready?: boolean } | undefined) => {
    if (value?.blocked) assertComposerNavigationSnapshot(navigationUrl, value.blocked);
    if (!value?.ready || value.blocked) {
      throw new BrowserAutomationError(
        "Attachment prompt focus or context changed; staging was stopped.",
        {
          stage: "submit-prompt",
          code: "attachment-prompt-not-ready",
        },
      );
    }
  };
  try {
    const prepared = await runtime.evaluate({
      expression: `(() => {
        ${buildClickDispatcher()}
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        const visible = node => { const r = node?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; };
        const resolveEditor = () => selectors.map(s => document.querySelector(s)).find(visible);
        const editor = resolveEditor();
        const read = () => editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText ?? '';
        const write = value => { if (editor instanceof HTMLTextAreaElement) editor.value = value; else if (editor) editor.textContent = value; };
        const guard = { blocked: null, beforeValue: '', sawInput: false };
        const validate = (requireFocus = true) => {
          try {
            const state = ${buildComposerNavigationValidationExpression(navigationUrl)};
            const focused = editor instanceof HTMLElement && editor.isConnected && resolveEditor() === editor &&
              (!requireFocus || document.activeElement === editor || editor.contains(document.activeElement));
            if (!state.contextMatches || !focused) guard.blocked = { ...state, focused };
          } catch { guard.blocked = { currentUrl: location.href, modeUnverified: true }; }
          return !guard.blocked;
        };
        const cancel = event => { event.preventDefault(); event.stopImmediatePropagation(); };
        const onBeforeInput = event => {
          if (!validate() || event.target !== editor) { guard.blocked ??= { currentUrl: location.href, focused: false }; cancel(event); return; }
        };
        const onInput = event => {
          if (!validate() || event.target !== editor) {
            if (event.target === editor) write(guard.beforeValue);
            guard.blocked ??= { currentUrl: location.href, focused: false };
            cancel(event); return;
          }
          guard.sawInput = true;
        };
        guard.cleanup = () => { window.removeEventListener('beforeinput', onBeforeInput, true); window.removeEventListener('input', onInput, true); };
        guard.summary = () => {
          const ready = validate();
          if (!ready && guard.sawInput) write(guard.beforeValue);
          return { ready, blocked: guard.blocked, length: read().length, sawInput: guard.sawInput };
        };
        guard.insert = text => {
          if (!validate()) return;
          guard.beforeValue = read();
          const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: text, inputType: 'insertFromPaste' });
          if (!editor.dispatchEvent(before) || !validate()) return;
          try { document.execCommand('insertText', false, text); } catch {}
        };
        guard.fallback = text => {
          if (!validate() || read().trim()) return;
          const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: text, inputType: 'insertFromPaste' });
          if (!editor.dispatchEvent(before) || !validate()) return;
          write(text);
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertFromPaste' }));
        };
        (window.__oracleAttachmentPromptGuards ??= Object.create(null))[${JSON.stringify(id)}] = guard;
        if (!validate(false)) return { ready: false, blocked: guard.blocked };
        guard.beforeValue = read();
        window.addEventListener('beforeinput', onBeforeInput, true);
        window.addEventListener('input', onInput, true);
        dispatchClickSequence(editor);
        if (!validate(false)) return { ready: false, blocked: guard.blocked };
        editor.focus();
        if (!validate()) return { ready: false, blocked: guard.blocked };
        const selection = document.getSelection();
        if (selection && !(editor instanceof HTMLTextAreaElement)) {
          const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
          selection.removeAllRanges(); selection.addRange(range);
        }
        return guard.summary();
      })()`,
      returnByValue: true,
    });
    requireSafe(prepared.result?.value);
    // A renderer command cannot land in a replacement document after navigation.
    const inserted = await runtime.evaluate({
      expression: `(() => {
        const guard = window.__oracleAttachmentPromptGuards?.[${JSON.stringify(id)}];
        if (!guard) return { ready: false };
        guard.insert(${JSON.stringify(prompt)});
        return guard.summary();
      })()`,
      returnByValue: true,
    });
    requireSafe(inserted.result?.value);
    await delay(500);
    const staged = await runtime.evaluate({
      expression: `(() => {
        const guard = window.__oracleAttachmentPromptGuards?.[${JSON.stringify(id)}];
        if (!guard) return { ready: false };
        const before = guard.summary();
        if (before.ready && !before.length) guard.fallback(${JSON.stringify(prompt)});
        return guard.summary();
      })()`,
      returnByValue: true,
    });
    const value = staged.result?.value as
      | { ready?: boolean; blocked?: unknown; length?: number; sawInput?: boolean }
      | undefined;
    requireSafe(value);
    if (!value?.sawInput)
      throw new BrowserAutomationError(
        "Attachment prompt input was not observed; do not retry automatically.",
        {
          stage: "submit-prompt",
          code: "attachment-prompt-ambiguous",
        },
      );
    return value.length ?? 0;
  } finally {
    await withoutBrowserCancellation(() =>
      runtime
        .evaluate({
          expression: `(() => { const guards = window.__oracleAttachmentPromptGuards; const guard = guards?.[${JSON.stringify(id)}]; guard?.cleanup(); if (guards) delete guards[${JSON.stringify(id)}]; })()`,
        })
        .catch(() => undefined),
    );
  }
}
