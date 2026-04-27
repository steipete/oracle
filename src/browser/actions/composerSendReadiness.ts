import type { ChromeClient } from "../types.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS, UPLOAD_STATUS_SELECTORS } from "../constants.js";
import { buildClickDispatcher } from "./domEvents.js";

export type ComposerSendButtonState = "ready" | "disabled" | "missing";

export interface ComposerSendReadinessState {
  state: ComposerSendButtonState;
  uploading: boolean;
  filesAttached: boolean;
  attachedNames: string[];
  inputNames: string[];
  fileCount: number;
  attachmentUiCount: number;
}

export interface ComposerAttachmentEvidence {
  expectedNormalized: string[];
  attachedNames: string[];
  inputNames: string[];
  attachedMatch: boolean;
  inputMatch: boolean;
  fileCountSatisfied: boolean;
  attachmentUiSatisfied: boolean;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeExpectedName(value: string): string {
  const baseName = value.split("/").pop()?.split("\\").pop() ?? value;
  return normalizeToken(baseName);
}

function matchesExpected(raw: string, expected: string): boolean {
  if (raw.includes(expected)) {
    return true;
  }
  const expectedNoExt = expected.replace(/\.[a-z0-9]{1,10}$/i, "");
  if (expectedNoExt.length >= 6 && raw.includes(expectedNoExt)) {
    return true;
  }
  if (raw.includes("…") || raw.includes("...")) {
    const marker = raw.includes("…") ? "…" : "...";
    const [prefixRaw, suffixRaw] = raw.split(marker);
    const prefix = prefixRaw.trim();
    const suffix = suffixRaw.trim();
    const target = expectedNoExt.length >= 6 ? expectedNoExt : expected;
    const matchesPrefix = !prefix || target.includes(prefix);
    const matchesSuffix = !suffix || target.includes(suffix);
    return matchesPrefix && matchesSuffix;
  }
  return false;
}

function buildComposerScopeHelpersExpression(): string {
  return `
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const attachmentSelectors = [
      'input[type="file"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      '[aria-label*="remove"]',
    ];
    const attachmentChipSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove"]',
      'button[aria-label*="Remove"]',
    ];
    const fileCountSelectors = [
      'button',
      '[role="button"]',
      '[data-testid*="file"]',
      '[data-testid*="upload"]',
      '[data-testid*="attachment"]',
      '[data-testid*="chip"]',
      '[aria-label*="file"]',
      '[title*="file"]',
      '[aria-label*="attachment"]',
      '[title*="attachment"]',
    ].join(',');
    const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const findPromptNode = () => {
      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (isVisible(node)) return node;
        }
      }
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const locateComposerRoot = () => {
      const promptNode = findPromptNode();
      if (promptNode) {
        const initial =
          promptNode.closest('[data-testid*="composer"]') ??
          promptNode.closest('form') ??
          promptNode.parentElement ??
          document.body;
        let current = initial;
        let fallback = initial;
        while (current && current !== document.body) {
          const hasSend = sendSelectors.some((selector) => current.querySelector(selector));
          if (hasSend) {
            fallback = current;
            const hasAttachment = attachmentSelectors.some((selector) => current.querySelector(selector));
            if (hasAttachment) {
              return current;
            }
          }
          current = current.parentElement;
        }
        return fallback ?? initial;
      }
      return document.querySelector('form') ?? document.body;
    };
    const composerRoot = locateComposerRoot();
    const composerScope = (() => {
      if (!composerRoot) return document.body;
      const parent = composerRoot.parentElement;
      const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
      return parentHasSend ? parent : composerRoot;
    })();
    const findSendButton = () => {
      const seen = new Set();
      const candidates = [];
      const scopes = [composerScope, composerRoot, document.body];
      for (const scope of scopes) {
        if (!scope || typeof scope.querySelectorAll !== 'function') continue;
        for (const selector of sendSelectors) {
          for (const node of Array.from(scope.querySelectorAll(selector))) {
            if (!(node instanceof HTMLElement) || seen.has(node)) continue;
            seen.add(node);
            candidates.push(node);
          }
        }
        if (candidates.length > 0) break;
      }
      return candidates.find((node) => isVisible(node)) ?? candidates[0] ?? null;
    };
    const collectAttachmentNodes = () => {
      const nodes = [];
      const seen = new Set();
      for (const selector of attachmentChipSelectors) {
        for (const node of Array.from(composerScope.querySelectorAll(selector))) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          nodes.push(node);
        }
      }
      return nodes;
    };
    const collectFileCount = (nodes) => {
      let count = 0;
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches('textarea,input,[contenteditable="true"]')) continue;
        const dataTestId = node.getAttribute?.('data-testid') ?? '';
        const aria = node.getAttribute?.('aria-label') ?? '';
        const title = node.getAttribute?.('title') ?? '';
        const tooltip =
          node.getAttribute?.('data-tooltip') ?? node.getAttribute?.('data-tooltip-content') ?? '';
        const text = node.textContent ?? '';
        const parent = node.parentElement;
        const parentText = parent?.textContent ?? '';
        const parentAria = parent?.getAttribute?.('aria-label') ?? '';
        const parentTitle = parent?.getAttribute?.('title') ?? '';
        const parentTooltip =
          parent?.getAttribute?.('data-tooltip') ?? parent?.getAttribute?.('data-tooltip-content') ?? '';
        const parentTestId = parent?.getAttribute?.('data-testid') ?? '';
        const candidates = [
          text,
          aria,
          title,
          tooltip,
          dataTestId,
          parentText,
          parentAria,
          parentTitle,
          parentTooltip,
          parentTestId,
        ];
        let hasFileHint = false;
        for (const raw of candidates) {
          if (!raw) continue;
          const lowered = String(raw).toLowerCase();
          if (lowered.includes('file') || lowered.includes('attachment')) {
            hasFileHint = true;
            break;
          }
        }
        if (!hasFileHint) continue;
        for (const raw of candidates) {
          if (!raw) continue;
          const match = String(raw).toLowerCase().match(countRegex);
          if (match) {
            const parsed = Number(match[1]);
            if (Number.isFinite(parsed)) {
              count = Math.max(count, parsed);
            }
          }
        }
      }
      return count;
    };
  `;
}

export function buildComposerSendReadinessExpression(): string {
  return `(() => {
    ${buildComposerScopeHelpersExpression()}
    const button = findSendButton();
    const style = button ? window.getComputedStyle(button) : null;
    const disabled = button
      ? button.hasAttribute('disabled') ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.getAttribute('data-disabled') === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      : null;
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(composerScope.querySelectorAll(selector)).some((node) => {
        const ariaBusy = node.getAttribute?.('aria-busy');
        const dataState = node.getAttribute?.('data-state');
        if (
          ariaBusy === 'true' ||
          dataState === 'loading' ||
          dataState === 'uploading' ||
          dataState === 'pending'
        ) {
          return true;
        }
        const text = node.textContent?.toLowerCase?.() ?? '';
        return /\\buploading\\b/.test(text) || /\\bprocessing\\b/.test(text);
      });
    });
    const attachmentNodes = collectAttachmentNodes();
    const attachedNames = [];
    for (const node of attachmentNodes) {
      const text = node.textContent ?? '';
      const aria = node.getAttribute?.('aria-label') ?? '';
      const title = node.getAttribute?.('title') ?? '';
      const parentText = node.parentElement?.parentElement?.innerText ?? '';
      for (const value of [text, aria, title, parentText]) {
        const normalized = value?.toLowerCase?.();
        if (normalized) attachedNames.push(normalized);
      }
    }
    const cardTexts = Array.from(composerScope.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    attachedNames.push(...cardTexts.filter(Boolean));
    const inputNames = [];
    const inputScope = Array.from(composerScope.querySelectorAll('input[type="file"]'));
    const inputNodes = [];
    const inputSeen = new Set();
    for (const el of [...inputScope, ...Array.from(document.querySelectorAll('input[type="file"]'))]) {
      if (!inputSeen.has(el)) {
        inputSeen.add(el);
        inputNodes.push(el);
      }
    }
    for (const input of inputNodes) {
      if (!(input instanceof HTMLInputElement) || !input.files?.length) continue;
      for (const file of Array.from(input.files)) {
        if (file?.name) inputNames.push(file.name.toLowerCase());
      }
    }
    const localFileCountNodes = Array.from(composerScope.querySelectorAll(fileCountSelectors));
    let fileCount = collectFileCount(localFileCountNodes);
    if (!fileCount) {
      fileCount = collectFileCount(Array.from(document.querySelectorAll(fileCountSelectors)));
    }
    const attachmentUiCount = attachmentNodes.length;
    const filesAttached = attachedNames.length > 0 || fileCount > 0 || attachmentUiCount > 0;
    return {
      state: button ? (disabled ? 'disabled' : 'ready') : 'missing',
      uploading,
      filesAttached,
      attachedNames,
      inputNames,
      fileCount,
      attachmentUiCount,
    };
  })()`;
}

export function buildComposerSendClickExpression(): string {
  return `(() => {
    ${buildClickDispatcher()}
    ${buildComposerScopeHelpersExpression()}
    const button = findSendButton();
    if (!button) return 'missing';
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true' ||
      button.getAttribute('data-disabled') === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none' ||
      style.visibility === 'hidden';
    if (disabled) return 'disabled';
    dispatchClickSequence(button);
    return 'clicked';
  })()`;
}

export async function readComposerSendReadiness(
  Runtime: ChromeClient["Runtime"],
): Promise<ComposerSendReadinessState | null> {
  const response = await Runtime.evaluate({
    expression: buildComposerSendReadinessExpression(),
    returnByValue: true,
  });
  return (response.result?.value as ComposerSendReadinessState | undefined) ?? null;
}

export function evaluateComposerAttachmentEvidence(
  state: ComposerSendReadinessState,
  expectedNames: string[] = [],
): ComposerAttachmentEvidence {
  const expectedNormalized = expectedNames.map(normalizeExpectedName).filter(Boolean);
  const attachedNames = (state.attachedNames ?? []).map(normalizeToken).filter(Boolean);
  const inputNames = (state.inputNames ?? []).map(normalizeToken).filter(Boolean);
  if (expectedNormalized.length === 0) {
    const attached = Boolean(
      state.filesAttached || state.fileCount > 0 || state.attachmentUiCount > 0,
    );
    const input = inputNames.length > 0;
    return {
      expectedNormalized,
      attachedNames,
      inputNames,
      attachedMatch: attached,
      inputMatch: input,
      fileCountSatisfied: attached,
      attachmentUiSatisfied: attached,
    };
  }
  return {
    expectedNormalized,
    attachedNames,
    inputNames,
    attachedMatch: expectedNormalized.every((expected) =>
      attachedNames.some((raw) => matchesExpected(raw, expected)),
    ),
    inputMatch: expectedNormalized.every((expected) =>
      inputNames.some((raw) => matchesExpected(raw, expected)),
    ),
    fileCountSatisfied: state.fileCount >= expectedNormalized.length,
    attachmentUiSatisfied: state.attachmentUiCount >= expectedNormalized.length,
  };
}

export function hasAttachmentCompletionEvidence(
  state: ComposerSendReadinessState,
  expectedNames: string[] = [],
): boolean {
  const evidence = evaluateComposerAttachmentEvidence(state, expectedNames);
  return (
    evidence.attachedMatch ||
    evidence.inputMatch ||
    evidence.fileCountSatisfied ||
    evidence.attachmentUiSatisfied
  );
}

export function summarizeComposerSendReadiness(
  state: ComposerSendReadinessState | null,
  expectedNames: string[] = [],
): Record<string, unknown> {
  if (!state) {
    return { state: "unavailable" };
  }
  const evidence = evaluateComposerAttachmentEvidence(state, expectedNames);
  return {
    state: state.state,
    uploading: state.uploading,
    filesAttached: state.filesAttached,
    fileCount: state.fileCount,
    attachmentUiCount: state.attachmentUiCount,
    attachedNames: evidence.attachedNames.slice(0, 3),
    inputNames: evidence.inputNames.slice(0, 3),
    attachedMatch: evidence.attachedMatch,
    inputMatch: evidence.inputMatch,
    fileCountSatisfied: evidence.fileCountSatisfied,
    attachmentUiSatisfied: evidence.attachmentUiSatisfied,
  };
}
