import type { BrowserLogger, ChromeClient } from "../types.js";
import type {
  CodexFindingAction,
  CodexFinding,
  CodexFindingDetail,
  CodexFindingDetailSection,
  CodexFindingsPageCounter,
} from "../../codex/types.js";
import {
  parseFindingItem,
  parseFindingsCounter,
  type RawFindingItem,
} from "../../codex/findings.js";
import { delay } from "../utils.js";

type Runtime = ChromeClient["Runtime"];
type Input = ChromeClient["Input"];

export interface FindingsPage {
  items: CodexFinding[];
  counter?: CodexFindingsPageCounter;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface FindingActionResult {
  status: string;
  message?: string;
  url?: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// LIST — the findings list is SSR'd into the page and rendered as `li > button`
// rows (no href). We read them from the DOM in the main world. Pagination is a
// plain `.click()` on the Next-page control (verified to advance the list).
// The click helper is deny-list guarded so it can only ever hit Prev/Next.
// ---------------------------------------------------------------------------

export function buildFindingsReadyExpression(): string {
  return `(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const rows = [...document.querySelectorAll('li > button')].filter((b) => visible(b));
    if (rows.length > 0) return { ready: true };
    const empty = [...document.querySelectorAll('main *')].some(
      (e) => /no findings/i.test(e.textContent || '') && visible(e),
    );
    if (empty) return { ready: true, empty: true };
    if (!document.querySelector('main')) return { ready: false, reason: 'findings main container not mounted yet' };
    return { ready: false, reason: 'no finding rows visible yet' };
  })()`;
}

export function buildFindingsPageExpression(): string {
  return `(() => {
    try {
      const disabled = (b) => !b || b.disabled || b.getAttribute('aria-disabled') === 'true';
      const rows = [...document.querySelectorAll('li > button')];
      const items = rows.map((b) => {
        const sev = b.closest('li').querySelector('[aria-label*="severity" i]');
        return {
          innerText: b.innerText || '',
          severityLabel: sev ? (sev.getAttribute('aria-label') || sev.textContent || null) : null,
        };
      });
      const counterEl = [...document.querySelectorAll('*')]
        .map((e) => e.textContent || '')
        .find((t) => /\\d[\\d,]*\\s*[-–—]\\s*\\d[\\d,]*\\s+of\\s+\\d[\\d,]*/.test(t));
      const counterText = counterEl
        ? counterEl.match(/\\d[\\d,]*\\s*[-–—]\\s*\\d[\\d,]*\\s+of\\s+\\d[\\d,]*/)[0]
        : null;
      const next = document.querySelector('button[aria-label="Next page"]');
      const prev = document.querySelector('button[aria-label="Previous page"]');
      return { ok: true, page: { items, counterText, hasNext: !disabled(next), hasPrev: !disabled(prev) } };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })()`;
}

// Deny-list of mutating actions; the pagination click refuses any target whose accessible name
// matches, and only ever resolves the exact Prev/Next aria-labels.
export function buildPaginationClickExpression(label: "Next page" | "Previous page"): string {
  const deny =
    "create\\\\s*pr|open\\\\s*pr|patch|report|chat|adjust|feedback|thumbs|revert|apply|merge|commit|comment|resolve|dismiss|submit|close";
  return `(() => {
    const DENY = /${deny}/i;
    const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!b) return { ok: false, disabled: true };
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return { ok: false, disabled: true };
    const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (name !== ${JSON.stringify(label)} || DENY.test(name)) return { ok: false, reason: 'refused: unexpected button label ' + name };
    b.scrollIntoView({ block: 'center' });
    b.click();
    return { ok: true };
  })()`;
}

export async function waitForFindingsReady(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "unknown";
  while (Date.now() < deadline) {
    const outcome = await runtime
      .evaluate({ expression: buildFindingsReadyExpression(), returnByValue: true })
      .catch((error) => ({
        result: {
          value: { ready: false, reason: error instanceof Error ? error.message : String(error) },
        },
      }));
    const value = outcome.result?.value as { ready?: boolean; reason?: string } | undefined;
    if (value?.ready === true) {
      return;
    }
    lastReason = value?.reason ?? lastReason;
    await delay(250);
  }
  logger(`Findings list did not become ready before timeout (${lastReason})`);
  throw new Error("Findings list did not become ready before timeout.");
}

export async function readFindingsPage(runtime: Runtime): Promise<FindingsPage> {
  const outcome = await runtime.evaluate({
    expression: buildFindingsPageExpression(),
    returnByValue: true,
  });
  const value = outcome.result?.value as
    | {
        ok?: boolean;
        error?: string;
        page?: {
          items: RawFindingItem[];
          counterText: string | null;
          hasNext: boolean;
          hasPrev: boolean;
        };
      }
    | undefined;
  if (!value?.ok || !value.page) {
    throw new Error(value?.error ?? "Unable to read the findings list.");
  }
  const page = value.page;
  return {
    items: page.items.map((raw, index) => parseFindingItem(raw, index)),
    counter: parseFindingsCounter(page.counterText) ?? undefined,
    hasNext: page.hasNext,
    hasPrev: page.hasPrev,
  };
}

// Poll until the list settles (debounced), mirroring the project-sources settle idiom.
export async function waitForFindingsPageSettled(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<FindingsPage> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  const startedAt = Date.now();
  let previousKey: string | null = null;
  let stableSince = Date.now();
  let latest = await readFindingsPage(runtime);
  while (Date.now() < deadline) {
    latest = await readFindingsPage(runtime);
    const key = `${latest.counter?.from}-${latest.counter?.to}/${latest.counter?.total}\n${latest.items
      .map((i) => i.id)
      .join("\n")}`;
    if (key !== previousKey) {
      previousKey = key;
      stableSince = Date.now();
    }
    const stableForMs = Date.now() - stableSince;
    const observedForMs = Date.now() - startedAt;
    if (observedForMs >= 1500 && stableForMs >= 500) {
      return latest;
    }
    await delay(250);
  }
  logger("Findings list did not settle before timeout; returning latest snapshot.");
  return latest;
}

// Returns false when there is no next page or the visible range did not advance.
export async function goToNextFindingsPage(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<boolean> {
  const before = await readFindingsPage(runtime);
  if (!before.hasNext) {
    return false;
  }
  const outcome = await runtime.evaluate({
    expression: buildPaginationClickExpression("Next page"),
    returnByValue: true,
  });
  const value = outcome.result?.value as
    | { ok?: boolean; disabled?: boolean; reason?: string }
    | undefined;
  if (!value?.ok) {
    if (value?.reason) {
      logger(`[debug] Next-page click refused: ${value.reason}`);
    }
    return false;
  }
  const after = await waitForFindingsPageSettled(runtime, timeoutMs, logger);
  const advanced = (after.counter?.from ?? 0) > (before.counter?.from ?? 0);
  return advanced;
}

// ---------------------------------------------------------------------------
// DETAIL — direct-URL nav then DOM reads only. No click, no mutation.
// ---------------------------------------------------------------------------

export function buildFindingDetailReadyExpression(): string {
  return `(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const IDS = ['summary', 'validation', 'evidence', 'attack-path'];
    const ready = IDS.some((id) => {
      const a = document.querySelector('a[href="#' + id + '"]');
      const c = a ? a.closest('section, div') : document.getElementById(id);
      return visible(a) || visible(c);
    });
    if (ready) return { ready: true };
    if (!document.querySelector('main')) return { ready: false, reason: 'detail main container not mounted yet' };
    return { ready: false, reason: 'no section anchor visible yet' };
  })()`;
}

export function buildFindingDetailExpression(): string {
  return `(() => {
    const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    const main = document.querySelector('main');
    if (!(main instanceof HTMLElement)) return { ok: false, error: 'Finding detail main container not found.' };
    const SECTIONS = [
      { id: 'summary', heading: 'Summary' }, { id: 'validation', heading: 'Validation' },
      { id: 'evidence', heading: 'Evidence' }, { id: 'attack-path', heading: 'Attack path' },
    ];
    const sections = [];
    for (const spec of SECTIONS) {
      const a = document.querySelector('a[href="#' + spec.id + '"]');
      const c = a ? a.closest('section, div') : document.getElementById(spec.id);
      const text = c instanceof HTMLElement ? normalize(c.innerText) : '';
      if (text) sections.push({ id: spec.id, heading: spec.heading, text });
    }
    const h = main.querySelector('h1, h2');
    const title = h instanceof HTMLElement ? normalize(h.innerText) : '';
    const repo = [...main.querySelectorAll('a[href*="/commit/"]')]
      .map((a) => a.getAttribute('href')).find((x) => typeof x === 'string' && x.length > 0) || null;
    const files = [...new Set(
      [...document.querySelectorAll('a[href*="/blob/"]')]
        .map((a) => a.getAttribute('href')).filter((x) => typeof x === 'string' && x.length > 0)
    )];
    const validationArtifact = [...document.querySelectorAll('a')]
      .map((a) => a.getAttribute('href'))
      .find((x) => typeof x === 'string' && /oaiusercontent\\.com\\/files\\//u.test(x)) || null;
    if (sections.length === 0 && !title) return { ok: false, error: 'Finding detail has no readable sections or title yet.' };
    return { ok: true, detail: { title, repo, sections, files, validationArtifact } };
  })()`;
}

export async function waitForFindingDetailReady(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "unknown";
  while (Date.now() < deadline) {
    const outcome = await runtime
      .evaluate({ expression: buildFindingDetailReadyExpression(), returnByValue: true })
      .catch((error) => ({
        result: {
          value: { ready: false, reason: error instanceof Error ? error.message : String(error) },
        },
      }));
    const value = outcome.result?.value as { ready?: boolean; reason?: string } | undefined;
    if (value?.ready === true) {
      return;
    }
    lastReason = value?.reason ?? lastReason;
    await delay(250);
  }
  logger(`Finding detail did not become ready before timeout (${lastReason})`);
  throw new Error("Finding detail did not become ready before timeout.");
}

export async function readFindingDetail(
  runtime: Runtime,
  findingId: string,
): Promise<CodexFindingDetail> {
  const outcome = await runtime.evaluate({
    expression: buildFindingDetailExpression(),
    returnByValue: true,
  });
  const value = outcome.result?.value as
    | {
        ok?: boolean;
        error?: string;
        detail?: {
          title: string;
          repo: string | null;
          sections: CodexFindingDetailSection[];
          files: string[];
          validationArtifact: string | null;
        };
      }
    | undefined;
  if (!value?.ok || !value.detail) {
    throw new Error(value?.error ?? "Unable to read the finding detail.");
  }
  const detail = value.detail;
  return {
    finding: {
      id: findingId,
      selectionId: findingId,
      title: detail.title,
      severity: "unknown",
      index: 0,
    },
    title: detail.title,
    repo: detail.repo,
    sections: Array.isArray(detail.sections) ? detail.sections : [],
    files: Array.isArray(detail.files) ? detail.files : [],
    validationArtifact: detail.validationArtifact ?? null,
  };
}

function actionButtonName(action: CodexFindingAction | "submit"): string {
  switch (action) {
    case "create-pr":
      return "Create PR";
    case "chat":
      return "Chat";
    case "close":
      return "Close";
    case "adjust":
      return "Adjust";
    case "copy-content":
      return "Copy finding content";
    case "copy-link":
      return "Copy finding link";
    case "copy-patch":
    case "copy-git-apply":
      return "Open git action menu";
    case "submit":
      return "Submit";
  }
}

export function buildFindingActionTargetExpression(action: CodexFindingAction): string {
  return buildButtonTargetExpression(actionButtonName(action));
}

function buildButtonTargetExpression(name: string): string {
  return `(() => {
    const wanted = ${JSON.stringify(name)};
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const labelFor = (node) => (node.getAttribute('aria-label') || node.innerText || '').trim();
    const panel = [...document.querySelectorAll('section')].find((section) =>
      section.querySelector('a[href="#summary"]') &&
      [...section.querySelectorAll('button')].some((node) => labelFor(node) === wanted && visible(node)),
    );
    if (!panel) return { ok: false, reason: 'finding action panel not found' };
    const nodes = [...panel.querySelectorAll('button')];
    const button = nodes.find((node) => {
      const label = labelFor(node);
      return label === wanted && visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    });
    if (!button) return { ok: false, reason: 'button not found: ' + wanted };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

function buildFindingActionStateExpression(): string {
  return `(() => {
    const panel = [...document.querySelectorAll('section')].find((section) =>
      section.querySelector('a[href="#summary"]') &&
      section.querySelector('button'),
    );
    const panelText = panel?.innerText || '';
    const labels = panel ? [...panel.querySelectorAll('button')].map((node) =>
      (node.getAttribute('aria-label') || node.innerText || '').trim(),
    ) : [];
    const liveText = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')]
      .map((node) => node.innerText || node.textContent || '')
      .join('\\n');
    const menuOpen = document.querySelector('[role="menu"], [data-radix-popper-content-wrapper]') !== null;
    const dialogText = [...document.querySelectorAll('[role="dialog"]')]
      .map((node) => node.innerText || '')
      .join('\\n');
    return {
      panelText,
      liveText,
      dialogText,
      menuOpen,
      hasClose: labels.includes('Close'),
      hasSubmit: labels.includes('Submit'),
      pr: [...document.querySelectorAll('a[href*="/pull/"]')].map((a) => a.href)[0] || null,
    };
  })()`;
}

type FindingActionState = {
  panelText?: string;
  liveText?: string;
  dialogText?: string;
  menuOpen?: boolean;
  hasClose?: boolean;
  hasSubmit?: boolean;
  pr?: string | null;
};

async function readFindingActionState(runtime: Runtime): Promise<FindingActionState> {
  const evaluated = await runtime.evaluate({
    expression: buildFindingActionStateExpression(),
    returnByValue: true,
  });
  const value = evaluated.result?.value as FindingActionState | undefined;
  if (!value) {
    const description =
      evaluated.exceptionDetails?.exception?.description ??
      evaluated.exceptionDetails?.text ??
      "no state returned";
    throw new Error(`Unable to read finding action panel state: ${description}`);
  }
  return value;
}

async function waitForFindingActionPostcondition(
  runtime: Runtime,
  action: CodexFindingAction,
  before: FindingActionState,
  timeoutMs: number,
): Promise<FindingActionState> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  let state = await readFindingActionState(runtime);
  while (Date.now() < deadline) {
    const liveChanged = state.liveText !== before.liveText;
    const panelChanged = state.panelText !== before.panelText;
    const copied = /copied|clipboard/iu.test(state.liveText ?? "");
    const complete =
      action === "copy-content" || action === "copy-link"
        ? copied
        : action === "copy-patch" || action === "copy-git-apply"
          ? state.menuOpen === false
          : action === "chat"
            ? state.hasSubmit === false || panelChanged || liveChanged
            : action === "close"
              ? state.hasClose === false || /closed/iu.test(state.panelText ?? "") || panelChanged
              : action === "adjust"
                ? Boolean(state.dialogText) || panelChanged || liveChanged
                : Boolean(state.pr) || Boolean(state.dialogText);
    if (complete) return state;
    await delay(250);
    state = await readFindingActionState(runtime);
  }
  throw new Error(`Finding action ${action} did not produce its expected UI result.`);
}

function buildNamedButtonTargetExpression(name: string): string {
  return buildButtonTargetExpression(name);
}

async function clickTrustedPoint(
  runtime: Runtime,
  input: Input,
  x: number,
  y: number,
): Promise<void> {
  if (input && typeof input.dispatchMouseEvent === "function") {
    await input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return;
  }
  throw new Error("Trusted browser input is unavailable; refusing to trigger a finding action.");
}

async function clickFindingActionButton(
  runtime: Runtime,
  input: Input,
  action: CodexFindingAction,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reason = "button not found";
  while (Date.now() < deadline) {
    const value = (
      await runtime.evaluate({
        expression: buildFindingActionTargetExpression(action),
        returnByValue: true,
      })
    ).result?.value as { ok?: boolean; x?: number; y?: number; reason?: string } | undefined;
    if (value?.ok && typeof value.x === "number" && typeof value.y === "number") {
      await clickTrustedPoint(runtime, input, value.x, value.y);
      return;
    }
    reason = value?.reason ?? reason;
    await delay(250);
  }
  throw new Error(`Finding action ${action} was not ready: ${reason}`);
}

async function clickNamedButton(
  runtime: Runtime,
  input: Input,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reason = "button not found";
  while (Date.now() < deadline) {
    const value = (
      await runtime.evaluate({
        expression: buildNamedButtonTargetExpression(name),
        returnByValue: true,
      })
    ).result?.value as { ok?: boolean; x?: number; y?: number; reason?: string } | undefined;
    if (value?.ok && typeof value.x === "number" && typeof value.y === "number") {
      await clickTrustedPoint(runtime, input, value.x, value.y);
      return;
    }
    reason = value?.reason ?? reason;
    await delay(250);
  }
  throw new Error(`Finding button ${name} was not ready: ${reason}`);
}

async function openGitActionMenu(runtime: Runtime, input: Input, timeoutMs: number): Promise<void> {
  await clickNamedButton(runtime, input, "Open git action menu", timeoutMs);
}

async function fillFindingChat(runtime: Runtime, text: string): Promise<void> {
  const expression = `(() => {
    const input = document.querySelector('textarea[placeholder="Ask a question or add context (optional)"]');
    if (!(input instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)}, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  const value = (await runtime.evaluate({ expression, returnByValue: true })).result?.value;
  if (value !== true) throw new Error("Finding chat composer was not found.");
}

export async function executeFindingAction(
  runtime: Runtime,
  input: Input,
  action: CodexFindingAction,
  actionText: string | undefined,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<FindingActionResult> {
  const before = await readFindingActionState(runtime);
  if (action === "create-pr") {
    await openGitActionMenu(runtime, input, timeoutMs);
    const existing = (
      await runtime.evaluate({
        expression: `(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.innerText || '').trim() === 'View PR');
        if (!(item instanceof HTMLElement)) return null;
        const link = item.closest('a')?.href || item.querySelector('a')?.href || null;
        return { link };
      })()`,
        returnByValue: true,
      })
    ).result?.value as { link?: string | null } | null | undefined;
    if (existing) {
      await input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
      await input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
      return {
        status: "existing-pr",
        message: "A PR already exists for this finding.",
        url: existing.link ?? undefined,
      };
    }
    await input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
    await input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  }
  await clickFindingActionButton(runtime, input, action, timeoutMs);
  if (action === "chat") {
    if (!actionText?.trim()) throw new Error("chat requires --text");
    await fillFindingChat(runtime, actionText);
    await clickNamedButton(runtime, input, "Submit", timeoutMs);
  }
  if (action === "copy-patch" || action === "copy-git-apply") {
    const menuText = action === "copy-patch" ? "Copy patch" : "Copy git apply";
    const expression = `(() => {
      const wanted = ${JSON.stringify(menuText)};
      const node = [...document.querySelectorAll('[role="menuitem"]')].find((el) => (el.innerText || '').trim() === wanted);
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`;
    const value = (await runtime.evaluate({ expression, returnByValue: true })).result?.value as
      | { x?: number; y?: number }
      | null
      | undefined;
    if (!value || typeof value.x !== "number" || typeof value.y !== "number") {
      throw new Error(`Finding git menu item was not found: ${menuText}`);
    }
    await clickTrustedPoint(runtime, input, value.x, value.y);
  }
  const state = await waitForFindingActionPostcondition(runtime, action, before, timeoutMs);
  logger(`[codex] finding action completed: ${action}`);
  return {
    status: "ok",
    message: state.dialogText ?? (action === "create-pr" && state.pr ? "PR created" : undefined),
    url: state.pr ?? undefined,
    text: state.panelText,
  };
}
