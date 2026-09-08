import { withoutBrowserCancellation } from "../cancellation.js";
import { randomUUID } from "node:crypto";
import type { ChromeClient } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { conversationIdFromUrl } from "./navigation.js";

export async function captureComposerNavigationUrl(
  runtime: ChromeClient["Runtime"],
): Promise<string> {
  const result = await runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  const url = result?.result?.value;
  if (typeof url !== "string" || !url) {
    throw new BrowserAutomationError(
      "Oracle could not capture ChatGPT's page identity before attachment upload.",
      {
        stage: "upload-attachment",
        code: "attachment-navigation-identity-unavailable",
      },
    );
  }
  return url;
}

export async function assertComposerPlusStayedInPlace(
  runtime: ChromeClient["Runtime"],
  startUrl: string,
): Promise<void> {
  const result = await runtime.evaluate({
    expression: buildComposerNavigationProbeExpression(),
    returnByValue: true,
  });
  assertComposerNavigationSnapshot(startUrl, result?.result?.value);
}

export function buildComposerNavigationProbeExpression(): string {
  return `(() => {
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isWorkLabel = value => ['work', '工作'].includes(normalize(value));
      const controlLabel = node => normalize(node.textContent || node.getAttribute('aria-label'));
      const modeValue = node => normalize(node.getAttribute('data-mode') || node.getAttribute('data-value') || node.getAttribute('value'));
      const visible = node => {
        if (node.closest?.('[data-message-author-role], [data-testid^="conversation-turn-"], article[data-turn]')) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        for (let current = node; current && typeof current.getBoundingClientRect === 'function'; current = current.parentElement) {
          const style = window.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || current.getAttribute?.('aria-hidden') === 'true') return false;
        }
        return true;
      };
      const selected = node =>
        node?.getAttribute?.('aria-checked') === 'true' ||
        node?.getAttribute?.('aria-selected') === 'true' ||
        node?.getAttribute?.('aria-pressed') === 'true' ||
        node?.getAttribute?.('data-state') === 'on' ||
        node?.getAttribute?.('data-state') === 'active';
      const prompt = document.querySelector('#prompt-textarea');
      const fallbackPrompt = document.querySelector('textarea[name="prompt-textarea"]');
      const composer = (prompt ?? fallbackPrompt)?.closest('form, [data-testid="composer"]');
      const selectedControls = Array.from(
        document.querySelectorAll('[aria-checked="true"],[aria-selected="true"],[aria-pressed="true"],[data-state="on"],[data-state="active"]'),
      ).filter(visible).filter(selected);
      const workToggleSelected = selectedControls.some(node => modeValue(node) === 'work' ||
        composer?.contains(node) && node.matches('button[role="radio"],button[role="tab"],button[aria-pressed]') && isWorkLabel(controlLabel(node)));
      // Labels outside the composer may name unrelated sidebar items or tabs.
      const placeholder = normalize(
        prompt?.getAttribute?.('data-placeholder') ||
        prompt?.getAttribute?.('placeholder') ||
        fallbackPrompt?.getAttribute?.('placeholder'),
      );
      return {
        currentUrl: location.href,
        workSelected: /(?:^|\\/)c\\/WEB(?::|%3a)/i.test(location.pathname) || workToggleSelected || placeholder === 'work on anything',
        modeUnverified: false,
      };
    })()`;
}

export function assertComposerNavigationSnapshot(startUrl: string, snapshot: unknown): void {
  const value = snapshot as
    | { currentUrl?: string; workSelected?: boolean; modeUnverified?: boolean }
    | undefined;
  const currentUrl = typeof value?.currentUrl === "string" ? value.currentUrl : "";
  const startIdentity = composerNavigationIdentityFromUrl(startUrl);
  const currentIdentity = composerNavigationIdentityFromUrl(currentUrl);
  const unexpectedNavigation =
    !startIdentity ||
    !currentIdentity ||
    startIdentity.origin !== currentIdentity.origin ||
    (startIdentity.conversationId !== null
      ? currentIdentity.conversationId !== startIdentity.conversationId
      : currentIdentity.conversationId !== null ||
        currentIdentity.landingPath !== startIdentity.landingPath);
  const workConversation =
    currentIdentity?.conversationId && /^WEB(?::|%3a)/i.test(currentIdentity.conversationId);
  if (value?.workSelected || workConversation || unexpectedNavigation) {
    throw new BrowserAutomationError(
      "ChatGPT navigated to Work or another ChatGPT context during attachment preparation; upload/send was stopped before prompt submission.",
      {
        stage: "upload-attachment",
        code: "attachment-control-unexpected-navigation",
        startUrl,
        currentUrl,
        workSelected: Boolean(value?.workSelected),
        startNavigationIdentity: startIdentity,
        currentNavigationIdentity: currentIdentity,
      },
    );
  }
  if (value?.modeUnverified) {
    throw new BrowserAutomationError(
      "ChatGPT mode could not be verified; attachment upload/send was stopped.",
      {
        stage: "upload-attachment",
        code: "attachment-control-mode-unverified",
        startUrl,
        currentUrl,
      },
    );
  }
}

interface ComposerNavigationIdentity {
  origin: string;
  conversationId: string | null;
  landingPath: string | null;
}

export function composerNavigationIdentityFromUrl(
  value: string,
): ComposerNavigationIdentity | null {
  try {
    const url = new URL(value);
    const conversationId = conversationIdFromUrl(url.href);
    return {
      origin: url.origin.toLowerCase(),
      conversationId,
      landingPath: conversationId === null ? url.pathname.replace(/\/+$/, "") || "/" : null,
    };
  } catch {
    return null;
  }
}

