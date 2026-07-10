import type { BrowserLogger, ChromeClient } from "../types.js";
import { formatElapsed } from "../../oracle/format.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTORS,
} from "../constants.js";

const THINKING_STALE_HINT_MS = 10 * 60_000;

export interface ThinkingStatusSnapshot {
  message: string;
  source: "inline" | "sidecar";
  progressPercent?: number;
  panelOpened?: boolean;
  panelVisible?: boolean;
}

interface ThinkingStatusMonitorOptions {
  intervalMs?: number;
  now?: () => number;
}

export function startThinkingStatusMonitor(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: ThinkingStatusMonitorOptions = {},
): () => void {
  const intervalMs = resolveThinkingStatusInterval(options.intervalMs);
  if (!intervalMs) {
    return () => {};
  }
  const now = options.now ?? Date.now;
  let stopped = false;
  let pending = false;
  let lastFingerprint: string | null = null;
  let lastChangedAt = now();
  const startedAt = now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const snapshot = await readThinkingStatus(Runtime);
      if (stopped) {
        return;
      }
      const tickAt = now();
      if (snapshot) {
        const fingerprint = buildThinkingStatusFingerprint(snapshot);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastChangedAt = tickAt;
        }
        if (stopped) {
          return;
        }
        logger(formatThinkingLog(startedAt, tickAt, snapshot, "", tickAt - lastChangedAt));
      } else {
        logger(formatThinkingWaitingLog(startedAt, tickAt));
      }
    } catch {
      // ignore DOM polling errors
    } finally {
      pending = false;
    }
  }, intervalMs);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

export function formatThinkingLog(
  startedAt: number,
  now: number,
  status: string | ThinkingStatusSnapshot,
  locatorSuffix: string,
  unchangedMs = 0,
): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const snapshot: ThinkingStatusSnapshot =
    typeof status === "string"
      ? { message: sanitizeThinkingText(status) || "active", source: "inline" }
      : status;
  const progress =
    typeof snapshot.progressPercent === "number" && Number.isFinite(snapshot.progressPercent)
      ? `${Math.max(0, Math.min(100, Math.round(snapshot.progressPercent)))}% UI progress`
      : null;
  const prefix = progress
    ? `[browser] ChatGPT thinking - ${progress}, ${elapsedText} elapsed`
    : `[browser] ChatGPT thinking - ${elapsedText} elapsed`;
  const statusLabel = snapshot.message ? `; status=${snapshot.message}` : "";
  const changeLabel = unchangedMs > 0 ? `; last change ${formatElapsed(unchangedMs)} ago` : "";
  const staleLabel =
    unchangedMs >= THINKING_STALE_HINT_MS ? "; stale-hint=no UI progress change" : "";
  const sourceLabel = snapshot.source ? `; source=${snapshot.source}` : "";
  return `${prefix}${statusLabel}${changeLabel}${staleLabel}${sourceLabel}${locatorSuffix}`;
}

export function formatThinkingWaitingLog(startedAt: number, now: number): string {
  return `[browser] Waiting for ChatGPT response - ${formatElapsed(now - startedAt)} elapsed; no thinking status detected yet.`;
}

function resolveThinkingStatusInterval(intervalMs?: number): number | null {
  if (intervalMs === 0) {
    return null;
  }
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0) {
    return Math.max(1000, Math.floor(intervalMs));
  }
  return 30_000;
}

function buildThinkingStatusFingerprint(snapshot: ThinkingStatusSnapshot): string {
  return [
    snapshot.source,
    snapshot.message,
    snapshot.progressPercent == null ? "" : Math.round(snapshot.progressPercent),
    snapshot.panelVisible ? "panel" : "",
  ].join(":");
}

async function readThinkingStatus(
  Runtime: ChromeClient["Runtime"],
): Promise<ThinkingStatusSnapshot | null> {
  const expression = buildThinkingStatusExpression();
  const { result } = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.value as Partial<ThinkingStatusSnapshot> | string | null | undefined;
  if (typeof value === "string") {
    const sanitized = sanitizeThinkingText(value);
    return sanitized ? { message: sanitized, source: "inline" } : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value.source === "sidecar" ? "sidecar" : "inline";
  const message = sanitizeThinkingText(value.message ?? "");
  const progressPercent =
    typeof value.progressPercent === "number" && Number.isFinite(value.progressPercent)
      ? Math.max(0, Math.min(100, value.progressPercent))
      : undefined;
  if (!message && progressPercent == null) {
    return null;
  }
  return {
    message: message || "active",
    source,
    progressPercent,
    panelOpened: value.panelOpened === true,
    panelVisible: value.panelVisible === true,
  };
}

const SAFE_THINKING_STATUS_MESSAGES = new Set([
  "active",
  "response streaming",
  "thinking sidecar active",
  "thinking sidecar opened",
]);

export function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  const normalized = prefixPattern.test(trimmed)
    ? trimmed.replace(prefixPattern, "").trim()
    : trimmed;
  if (!normalized) {
    return "";
  }
  const normalizedKey = normalized.toLowerCase();
  return SAFE_THINKING_STATUS_MESSAGES.has(normalizedKey) ? normalizedKey : "active";
}

