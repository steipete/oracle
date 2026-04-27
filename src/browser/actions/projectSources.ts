import path from "node:path";
import type {
  BrowserAttachment,
  BrowserLogger,
  BrowserProjectSourcesOperation,
  BrowserProjectSourcesResult,
  ChromeClient,
} from "../types.js";
import {
  PROJECT_SOURCES_ADD_BUTTON_SELECTORS,
  PROJECT_SOURCES_DIALOG_SELECTOR,
  PROJECT_SOURCES_FILE_ROW_SELECTORS,
  PROJECT_SOURCES_PANEL_SELECTORS,
  PROJECT_SOURCES_UPLOAD_INPUT_SELECTOR,
  PROJECT_SOURCES_UPLOAD_ANYWAY_BUTTON_SELECTORS,
} from "../constants.js";
import { delay } from "../utils.js";

const PROJECT_SOURCES_INPUT_MARKER = "data-oracle-project-sources-input";
export const PROJECT_SOURCES_MAX_UPLOAD_BATCH = 10;

export function normalizeProjectSourcesUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("tab", "sources");
  return url.toString();
}

export function summarizeProjectSourcesResult(
  result: BrowserProjectSourcesResult,
): { answerText: string; answerMarkdown: string } {
  const lines = [
    `Project sources ${result.operation} completed.`,
    `Before: ${result.beforeNames.length}`,
    `After: ${result.afterNames.length}`,
    `Added: ${result.addedNames.length > 0 ? result.addedNames.join(", ") : "(none)"}`,
    `Deleted: ${result.deletedNames.length > 0 ? result.deletedNames.join(", ") : "(none)"}`,
  ];
  return {
    answerText: lines.join("\n"),
    answerMarkdown: lines.join("\n"),
  };
}

export async function waitForProjectSourcesReady(
  runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await runtime
      .evaluate({
        expression: `(() => {
          const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
          const buttons = Array.from(document.querySelectorAll('button,[role="button"],a'));
          const addVisible = buttons.some((node) => {
            if (!(node instanceof HTMLElement)) return false;
            const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
            if (label !== 'add' && label !== 'add sources') return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          const sourcesVisible = buttons.some((node) => normalize(node.textContent) === 'sources');
          return addVisible && sourcesVisible;
        })()`,
        returnByValue: true,
      })
      .catch(() => null);
    if (ready?.result?.value === true) {
      return;
    }
    await delay(250);
  }
  logger("Project Sources tab did not become ready before timeout");
  throw new Error("Project Sources tab did not become ready before timeout.");
}

