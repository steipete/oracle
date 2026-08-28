import { randomUUID } from "node:crypto";
import type { ChromeClient } from "../types.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../constants.js";

// Receipts live in the renderer: retaining the actual removal control, rather than
// its label/count, lets every stage reject removed, replaced, or sent attachments.
export function buildAttachmentEvidenceExpression(
  names: string[],
  action: "read" | "begin" | "confirm" | "clear" = "read",
  id?: string,
): string {
  return `(() => {
    const names = ${JSON.stringify(names)}.map(name => String(name).toLowerCase().replace(/\\s+/g, ' ').trim());
    const action = ${JSON.stringify(action)};
    const id = ${JSON.stringify(id ?? "")};
    const key = '__oracleAttachmentEvidence';
    if (action === 'clear') { delete globalThis[key]; return true; }
    const empty = names.map(() => false);
    if (action === 'read' && !globalThis[key]) return empty;
    const receipts = globalThis[key] ??= new Map();
    const visible = node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const prompt = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visible);
    const send = sendSelectors.map(selector => document.querySelector(selector)).find(visible);
    let composer = null;
    let fallback = null;
    for (let node = (prompt ?? send)?.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (!sendSelectors.some(selector => node.querySelector(selector))) continue;
      fallback ??= node;
      if (node.querySelector('input[type="file"],[data-testid*="attachment"],[aria-label*="Remove" i]')) {
        composer = node;
        break;
      }
    }
    composer ??= fallback;
    if (!composer) return action === 'read' ? empty : false;
    const controls = () => Array.from(composer.querySelectorAll('[aria-label*="Remove" i]')).filter(node => {
      if (!visible(node) || node.closest('textarea,[contenteditable="true"]')) return false;
      const label = (node.getAttribute('aria-label') ?? '').toLowerCase();
      return /^remove (?:file|attachment|image|photo)(?: |$)/.test(label) || Boolean(node.closest('[data-testid*="chip"],[data-testid*="attachment"],[data-testid*="upload"]'));
    });
    const currentControls = controls();
    const valid = receipt => receipt.composer === composer && receipt.control?.isConnected && currentControls.includes(receipt.control) && receipt.control.getAttribute('aria-label') === receipt.label;
    for (const [receiptId, receipt] of receipts) {
      if (receipt.composer !== composer || (receipt.control && !valid(receipt))) receipts.delete(receiptId);
    }
    if (action === 'begin') {
      for (const [receiptId, receipt] of receipts) {
        if (receipt.name === names[0]) receipts.delete(receiptId);
      }
      receipts.set(id, { name: names[0], composer, before: new Set(currentControls) });
      return true;
    }
    if (action === 'confirm') {
      const receipt = receipts.get(id);
      if (!receipt || receipt.composer !== composer) return false;
      if (valid(receipt)) return true;
      const claimed = new Set(Array.from(receipts.values()).map(entry => entry.control).filter(Boolean));
      const added = currentControls.filter(control => !receipt.before.has(control) && !claimed.has(control));
      // Ambiguous additions cannot identify which file was accepted.
      if (added.length !== 1) return false;
      receipt.control = added[0];
      receipt.label = added[0].getAttribute('aria-label');
      receipt.before.clear();
      return true;
    }
    return names.map(name => Array.from(receipts.values()).some(receipt => receipt.name === name && valid(receipt)));
  })()`;
}

export async function beginAttachmentEvidence(
  runtime: ChromeClient["Runtime"],
  name: string,
): Promise<string> {
  const id = randomUUID();
  await runtime.evaluate({
    expression: buildAttachmentEvidenceExpression([name], "begin", id),
    returnByValue: true,
  });
  return id;
}

export async function confirmAttachmentEvidence(
  runtime: ChromeClient["Runtime"],
  id: string,
): Promise<boolean> {
  const result = await runtime.evaluate({
    expression: buildAttachmentEvidenceExpression([], "confirm", id),
    returnByValue: true,
  });
  return result.result?.value === true;
}