function buildThinkingStatusExpression(): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const selectors = [
    "span.loading-shimmer",
    "span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary",
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = ["pro thinking", "thinking", "reasoning"];
  const stopSelector = STOP_BUTTON_SELECTORS.join(", ");
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  const stopSelectorLiteral = JSON.stringify(stopSelector);
  return `(async () => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const stopSelector = ${stopSelectorLiteral};
    const normalize = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/\\s+/g, ' ')
        .trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      ) {
        return false;
      }
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const labelFor = (node) =>
      normalize([
        node.textContent,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' '));
    const looksLikeThinking = (node) => {
      const label = labelFor(node);
      return (
        label.includes('thinking') ||
        label.includes('reasoning') ||
        label.includes('pro thinking') ||
        label.includes('myslen') ||
        label.includes('mysl') ||
        label.includes('rozumow')
      );
    };
    const isComposerAdjacent = (node) =>
      Boolean(node.closest?.('[contenteditable="true"], textarea, [data-testid*="composer"], [id*="composer"]'));
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const latestAssistantTurn = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        if (isAssistantTurn(turns[index])) {
          return turns[index];
        }
      }
      return null;
    };
    const findThinkingDisclosure = (scope) => {
      const candidates = Array.from(
        scope.querySelectorAll(
          [
            'button',
            '[role="button"]',
            '[aria-expanded]',
            '[data-testid*="thinking"]',
            '[data-testid*="reasoning"]',
          ].join(','),
        ),
      );
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isVisible(node) || isComposerAdjacent(node) || !looksLikeThinking(node)) continue;
        if (node.getAttribute('aria-haspopup') === 'menu') continue;
        if (node.dataset?.oracleThinkingProbed === 'true') continue;
        const expanded = normalize(node.getAttribute('aria-expanded'));
        if (expanded !== 'false') {
          continue;
        }
        return node;
      }
      return null;
    };
    const findProgressPercent = (scope) => {
      const progressNodes = Array.from(
        scope.querySelectorAll('progress, [role="progressbar"], [aria-valuenow], [data-testid*="progress"], [class*="progress"]'),
      );
      const readNumeric = (raw) => {
        if (raw == null || raw === '') return null;
        const value = Number(String(raw).replace('%', '').trim());
        return Number.isFinite(value) ? value : null;
      };
      const readStylePercent = (node) => {
        const style = node instanceof HTMLElement ? window.getComputedStyle(node) : null;
        if (!style) return null;
        const widthMatch = String(node.style?.width || style.width || '').match(
          /([0-9]+(?:\\.[0-9]+)?)%/,
        );
        if (widthMatch) return readNumeric(widthMatch[1]);
        const transform = String(style.transform || '');
        const scaleMatch = transform.match(/scaleX\\(([0-9.]+)\\)/);
        if (scaleMatch) {
          const scale = readNumeric(scaleMatch[1]);
          return scale == null ? null : scale * 100;
        }
        const matrixMatch = transform.match(/matrix\\(([0-9.\\-]+),/);
        if (matrixMatch) {
          const scale = readNumeric(matrixMatch[1]);
          return scale == null ? null : scale * 100;
        }
        return null;
      };
      for (const node of progressNodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
        const ariaNow = readNumeric(node.getAttribute('aria-valuenow'));
        if (ariaNow != null) {
          const ariaMin = readNumeric(node.getAttribute('aria-valuemin')) ?? 0;
          const ariaMax = readNumeric(node.getAttribute('aria-valuemax')) ?? 100;
          const span = Math.max(ariaMax - ariaMin, 1);
          return Math.max(0, Math.min(100, ((ariaNow - ariaMin) / span) * 100));
        }
        if (node instanceof HTMLProgressElement && Number.isFinite(node.value) && Number.isFinite(node.max) && node.max > 0) {
          return Math.max(0, Math.min(100, (node.value / node.max) * 100));
        }
        const stylePercent = readStylePercent(node);
        if (stylePercent != null) {
          return Math.max(0, Math.min(100, stylePercent));
        }
      }
      return null;
    };
    const findThinkingPanel = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'aside',
            '[role="complementary"]',
            '[role="dialog"]',
            '[data-testid*="thinking"]',
            '[data-testid*="reasoning"]',
            '[data-testid*="sidebar"]',
            '[class*="sidecar"]',
            '[class*="sidebar"]',
          ].join(','),
        ),
      );
      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || !isVisible(node) || isComposerAdjacent(node)) continue;
        const rect = node.getBoundingClientRect();
        const rightSidePanel = rect.left >= window.innerWidth * 0.35 && rect.width >= 180 && rect.height >= 120;
        const hasProgress = findProgressPercent(node) != null;
        if (hasProgress || (rightSidePanel && looksLikeThinking(node))) {
          return node;
        }
      }
      return null;
    };
    const existingPanel = findThinkingPanel();
    if (existingPanel) {
      return {
        message: 'thinking sidecar active',
        source: 'sidecar',
        progressPercent: findProgressPercent(existingPanel),
        panelOpened: false,
        panelVisible: true,
      };
    }
    let panelOpened = false;
    const currentTurn = latestAssistantTurn();
    const disclosure = currentTurn ? findThinkingDisclosure(currentTurn) : null;
    if (disclosure) {
      try {
        disclosure.dataset.oracleThinkingProbed = 'true';
        disclosure.click();
        panelOpened = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        // non-fatal; fall through to passive status detection
      }
    }
    const panel = findThinkingPanel();
    if (panel) {
      const progressPercent = findProgressPercent(panel);
      return {
        message: panelOpened ? 'thinking sidecar opened' : 'thinking sidecar active',
        source: 'sidecar',
        progressPercent,
        panelOpened,
        panelVisible: true,
      };
    }
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = String(node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        return {
          message: 'active',
          source: 'inline',
        };
      }
    }
    // Last-resort liveness fallback: selector drift can hide every thinking
    // indicator while a response is still generating, and returning null here
    // reads as "dead" downstream. The stop/interrupt control is a stable,
    // language-independent signal that generation is active; it lives in the
    // composer, so isComposerAdjacent must not filter it.
    const stopVisible = Array.from(document.querySelectorAll(stopSelector)).some((node) =>
      isVisible(node),
    );
    if (stopVisible) {
      return {
        message: 'response streaming',
        source: 'inline',
      };
    }
    return null;
  })()`;
}

