import { UPLOAD_STATUS_SELECTORS } from "../constants.js";

// Use the same composer-scoped signal at completion and immediately before send.
export function buildAttachmentProgressExpression(composerExpression: string): string {
  return String.raw`(() => {
    const root = ${composerExpression};
    if (!root || root === document || root === document.body) return false;
    const selectors = ${JSON.stringify([...UPLOAD_STATUS_SELECTORS, '[aria-busy="true"]', '[role="status"]', '[role="progressbar"]', "progress"])};
    const candidates = new Set(selectors.flatMap(selector => Array.from(root.querySelectorAll(selector))));
    if (selectors.some(selector => root.matches?.(selector))) candidates.add(root);
    return Array.from(candidates).some(node => {
      if (typeof node.getBoundingClientRect !== 'function' || node.closest('textarea,input,[contenteditable="true"]')) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let ancestor = node; ancestor && typeof ancestor.getBoundingClientRect === 'function'; ancestor = ancestor.parentElement) {
        const style = typeof window === 'undefined' ? {} : window.getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return false;
      }
      const state = node.getAttribute('data-state');
      if (node.getAttribute('aria-busy') === 'true' || ['loading', 'uploading', 'pending'].includes(state)) return true;
      const nativeProgress = node.matches('progress');
      if (nativeProgress || node.getAttribute('role') === 'progressbar') {
        const current = nativeProgress
          ? (node.hasAttribute('value') ? node.value : NaN)
          : Number.parseFloat(node.getAttribute('aria-valuenow'));
        const maximum = nativeProgress ? node.max : Number.parseFloat(node.getAttribute('aria-valuemax') ?? '100');
        return !Number.isFinite(current) || !Number.isFinite(maximum) || current < maximum;
      }
      // Attachment labels are filenames, not status announcements.
      if (!node.matches('[aria-live="polite"],[aria-live="assertive"],[role="status"],[role="progressbar"],[data-testid*="progress"],[data-testid*="status"]')) return false;
      const text = [node.textContent, node.getAttribute('aria-label')].filter(Boolean).join(' ')
        .replace(/\b(?:uploading|processing)\s+(?:is\s+)?(?:complete[ds]?|finished|done)\b/gi, '')
        .replace(/\b(?:complete[ds]?|finished|done)\s+(?:uploading|processing)\b/gi, '');
      return /(?:^|[^\p{L}\p{N}\p{M}])(?:uploading|processing)(?=$|[^\p{L}\p{N}\p{M}])/iu.test(text);
    });
  })()`;
}
