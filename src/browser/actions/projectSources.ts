import path from "node:path";
import type { BrowserAttachment, BrowserLogger, ChromeClient } from "../types.js";
import type { ProjectSourceEntry } from "../../projectSources/types.js";
import {
  PROJECT_SOURCES_MAX_UPLOAD_BATCH,
  buildProjectSourcesUploadPlan,
} from "../../projectSources/plan.js";
import { delay } from "../utils.js";

const PROJECT_SOURCES_INPUT_MARKER = "data-oracle-project-sources-input";

type Runtime = ChromeClient["Runtime"];
type Dom = ChromeClient["DOM"];
type Input = ChromeClient["Input"];

export async function waitForProjectSourcesReady(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const status = await readProjectSourcesSurfaceStatus(runtime).catch((error) => ({
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    lastStatus = status.reason ?? "unknown";
    if (status.ready) {
      return;
    }
    await delay(250);
  }
  logger(`Project Sources tab did not become ready before timeout (${lastStatus})`);
  throw new Error("Project Sources tab did not become ready before timeout.");
}

export async function openProjectSourcesTab(
  runtime: Runtime,
  input: Input | undefined,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "sources tab not found";
  while (Date.now() < deadline) {
    const locate = await runtime.evaluate({
      expression: buildOpenProjectSourcesTabExpression(),
      returnByValue: true,
    });
    const point = locate.result?.value as
      | { ok?: boolean; alreadyOpen?: boolean; x?: number; y?: number; reason?: string }
      | undefined;
    if (point?.alreadyOpen) {
      return;
    }
    if (point?.ok && typeof point.x === "number" && typeof point.y === "number") {
      await clickPoint(runtime, input, point.x, point.y);
      await delay(500);
      return;
    }
    lastReason = point?.reason ?? lastReason;
    await delay(250);
  }
  logger(`Project Sources tab did not become selectable before timeout (${lastReason})`);
  throw new Error("Project Sources tab did not become selectable before timeout.");
}

async function readProjectSourcesSurfaceStatus(
  runtime: Runtime,
): Promise<{ ready: boolean; reason?: string }> {
  const outcome = await runtime.evaluate({
    expression: buildProjectSourcesReadyExpression(),
    returnByValue: true,
  });
  const value = outcome.result?.value as { ready?: boolean; reason?: string } | undefined;
  return {
    ready: value?.ready === true,
    reason: typeof value?.reason === "string" ? value.reason : undefined,
  };
}

export async function listProjectSources(runtime: Runtime): Promise<ProjectSourceEntry[]> {
  const outcome = await runtime.evaluate({
    expression: buildProjectSourcesListExpression(),
    returnByValue: true,
  });
  const value = outcome.result?.value as
    | { ok?: boolean; sources?: ProjectSourceEntry[]; error?: string }
    | undefined;
  if (!value?.ok) {
    throw new Error(value?.error ?? "Unable to read ChatGPT project sources.");
  }
  return Array.isArray(value.sources) ? value.sources.filter(isProjectSourceEntry) : [];
}

export async function waitForProjectSourcesListSettled(
  runtime: Runtime,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<ProjectSourceEntry[]> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  const startedAt = Date.now();
  let previousKey: string | null = null;
  let stableSince = Date.now();
  let latest: ProjectSourceEntry[] = [];
  while (Date.now() < deadline) {
    latest = await listProjectSources(runtime);
    const key = latest.map((source) => source.name).join("\n");
    if (key !== previousKey) {
      previousKey = key;
      stableSince = Date.now();
    }
    const stableForMs = Date.now() - stableSince;
    const observedForMs = Date.now() - startedAt;
    if (observedForMs >= 2500 && stableForMs >= 700) {
      return latest;
    }
    await delay(300);
  }
  logger("Project Sources list did not settle before timeout; returning latest observed list.");
  return latest;
}

export async function uploadProjectSources(
  deps: {
    runtime: Runtime;
    dom?: Dom;
    input?: Input;
  },
  attachments: BrowserAttachment[],
  logger: BrowserLogger,
  timeoutMs: number,
): Promise<ProjectSourceEntry[]> {
  const { runtime, dom, input } = deps;
  if (!dom) {
    throw new Error("Chrome DOM domain unavailable while uploading project sources.");
  }
  if (attachments.length === 0) {
    return await listProjectSources(runtime);
  }

  const plan = buildProjectSourcesUploadPlan(attachments);
  let latestSources = await listProjectSources(runtime);
  for (let offset = 0; offset < attachments.length; offset += PROJECT_SOURCES_MAX_UPLOAD_BATCH) {
    const batch = attachments.slice(offset, offset + PROJECT_SOURCES_MAX_UPLOAD_BATCH);
    const batchIndex = Math.floor(offset / PROJECT_SOURCES_MAX_UPLOAD_BATCH) + 1;
    const batchNames = batch.map((file) => path.basename(file.path));
    logger(
      `Uploading project source batch ${batchIndex} (${batch.length} file${batch.length === 1 ? "" : "s"})`,
    );

    await openProjectSourcesAddDialog(runtime, input);
    await waitForUploadInput(runtime, Math.min(timeoutMs, 30_000));
    await markProjectSourcesUploadInput(runtime);

    const documentNode = await dom.getDocument({ depth: 5 });
    const query = await dom.querySelector({
      nodeId: documentNode.root.nodeId,
      selector: `input[${PROJECT_SOURCES_INPUT_MARKER}="1"]`,
    });
    if (!query.nodeId) {
      throw new Error("Unable to locate the Project Sources upload input.");
    }
    await dom.setFileInputFiles({ nodeId: query.nodeId, files: batch.map((file) => file.path) });
    await runtime.evaluate({
      expression: `(() => {
        const input = document.querySelector('input[${PROJECT_SOURCES_INPUT_MARKER}="1"]');
        if (!(input instanceof HTMLInputElement)) return false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
    await clickProjectSourcesUploadConfirmation(runtime, input).catch(() => false);

    latestSources = await waitForUploadedProjectSources(
      runtime,
      latestSources,
      batchNames,
      timeoutMs,
    );
  }

  logger(
    `Project source upload complete (${plan.length} planned file${plan.length === 1 ? "" : "s"}).`,
  );
  return latestSources;
}

export async function openProjectSourcesAddDialog(runtime: Runtime, input?: Input): Promise<void> {
  const locate = await runtime.evaluate({
    expression: buildOpenProjectSourcesAddDialogExpression(),
    returnByValue: true,
  });
  const point = locate.result?.value as
    | { ok?: boolean; alreadyOpen?: boolean; x?: number; y?: number; reason?: string }
    | undefined;
  if (!point?.ok) {
    throw new Error(point?.reason ?? "Unable to open the Project Sources Add dialog.");
  }
  if (point.alreadyOpen) {
    return;
  }
  if (typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error("Unable to locate the Project Sources Add control.");
  }
  await clickPoint(runtime, input, point.x, point.y);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await runtime.evaluate({
      expression: buildProjectSourcesDialogReadyExpression(),
      returnByValue: true,
    });
    if (ready.result?.value === true) {
      return;
    }
    await delay(200);
  }
  throw new Error("Project Sources Add dialog did not open.");
}

export async function markProjectSourcesUploadInput(runtime: Runtime): Promise<void> {
  const outcome = await runtime.evaluate({
    expression: buildMarkProjectSourcesUploadInputExpression(PROJECT_SOURCES_INPUT_MARKER),
    returnByValue: true,
  });
  const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
  if (!value?.ok) {
    throw new Error(value?.reason ?? "Project Sources upload input did not appear.");
  }
}

async function waitForUploadInput(runtime: Runtime, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await runtime.evaluate({
      expression: buildMarkProjectSourcesUploadInputExpression(PROJECT_SOURCES_INPUT_MARKER),
      returnByValue: true,
    });
    if ((found.result?.value as { ok?: boolean } | undefined)?.ok === true) {
      return;
    }
    await delay(200);
  }
  throw new Error("Project Sources upload input did not appear.");
}

async function waitForUploadedProjectSources(
  runtime: Runtime,
  beforeBatch: ProjectSourceEntry[],
  expectedNames: string[],
  timeoutMs: number,
): Promise<ProjectSourceEntry[]> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  const beforeCounts = countSourceNames(beforeBatch);
  let latestSources = beforeBatch;
  while (Date.now() < deadline) {
    latestSources = await listProjectSources(runtime);
    const currentCounts = countSourceNames(latestSources);
    const ready = hasUploadedProjectSourceBatch(beforeCounts, currentCounts, expectedNames);
    if (ready) {
      return latestSources;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for uploaded project sources: ${expectedNames.join(", ")}`);
}

async function clickProjectSourcesUploadConfirmation(
  runtime: Runtime,
  input?: Input,
): Promise<boolean> {
  const locate = await runtime.evaluate({
    expression: buildProjectSourcesConfirmationButtonExpression(),
    returnByValue: true,
  });
  const point = locate.result?.value as { ok?: boolean; x?: number; y?: number } | undefined;
  if (!point?.ok || typeof point.x !== "number" || typeof point.y !== "number") {
    return false;
  }
  await clickPoint(runtime, input, point.x, point.y);
  return true;
}

async function clickPoint(
  runtime: Runtime,
  input: Input | undefined,
  x: number,
  y: number,
): Promise<void> {
  if (input && typeof input.dispatchMouseEvent === "function") {
    await input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return;
  }
  await runtime.evaluate({
    expression: `(() => {
      const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
    returnByValue: true,
  });
}

function countSourceNames(sources: ProjectSourceEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    counts.set(source.name, (counts.get(source.name) ?? 0) + 1);
  }
  return counts;
}

function hasUploadedProjectSourceBatch(
  beforeCounts: Map<string, number>,
  currentCounts: Map<string, number>,
  expectedNames: string[],
): boolean {
  const expectedCounts = new Map<string, number>();
  for (const name of expectedNames) {
    expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
  }
  for (const [name, expectedCount] of expectedCounts) {
    const before = beforeCounts.get(name) ?? 0;
    const current = currentCounts.get(name) ?? 0;
    if (current < before + expectedCount) {
      return false;
    }
  }
  return true;
}

export function hasUploadedProjectSourceBatchForTest(
  before: ProjectSourceEntry[],
  current: ProjectSourceEntry[],
  expectedNames: string[],
): boolean {
  return hasUploadedProjectSourceBatch(
    countSourceNames(before),
    countSourceNames(current),
    expectedNames,
  );
}

function isProjectSourceEntry(value: unknown): value is ProjectSourceEntry {
  const entry = value as ProjectSourceEntry;
  return Boolean(entry) && typeof entry.name === "string" && typeof entry.index === "number";
}

export function buildProjectSourcesReadyExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const bodyText = normalize(document.body?.innerText || document.body?.textContent || '');
    const selectedSourceTab = Array.from(document.querySelectorAll('[role="tab"],button,[aria-selected]')).some((node) => {
      const label = normalize(node.textContent || node.getAttribute?.('aria-label') || '');
      const selected =
        node.getAttribute?.('aria-selected') === 'true' ||
        node.getAttribute?.('data-state') === 'active' ||
        /\\bactive\\b/i.test(node.getAttribute?.('class') || '');
      return visible(node) && selected && (label === 'sources' || label === 'źródła' || label === 'zrodla');
    });
    const addSurface = Array.from(document.querySelectorAll('button,[role="button"]')).some((node) => {
      const label = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || '');
      return visible(node) && /^(add source|add sources|dodaj źródła|dodaj zrodla)$/u.test(label);
    });
    if (selectedSourceTab || addSurface) return { ready: true };
    if (bodyText.includes('new chat') || bodyText.includes('nowy czat')) return { ready: false, reason: 'project page loaded but sources tab not visible' };
    return { ready: false, reason: 'sources surface not detected' };
  })()`;
}

export function buildProjectSourcesDialogReadyExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('[role="dialog"],dialog')).some((dialog) => {
      if (!(dialog instanceof HTMLElement)) return false;
      const text = normalize(dialog.innerText || dialog.textContent || '');
      return text.includes('add source') || text.includes('add sources') || text.includes('dodaj źródła') || text.includes('dodaj zrodla') || text.includes('przeciągnij źródła') || text.includes('przeciagnij zrodla');
    });
  })()`;
}

export function buildProjectSourcesListExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => normalize(value).toLowerCase();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const isChromeLabel = (label) => {
      const text = lower(label);
      return (
        !text ||
        text === 'sources' ||
        text === 'źródła' ||
        text === 'zrodla' ||
        text === 'chats' ||
        text === 'czaty' ||
        text === 'all' ||
        text === 'wszystkie' ||
        text === 'add' ||
        text === 'add sources' ||
        text === 'dodaj' ||
        text === 'dodaj źródła' ||
        text === 'dodaj zrodla' ||
        text === 'source actions' ||
        text === 'actions' ||
        text === 'share' ||
        text === 'udostępnij' ||
        text === 'udostepnij' ||
        text === 'add files and more' ||
        text === 'chat with chatgpt' ||
        text === 'ask anything' ||
        text === 'pro' ||
        text === 'voice' ||
        text === 'start voice' ||
        text === 'start dictation'
      );
    };
    const hasLikelyFileName = (label) => /\\.[a-z0-9]{1,12}(?:\\s|$)/iu.test(label);
    const cleanSourceName = (label) => {
      const text = normalize(label);
      return text
        .replace(/(?:file|document|spreadsheet|presentation|pdf|plik|dokument)\\s*·.*$/iu, '')
        .trim();
    };
    const panel =
      document.querySelector('[role="tabpanel"][id*="source" i]') ||
      document.querySelector('[data-testid*="source" i]') ||
      document.querySelector('main') ||
      document.body;
    if (!(panel instanceof HTMLElement)) {
      return { ok: false, error: 'Project Sources panel not found.' };
    }
    const candidates = Array.from(panel.querySelectorAll('[aria-label], [title], a, button, [role="listitem"], [data-testid*="source" i], [class*="file" i], [class*="source" i]'))
      .filter((node) => node instanceof HTMLElement && visible(node))
      .map((node) => {
        const raw = normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '');
        const rect = node.getBoundingClientRect();
        return {
          node,
          raw,
          name: cleanSourceName(raw),
          hasMetadata: raw !== cleanSourceName(raw),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
        };
      });
    const plainNames = new Set(candidates.filter((candidate) => !candidate.hasMetadata).map((candidate) => candidate.name));
    const rows = [];
    for (const node of candidates) {
      const raw = node.raw;
      const name = node.name;
      if (node.hasMetadata && plainNames.has(name)) continue;
      if (isChromeLabel(name)) continue;
      if (!node.hasMetadata && !hasLikelyFileName(name)) continue;
      if (name.length < 2 || name.length > 200) continue;
      if (/^(pdf|docx?|txt|md|csv|xlsx?|json)$/iu.test(name)) continue;
      if (/^(copy|edit|remove|delete|pobierz|usuń|usun)$/iu.test(name)) continue;
      if (/^(file|document|spreadsheet|presentation|plik|dokument)$/iu.test(name)) continue;
      rows.push(node);
    }
    const sources = [];
    const seen = new Set();
    for (const row of rows) {
      const key = row.name + '|' + row.top + '|' + row.left;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ name: row.name, index: sources.length, status: 'unknown' });
    }
    return { ok: true, sources };
  })()`;
}

export function buildOpenProjectSourcesTabExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const controls = Array.from(document.querySelectorAll('[role="tab"],button,a,[aria-selected]'));
    const sourceTab = controls.find((node) => {
      if (!visible(node)) return false;
      const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
      return label === 'sources' || label === 'źródła' || label === 'zrodla';
    });
    if (!(sourceTab instanceof HTMLElement)) {
      return { ok: false, reason: 'Project Sources tab control not found.' };
    }
    const selected =
      sourceTab.getAttribute('aria-selected') === 'true' ||
      sourceTab.getAttribute('data-state') === 'active' ||
      /\\bactive\\b/i.test(sourceTab.getAttribute('class') || '');
    if (selected) return { ok: true, alreadyOpen: true };
    sourceTab.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = sourceTab.getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

export function buildOpenProjectSourcesAddDialogExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    if (${buildProjectSourcesDialogReadyExpression().replace(/\n/g, " ")}) return { ok: true, alreadyOpen: true };
    const roots = [
      document.querySelector('[role="tabpanel"][id*="source" i]'),
      document.querySelector('[data-testid*="source" i]'),
      document.querySelector('main'),
      document.body,
    ].filter(Boolean);
    const controls = roots.flatMap((root) => Array.from(root.querySelectorAll('button,[role="button"],a,label')));
    const add = controls.find((node) => {
      if (!visible(node)) return false;
      const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
      return label === 'add source' || label === 'add sources' || label === 'dodaj źródła' || label === 'dodaj zrodla';
    });
    if (!(add instanceof HTMLElement)) return { ok: false, reason: 'Project Sources add control not found.' };
    add.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = add.getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

export function buildMarkProjectSourcesUploadInputExpression(marker: string): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const dialog = Array.from(document.querySelectorAll('[role="dialog"],dialog')).find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const text = normalize(node.innerText || node.textContent || '');
      return text.includes('add source') || text.includes('add sources') || text.includes('dodaj źródła') || text.includes('dodaj zrodla') || text.includes('przeciągnij źródła') || text.includes('przeciagnij zrodla');
    });
    if (!dialog) return { ok: false, reason: 'Project Sources Add dialog missing' };
    const roots = [dialog];
    const input = roots
      .flatMap((root) => Array.from(root.querySelectorAll('input[type="file"]')))
      .find((node) => node instanceof HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'file input missing' };
    Array.from(document.querySelectorAll('input[${marker}]')).forEach((node) => node.removeAttribute('${marker}'));
    input.setAttribute('${marker}', '1');
    return { ok: true };
  })()`;
}

export function buildProjectSourcesConfirmationButtonExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const labels = new Set(['upload anyway', 'upload', 'add', 'continue', 'prześlij', 'przeslij', 'dodaj', 'kontynuuj']);
    const roots = Array.from(document.querySelectorAll('[role="dialog"],dialog')).filter((node) => node instanceof HTMLElement);
    const buttons = (roots.length > 0 ? roots : [document.body]).flatMap((root) => Array.from(root.querySelectorAll('button,[role="button"]')));
    const button = buttons.find((node) => {
      if (!visible(node)) return false;
      const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title'));
      return labels.has(label);
    });
    if (!(button instanceof HTMLElement)) return { ok: false };
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}
