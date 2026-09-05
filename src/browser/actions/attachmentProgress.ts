// Use the same composer-scoped signal at completion and immediately before send.
export function buildAttachmentProgressExpression(composerExpression: string): string {
  return String.raw`(() => {
    const root = ${composerExpression};
    if (!root || root === document || root === document.body) return false;
    // Text can name a file or describe a completed operation; only explicit state blocks sending.
    const selectors = ['[data-state="loading"]', '[data-state="uploading"]', '[data-state="pending"]', '[aria-busy="true"]', '[role~="progressbar"]', 'progress'];
    const candidates = new Set(selectors.flatMap(selector => Array.from(root.querySelectorAll(selector))));
    if (selectors.some(selector => root.matches?.(selector))) candidates.add(root);
    return Array.from(candidates).some(node => {
      if (typeof node.getBoundingClientRect !== 'function') return false;
      const editor = node.closest('textarea,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]');
      if (editor && editor !== node) return false;
      const state = node.getAttribute('data-state');
      const pending = node.getAttribute('aria-busy') === 'true' || ['loading', 'uploading', 'pending'].includes(state);
      // File inputs and backing editors may be hidden behind the visible composer.
      if (pending && (node.matches('input[type="file"]') || editor === node)) return true;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let ancestor = node; ancestor && typeof ancestor.getBoundingClientRect === 'function'; ancestor = ancestor.parentElement) {
        const style = typeof window === 'undefined' ? {} : window.getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) return false;
        const clip = style.clip?.match(/^rect\((.*)\)$/)?.[1].split(/[,\s]+/).filter(Boolean).map(Number.parseFloat);
        if (clip?.length === 4 && clip.every(Number.isFinite) && (clip[2] <= clip[0] || clip[1] <= clip[3])) return false;
        if (style.clipPath === 'inset(50%)') return false;
      }
      if (pending) return true;
      const nativeProgress = node.matches('progress');
      if (nativeProgress || node.matches('[role~="progressbar"]')) {
        const current = nativeProgress
          ? (node.hasAttribute('value') ? node.value : NaN)
          : Number.parseFloat(node.getAttribute('aria-valuenow'));
        const maximum = nativeProgress ? node.max : Number.parseFloat(node.getAttribute('aria-valuemax') ?? '100');
        return !Number.isFinite(current) || !Number.isFinite(maximum) || current < maximum;
      }
      return false;
    });
  })()`;
}