export async function listProjectSources(
  runtime: ChromeClient["Runtime"],
): Promise<string[]> {
  const outcome = await runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').trim();
      const addButton = Array.from(document.querySelectorAll('button')).find(
        (node) => normalize(node.textContent) === 'Add sources',
      );
      const addSection = addButton?.closest('section');
      const panels = ${JSON.stringify(PROJECT_SOURCES_PANEL_SELECTORS)}
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const uniquePanels = Array.from(new Set(panels));
      const roots = addSection ? [addSection] : uniquePanels;
      const names = roots
        .flatMap((root) =>
          ${JSON.stringify(PROJECT_SOURCES_FILE_ROW_SELECTORS)}.flatMap((selector) =>
            Array.from(root.querySelectorAll(selector)),
          ),
        )
        .map((row) => {
          const labelNode = Array.from(row.querySelectorAll('[aria-label]')).find((node) => {
            const label = normalize(node.getAttribute('aria-label'));
            return label.length > 0 && label !== 'Source actions';
          });
          return labelNode?.getAttribute('aria-label') || '';
        })
        .map((name) => name.trim())
        .filter(Boolean);
      return Array.from(new Set(names));
    })()`,
    returnByValue: true,
  });
  return Array.isArray(outcome.result?.value)
    ? outcome.result.value.filter((value): value is string => typeof value === "string")
    : [];
}

export async function openProjectSourcesAddDialog(
  runtime: ChromeClient["Runtime"],
  input?: ChromeClient["Input"],
): Promise<void> {
  const locate = await runtime.evaluate({
    expression: `(() => {
      const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_DIALOG_SELECTOR)}));
      const existingDialog = dialogs.find((node) => (node.textContent || '').includes('Add sources'));
      if (existingDialog) return { ok: true, alreadyOpen: true };
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const panels = ${JSON.stringify(PROJECT_SOURCES_PANEL_SELECTORS)}
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const uniquePanels = Array.from(new Set(panels));
      const addSelectors = ${JSON.stringify(PROJECT_SOURCES_ADD_BUTTON_SELECTORS)};
      const addBySelector = addSelectors
        .map((selector) => document.querySelector(selector))
        .find((node) => node instanceof HTMLElement && isVisible(node));
      const addByPanelText = uniquePanels
        .flatMap((panel) => Array.from(panel.querySelectorAll('button,[role="button"],a')))
        .find((node) => {
          if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
          const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
          return label === 'add' || label === 'add sources';
        });
      const addByText = Array.from(document.querySelectorAll('button,[role="button"],a')).find((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const label = normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
        return label === 'add' || label === 'add sources';
      });
      const add = addByPanelText || addBySelector || addByText;
      if (!(add instanceof HTMLElement)) return { ok: false };
      add.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = add.getBoundingClientRect();
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
    returnByValue: true,
  });
  const point = locate.result?.value as
    | { ok?: boolean; x?: number; y?: number; alreadyOpen?: boolean }
    | undefined;
  if (!point?.ok) {
    throw new Error("Unable to open the Project Sources Add dialog.");
  }
  if (point.alreadyOpen) {
    return;
  }
  if (typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error("Unable to locate the Project Sources Add control.");
  }

  if (input && typeof input.dispatchMouseEvent === "function") {
    await input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  } else {
    await runtime.evaluate({
      expression: `(() => {
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const panels = ${JSON.stringify(PROJECT_SOURCES_PANEL_SELECTORS)}
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        const uniquePanels = Array.from(new Set(panels));
        const add = uniquePanels
          .flatMap((panel) => Array.from(panel.querySelectorAll('button,[role="button"],a')))
          .find((node) => {
            const label = normalize(node.textContent || node.getAttribute('aria-label'));
            return label === 'add' || label === 'add sources';
          });
        if (!(add instanceof HTMLElement)) return false;
        add.click();
        return true;
      })()`,
      returnByValue: true,
    });
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const open = await runtime.evaluate({
      expression: `(() => {
        const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_DIALOG_SELECTOR)}));
        return dialogs.some((node) => (node.textContent || '').includes('Add sources'));
      })()`,
      returnByValue: true,
    });
    if (open.result?.value === true) {
      return;
    }
    await delay(200);
  }
  throw new Error("Project Sources Add dialog did not open.");
}

