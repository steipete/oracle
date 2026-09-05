import { UPLOAD_STATUS_SELECTORS } from "../constants.js";

// Use the same composer-scoped signal at completion and immediately before send.
export function buildAttachmentProgressExpression(composerExpression: string): string {
  return String.raw`(() => {
    const root = ${composerExpression};
    if (!root || root === document || root === document.body) return false;
    const selectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const candidates = new Set(selectors.flatMap(selector => Array.from(root.querySelectorAll(selector))));
    if (selectors.some(selector => root.matches?.(selector))) candidates.add(root);
    return Array.from(candidates).some(node => {
      if (!(node instanceof HTMLElement) || node.closest('textarea,input,[contenteditable="true"]')) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = typeof window === 'undefined' ? {} : window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const state = node.getAttribute('data-state');
      if (node.getAttribute('aria-busy') === 'true' || ['loading', 'uploading', 'pending'].includes(state)) return true;
      return /^\s*(?:uploading|processing)(?:\s|…|\.{2,}|$)/i.test(node.textContent ?? '');
    });
  })()`;
}
