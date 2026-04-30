import { getChatGptModelKindTestIdTokens } from "../chatgptModelCatalog.js";

export function buildModelPickerDomHelpers(): string {
  const kindTokensLiteral = JSON.stringify(getChatGptModelKindTestIdTokens());
  return `
    const EFFORT_LABELS = new Set(['light', 'standard', 'extended', 'heavy']);
    const MODEL_KIND_TEST_ID_TOKENS = ${kindTokensLiteral};
    const findModelButton = () => {
      const candidates = Array.from(document.querySelectorAll(MODEL_BUTTON_SELECTOR));
      if (candidates.length === 0) return null;
      let best = null;
      for (const candidate of candidates) {
        const rawText = [
          candidate.textContent ?? '',
          candidate.getAttribute?.('aria-label') ?? '',
          candidate.getAttribute?.('data-testid') ?? '',
        ].join(' ');
        const label = normalize(rawText);
        const testId = candidate.getAttribute?.('data-testid') ?? '';
        const className = candidate.getAttribute?.('class') ?? '';
        const hasMenu = candidate.getAttribute?.('aria-haspopup') === 'menu';
        const isEffortOnly = label === 'pro' || label === 'thinking' || EFFORT_LABELS.has(label);
        let score = 0;
        if (testId.includes('model-switcher')) score += 1000;
        if (label.includes('model')) score += 300;
        if (label.includes('gpt') || label.includes('chatgpt')) score += 200;
        if (label.includes('auto')) score += 250;
        if (/\\b5\\b/.test(label) || /\\b5\\s+[0-9]\\b/.test(label)) score += 150;
        if ((label.includes('thinking') || label.includes('pro')) && !isEffortOnly) score += 100;
        if (className.includes('__composer-pill') && hasMenu && isEffortOnly) score += 120;
        if (isEffortOnly) score += 20;
        const rect = candidate.getBoundingClientRect?.();
        if (rect && rect.width > 0 && rect.height > 0) score += 10;
        if (!best || score > best.score) best = { candidate, score };
      }
      return best && best.score >= 100 ? best.candidate : null;
    };
    const modelKindFromLabel = (value) => {
      const label = normalize(value);
      if (label.includes('pro') && !label.includes('thinking')) return 'pro';
      if (label.includes('thinking') && !label.includes('pro')) return 'thinking';
      return null;
    };
    const modelKindFromTestId = (value) => {
      const testId = String(value || '').toLowerCase();
      for (const token of MODEL_KIND_TEST_ID_TOKENS.pro) {
        if (testId.includes(token)) return 'pro';
      }
      for (const token of MODEL_KIND_TEST_ID_TOKENS.thinking) {
        if (testId.includes(token)) return 'thinking';
      }
      return null;
    };`;
}