export async function clickProjectSourcesDropzone(
  runtime: ChromeClient["Runtime"],
  input?: ChromeClient["Input"],
): Promise<void> {
  const locate = await runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_DIALOG_SELECTOR)}))
        .filter((node) => (node.textContent || '').includes('Add sources'));
      const dialog = dialogs[0];
      if (!(dialog instanceof HTMLElement)) return { ok: false };
      const dropzone = Array.from(dialog.querySelectorAll('div,[role="presentation"]')).find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return normalize(node.innerText || node.textContent || node.getAttribute('aria-label')).includes('drag sources here');
      });
      if (!(dropzone instanceof HTMLElement)) return { ok: false };
      dropzone.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = dropzone.getBoundingClientRect();
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
    returnByValue: true,
  });
  const point = locate.result?.value as { ok?: boolean; x?: number; y?: number } | undefined;
  if (!point?.ok || typeof point.x !== "number" || typeof point.y !== "number") {
    return;
  }
  if (input && typeof input.dispatchMouseEvent === "function") {
    await input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    return;
  }
  await runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const dialog = Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_DIALOG_SELECTOR)}))
        .find((node) => (node.textContent || '').includes('Add sources'));
      if (!(dialog instanceof HTMLElement)) return false;
      const dropzone = Array.from(dialog.querySelectorAll('div,[role="presentation"]')).find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        return normalize(node.textContent || node.getAttribute('aria-label')).includes('drag sources here');
      });
      if (!(dropzone instanceof HTMLElement)) return false;
      dropzone.click();
      return true;
    })()`,
    returnByValue: true,
  });
}

export async function markProjectSourcesUploadInput(
  runtime: ChromeClient["Runtime"],
  options?: { preferDialog?: boolean },
): Promise<boolean> {
  const outcome = await runtime.evaluate({
    expression: `(() => {
      const preferDialog = ${options?.preferDialog === true ? "true" : "false"};
      const normalize = (value) => String(value || '').trim();
      const findPanelInput = () => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (node) => normalize(node.textContent) === 'Add sources',
        );
        const section = button?.closest('section');
        const input = section?.querySelector('input[type="file"][multiple]') ||
          section?.querySelector(${JSON.stringify(PROJECT_SOURCES_UPLOAD_INPUT_SELECTOR)});
        return input instanceof HTMLInputElement ? input : null;
      };
      const findDialogInput = () => {
        const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_DIALOG_SELECTOR)}))
          .filter((node) => (node.textContent || '').includes('Add sources'));
        const dialog = dialogs[0];
        if (!(dialog instanceof HTMLElement)) return null;
        const input = Array.from(dialog.querySelectorAll(${JSON.stringify(PROJECT_SOURCES_UPLOAD_INPUT_SELECTOR)}))
          .find((node) => node instanceof HTMLInputElement && node.type === 'file') ||
          Array.from(dialog.querySelectorAll('input[type="file"]')).find(
            (node) => node instanceof HTMLInputElement,
          );
        return input instanceof HTMLInputElement ? input : null;
      };
      const input = preferDialog ? (findDialogInput() || findPanelInput()) : (findPanelInput() || findDialogInput());
      if (!(input instanceof HTMLInputElement)) return false;
      Array.from(document.querySelectorAll('input[' + ${JSON.stringify(PROJECT_SOURCES_INPUT_MARKER)} + ']'))
        .forEach((node) => node.removeAttribute(${JSON.stringify(PROJECT_SOURCES_INPUT_MARKER)}));
      input.setAttribute(${JSON.stringify(PROJECT_SOURCES_INPUT_MARKER)}, '1');
      return true;
    })()`,
    returnByValue: true,
  });
  return outcome.result?.value === true;
}

export async function clickProjectSourcesUploadAnyway(
  runtime: ChromeClient["Runtime"],
  input?: ChromeClient["Input"],
): Promise<boolean> {
  const locate = await runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const buttons = ${JSON.stringify(PROJECT_SOURCES_UPLOAD_ANYWAY_BUTTON_SELECTORS)}
        .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const button = buttons.find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return normalize(node.innerText || node.textContent || node.getAttribute('aria-label')) === 'upload anyway';
      });
      if (!(button instanceof HTMLElement)) return { ok: false };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
    returnByValue: true,
  });
  const point = locate.result?.value as { ok?: boolean; x?: number; y?: number } | undefined;
  if (!point?.ok || typeof point.x !== "number" || typeof point.y !== "number") {
    return false;
  }
  if (input && typeof input.dispatchMouseEvent === "function") {
    await input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    return true;
  }
  const clicked = await runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const button = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => {
        return normalize(node.textContent || node.getAttribute('aria-label')) === 'upload anyway';
      });
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
  });
  return clicked.result?.value === true;
}

export async function uploadProjectSources(
  deps: {
    runtime: ChromeClient["Runtime"];
    dom?: ChromeClient["DOM"];
    input?: ChromeClient["Input"];
    page?: ChromeClient["Page"];
  },
  attachments: BrowserAttachment[],
  logger: BrowserLogger,
  timeoutMs: number,
): Promise<string[]> {
  const { runtime, dom, input, page } = deps;
  if (!dom) {
    throw new Error("Chrome DOM domain unavailable while uploading project sources.");
  }
  if (attachments.length === 0) {
    return [];
  }

  const before = await listProjectSources(runtime);
  let latestNames = before;
  for (let offset = 0; offset < attachments.length; offset += PROJECT_SOURCES_MAX_UPLOAD_BATCH) {
    const batch = attachments.slice(offset, offset + PROJECT_SOURCES_MAX_UPLOAD_BATCH);
    const batchPaths = batch.map((attachment) => attachment.path);
    const batchNames = batch.map((attachment) => path.basename(attachment.path));
    logger(
      `Uploading project source batch ${Math.floor(offset / PROJECT_SOURCES_MAX_UPLOAD_BATCH) + 1} ` +
        `(${batch.length} file${batch.length === 1 ? "" : "s"})`,
    );

    let tagged = await markProjectSourcesUploadInput(runtime);
    if (!tagged) {
      await openProjectSourcesAddDialog(runtime, input);
      const inputReadyDeadline = Date.now() + Math.max(timeoutMs, 15_000);
      while (Date.now() < inputReadyDeadline) {
        tagged = await markProjectSourcesUploadInput(runtime, { preferDialog: true });
        if (tagged) break;
        await delay(200);
      }
    }
    if (!tagged) {
      throw new Error("Project Sources upload input did not appear.");
    }

    const documentNode = await dom.getDocument({ depth: 3 });
    const query = await dom.querySelector({
      nodeId: documentNode.root.nodeId,
      selector: `input[${PROJECT_SOURCES_INPUT_MARKER}="1"]`,
    });
    if (!query.nodeId) {
      throw new Error("Unable to locate the Project Sources upload input.");
    }
    await dom.setFileInputFiles({ nodeId: query.nodeId, files: batchPaths });
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

    await clickProjectSourcesUploadAnyway(runtime, input).catch(() => false);

    const deadline = Date.now() + Math.max(timeoutMs, 30_000);
    while (Date.now() < deadline) {
      latestNames = await listProjectSources(runtime);
      const ready = batchNames.every((name) => latestNames.includes(name));
      if (ready && latestNames.length >= before.length) {
        break;
      }
      await delay(300);
    }
    const batchReady = batchNames.every((name) => latestNames.includes(name));
    if (!batchReady) {
      throw new Error(`Timed out waiting for uploaded project sources: ${batchNames.join(", ")}`);
    }
  }
  return latestNames;
}

export async function deleteProjectSourcesByName(
  runtime: ChromeClient["Runtime"],
  input: ChromeClient["Input"] | undefined,
  names: string[],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<string[]> {
  const uniqueNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  for (const name of uniqueNames) {
    logger(`Deleting project source: ${name}`);
    const actionTarget = await runtime.evaluate({
      expression: `(() => {
        const normalize = (value) => String(value || '').trim();
        const rows = ${JSON.stringify(PROJECT_SOURCES_FILE_ROW_SELECTORS)}
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)));
        const row = rows.find((node) => {
          const labelNode = Array.from(node.querySelectorAll('[aria-label]')).find((candidate) => {
            const label = normalize(candidate.getAttribute('aria-label'));
            return label.length > 0 && label !== 'Source actions';
          });
          return normalize(labelNode?.getAttribute('aria-label')) === ${JSON.stringify(name)};
        });
        if (!(row instanceof HTMLElement)) return { ok: false };
        row.scrollIntoView({ block: 'center', inline: 'center' });
        const button = row.querySelector('button[aria-label="Source actions"]');
        if (!(button instanceof HTMLElement)) return { ok: false };
        const rect = button.getBoundingClientRect();
        return {
          ok: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })()`,
      returnByValue: true,
    });
    const point = actionTarget.result?.value as
      | { ok?: boolean; x?: number; y?: number }
      | undefined;
    if (!point?.ok || typeof point.x !== "number" || typeof point.y !== "number") {
      throw new Error(`Unable to find delete control for project source: ${name}`);
    }
    if (!input) {
      throw new Error("Chrome Input domain unavailable while deleting project sources.");
    }
    await input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await delay(200);
    const removeTarget = await runtime.evaluate({
      expression: `(() => {
        const normalize = (value) => String(value || '').trim().toLowerCase();
        const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return normalize(node.innerText || node.textContent) === 'remove';
        });
        if (!(item instanceof HTMLElement)) return { ok: false };
        const rect = item.getBoundingClientRect();
        return {
          ok: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })()`,
      returnByValue: true,
    });
    const removePoint = removeTarget.result?.value as
      | { ok?: boolean; x?: number; y?: number }
      | undefined;
    if (!removePoint?.ok || typeof removePoint.x !== "number" || typeof removePoint.y !== "number") {
      throw new Error(`Unable to locate remove action for project source: ${name}`);
    }
    await input.dispatchMouseEvent({ type: "mouseMoved", x: removePoint.x, y: removePoint.y });
    await input.dispatchMouseEvent({
      type: "mousePressed",
      x: removePoint.x,
      y: removePoint.y,
      button: "left",
      clickCount: 1,
    });
    await input.dispatchMouseEvent({
      type: "mouseReleased",
      x: removePoint.x,
      y: removePoint.y,
      button: "left",
      clickCount: 1,
    });

    const deadline = Date.now() + Math.max(timeoutMs, 15_000);
    while (Date.now() < deadline) {
      const current = await listProjectSources(runtime);
      if (!current.includes(name)) {
        break;
      }
      await delay(250);
    }
  }
  return listProjectSources(runtime);
}

export function resolveProjectSourceDeleteNames(args: {
  operation: BrowserProjectSourcesOperation;
  attachments: BrowserAttachment[];
  beforeNames: string[];
  explicitDeleteNames?: string[];
}): string[] {
  const explicit = Array.from(new Set((args.explicitDeleteNames ?? []).map((name) => name.trim())))
    .filter(Boolean);
  if (args.operation === "delete") {
    return explicit;
  }
  if (args.operation === "replace") {
    if (explicit.length > 0) return explicit;
    return Array.from(new Set(args.attachments.map((attachment) => path.basename(attachment.path))));
  }
  if (args.operation === "sync") {
    return [...args.beforeNames];
  }
  return [];
}