export function buildComposerNavigationValidationExpression(startUrl: string): string {
  const expected = composerNavigationIdentityFromUrl(startUrl);
  return `(() => {
    const snapshot = ${buildComposerNavigationProbeExpression()};
    const expected = ${JSON.stringify(expected)};
    let contextMatches = false;
    try {
      const current = new URL(snapshot.currentUrl);
      const id = current.pathname.match(/(?:^|\\/)c\\/([^/]+)/)?.[1] ?? null;
      contextMatches = Boolean(expected) && !snapshot.workSelected && !snapshot.modeUnverified &&
        current.origin.toLowerCase() === expected.origin &&
        (expected.conversationId !== null ? id === expected.conversationId :
          id === null && (current.pathname.replace(/\\/+$/, '') || '/') === expected.landingPath);
    } catch {}
    return { ...snapshot, contextMatches };
  })()`;
}

/** Guards native file-selection events before application handlers can upload the bytes. */
export function buildFileInputGuardExpression(inputExpression: string, startUrl: string): string {
  return `(() => {
    const guardedInput = ${inputExpression};
    let blocked = null;
    let listening = false;
    const cleanup = () => {
      if (!listening) return;
      window.removeEventListener('input', onEvent, true);
      window.removeEventListener('change', onEvent, true);
      listening = false;
    };
    const validate = (rollback = false) => {
      try {
        const snapshot = ${buildComposerNavigationValidationExpression(startUrl)};
        if (!snapshot.contextMatches) blocked = snapshot;
      } catch { blocked = { currentUrl: location.href, modeUnverified: true }; }
      if (blocked && rollback && guardedInput) { try { guardedInput.value = ''; } catch {} }
      return !blocked;
    };
    const onEvent = event => {
      if (event.target !== guardedInput) return;
      if (!validate(true)) { event.preventDefault(); event.stopImmediatePropagation(); }
      if (event.type === 'change') cleanup();
    };
    if (validate()) {
      window.addEventListener('input', onEvent, true);
      window.addEventListener('change', onEvent, true);
      listening = true;
    }
    return { get blocked() { return blocked; }, validate, cleanup };
  })()`;
}

export async function withGuardedFileInput(
  runtime: ChromeClient["Runtime"],
  selector: string,
  startUrl: string,
  assign: () => Promise<void>,
): Promise<void> {
  const id = randomUUID();
  let result: { blocked?: unknown } | undefined;
  try {
    const prepared = await runtime.evaluate({
      expression: `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return { installed: false };
    const guard = ${buildFileInputGuardExpression("input", startUrl)};
    if (guard.blocked) { guard.cleanup(); return { blocked: guard.blocked }; }
    const guards = window.__oracleAttachmentInputGuards ??= Object.create(null);
    guards[${JSON.stringify(id)}] = guard;
    return { installed: true };
  })()`,
      returnByValue: true,
    });
    const preparation = prepared.result?.value as
      | { installed?: boolean; blocked?: unknown }
      | undefined;
    if (preparation?.blocked) assertComposerNavigationSnapshot(startUrl, preparation.blocked);
    if (!preparation?.installed)
      throw new BrowserAutomationError("Attachment input changed before assignment.", {
        stage: "upload-attachment",
        code: "attachment-input-unavailable",
      });
    await assign();
  } finally {
    const observed = await withoutBrowserCancellation(() =>
      runtime
        .evaluate({
          expression: `(() => {
      const guards = window.__oracleAttachmentInputGuards;
      const guard = guards?.[${JSON.stringify(id)}];
      if (!guard) return null;
      guard.validate(true);
      const summary = { blocked: guard.blocked };
      guard.cleanup(); delete guards[${JSON.stringify(id)}]; return summary;
    })()`,
          returnByValue: true,
        })
        .catch(() => undefined),
    );
    result = observed?.result?.value as typeof result;
  }
  if (!result)
    throw new BrowserAutomationError(
      "Attachment assignment could not be verified; do not retry automatically.",
      { stage: "upload-attachment", code: "attachment-assignment-ambiguous" },
    );
  if (result.blocked) assertComposerNavigationSnapshot(startUrl, result.blocked);
}

async function mutateGuardedFileInput(
  runtime: ChromeClient["Runtime"],
  selector: string,
  startUrl: string,
  events: boolean,
): Promise<void> {
  const observed = await runtime.evaluate({
    expression: `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return { missing: true };
    const guard = ${buildFileInputGuardExpression("input", startUrl)};
    try {
      if (!guard.blocked) {
        ${events ? "input.dispatchEvent(new Event('input', { bubbles: true })); if (guard.validate()) input.dispatchEvent(new Event('change', { bubbles: true }));" : "input.value = '';"}
        guard.validate(true);
      }
      return { blocked: guard.blocked };
    } finally { guard.cleanup(); }
  })()`,
    returnByValue: true,
  });
  const value = observed.result?.value as { blocked?: unknown; missing?: boolean } | undefined;
  if (value?.blocked) assertComposerNavigationSnapshot(startUrl, value.blocked);
  if (!value || value.missing || observed.exceptionDetails)
    throw new BrowserAutomationError("Attachment input changed during preparation.", {
      stage: "upload-attachment",
      code: "attachment-input-unavailable",
    });
}

export const dispatchGuardedFileInputEvents = (
  runtime: ChromeClient["Runtime"],
  selector: string,
  startUrl: string,
) => mutateGuardedFileInput(runtime, selector, startUrl, true);
export const clearGuardedFileInput = (
  runtime: ChromeClient["Runtime"],
  selector: string,
  startUrl: string,
) => mutateGuardedFileInput(runtime, selector, startUrl, false);