// Present-tense/gerund status labels that mean the model is ACTIVELY working. The
// past-tense "thought for Xs" summary is deliberately excluded: it persists in the DOM
// on every completed reasoning turn (and on reattach), so treating its mere presence as
// "still thinking" would veto completion forever and hang the call. Kept in sync with
// THINKING_STATUS_LABELS in assistantResponse.ts (the connector phases "searching the
// web"/"reading"/"finalizing answer" are exactly the GPT-5.5 Pro gaps that produce the
// preamble->answer window this predicate must cover).
const ACTIVE_THINKING_LABELS = [
  "thinking",
  "pro thinking",
  "thinking longer for a better answer",
  "reasoning",
  "finalizing answer",
  "finalizing",
  "analyzing",
  "researching",
  "working on it",
  "working",
  "planning",
  "searching the web",
  "searching",
  "reading",
];

// buildThinkingActivePredicateJs: a SIDE-EFFECT-FREE injected predicate `${fnName}()` that
// returns true iff the model is ACTIVELY generating/thinking right now. Unlike
// buildThinkingStatusExpression it never clicks a disclosure and never keys on the mere
// PRESENCE of a reasoning container ([data-testid*="reasoning"] persists after completion);
// it keys only on ACTIVITY signals: a visible stop/interrupt control, a visible animated
// loading-shimmer skeleton, aria-busy, a visible thinking sidecar panel with live progress,
// or a visible ACTIVE (present-tense) thinking status label. Used as a completion VETO so a
// settled preamble is never finalized while the reasoning/tool phase is still running.
export function buildThinkingActivePredicateJs(fnName: string): string {
  const stopLiteral = JSON.stringify(STOP_BUTTON_SELECTORS.join(", "));
  const activeLabelsLiteral = JSON.stringify(ACTIVE_THINKING_LABELS);
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${fnName} = () => {
    const STOP_SELECTOR = ${stopLiteral};
    const ACTIVE_LABELS = ${activeLabelsLiteral};
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      ) {
        return false;
      }
      return true;
    };
    const some = (selector, pred) => {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { return false; }
      return Array.from(nodes).some((node) => pred(node));
    };
    // 1) Stop/interrupt control visible -> generation is active (language-independent).
    if (some(STOP_SELECTOR, isVisible)) return true;
    // 2) Visible animated loading-shimmer skeleton (only mounted while streaming/thinking).
    if (some('span.loading-shimmer, .loading-shimmer, [class*="loading-shimmer"]', isVisible)) return true;
    // 3) aria-busy live region.
    if (some('[aria-busy="true"]', isVisible)) return true;
    // 4) Active (present-tense) thinking status label near a status/reasoning node.
    const norm = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/\\s+/g, ' ')
        .trim();
    // Completed reasoning summary: SHORT visible text containing "thought for " (numeric or
    // worded duration, with or without a heading prefix like "Reasoning Thought for 12s", even
    // when fragments concatenate without whitespace). The length cap is what keeps this from
    // vetoing a live sidecar trace: a running trace grows far past 60 chars, while a collapsed
    // completed summary (plus optional heading) stays short.
    const isCompletedSummary = (text) => text.length > 0 && text.length <= 60 && text.includes('thought for ');
    const isActiveLabel = (raw) => {
      const text = norm(raw);
      if (!text || text.length > 60) return false;
      if (isCompletedSummary(text)) return false;
      return ACTIVE_LABELS.some((label) => text === label || text.startsWith(label + ' '));
    };
    const statusNodes = (() => {
      try {
        return Array.from(
          document.querySelectorAll(
            '[data-testid*="thinking"], [data-testid*="reasoning"], [role="status"], [aria-live="polite"], [aria-live="assertive"]',
          ),
        );
      } catch {
        return [];
      }
    })();
    for (const node of statusNodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      if (isActiveLabel(node.textContent) || isActiveLabel(node.getAttribute('aria-label'))) return true;
    }
    // 5) A live progress bar (determinate or indeterminate) is active generation, even when no
    //    label or shimmer is present (some connector/tool phases surface only a progress bar).
    const hasLiveProgress = (scope) => {
      let nodes;
      // Only genuine progress indicators — NOT generic [aria-valuenow] range widgets (sliders,
      // spinbuttons), which are not liveness signals and would falsely veto completion forever.
      try {
        nodes = scope.querySelectorAll('progress, [role="progressbar"]');
      } catch { return false; }
      return Array.from(nodes).some((n) => {
        if (!(n instanceof HTMLElement) || !isVisible(n)) return false;
        if (n instanceof HTMLProgressElement) {
          // Determinate <progress> is active only while it has not reached its max.
          if (Number.isFinite(n.value) && Number.isFinite(n.max) && n.max > 0) return n.value < n.max;
          return true; // indeterminate
        }
        const rawNow = n.getAttribute('aria-valuenow');
        if (rawNow != null) {
          const now = Number(rawNow);
          const rawMax = n.getAttribute('aria-valuemax');
          const max = rawMax != null && Number.isFinite(Number(rawMax)) ? Number(rawMax) : 100;
          return Number.isFinite(now) ? now < max : true;
        }
        return true; // role=progressbar with no value -> indeterminate -> active
      });
    };
    if (hasLiveProgress(document)) return true;
    // 6) A visible thinking/reasoning sidecar panel (the connector/reasoning phase is often
    //    exposed ONLY through a right-side panel with no inline label). Match the existing
    //    thinking-monitor heuristic: a right-side panel that looks like thinking, or any such
    //    container that carries a live progress bar. Presence alone is NOT enough (a collapsed
    //    reasoning summary persists post-completion); require the thinking cue or live progress.
    const looksLikeThinking = (node) => {
      // Judge completion on the panel's VISIBLE text only: data-testid values like
      // "reasoning-panel" would otherwise taint the completed-summary check, and a live trace
      // is judged by its full rendered length, not by fragments of it.
      const visible = norm(node.textContent) || norm(node.getAttribute?.('aria-label'));
      if (isCompletedSummary(visible)) return false;
      const label = norm([
        node.textContent,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' '));
      return label.includes('thinking') || label.includes('reasoning') || label.includes('pro thinking');
    };
    let panels;
    try {
      panels = document.querySelectorAll(
        'aside, [role="complementary"], [role="dialog"], [data-testid*="thinking"], [data-testid*="reasoning"], [class*="sidecar"], [class*="sidebar"]',
      );
    } catch { panels = []; }
    for (const node of Array.from(panels)) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      const rightSide = rect.left >= window.innerWidth * 0.35 && rect.width >= 180 && rect.height >= 120;
      if (hasLiveProgress(node) || (rightSide && looksLikeThinking(node))) return true;
    }
    return false;
  };`;
}

export async function isThinkingActive(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        ${buildThinkingActivePredicateJs("isThinkingActive")}
        return isThinkingActive();
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

export const startThinkingStatusMonitorForTest = startThinkingStatusMonitor;
export const readThinkingStatusForTest = readThinkingStatus;
export const buildThinkingStatusExpressionForTest = buildThinkingStatusExpression;
export const buildThinkingActivePredicateJsForTest = buildThinkingActivePredicateJs;
export { ACTIVE_THINKING_LABELS };
