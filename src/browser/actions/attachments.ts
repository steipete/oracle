import path from 'node:path';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import { CONVERSATION_TURN_SELECTOR, INPUT_SELECTORS, SEND_BUTTON_SELECTORS, UPLOAD_STATUS_SELECTORS } from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';
import { transferAttachmentViaDataTransfer } from './attachmentDataTransfer.js';

export async function uploadAttachmentFile(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM']; input?: ChromeClient['Input'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
  options?: { expectedCount?: number },
): Promise<boolean> {
  const { runtime, dom, input } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }
  const expectedCount =
    typeof options?.expectedCount === 'number' && Number.isFinite(options.expectedCount)
      ? Math.max(0, Math.floor(options.expectedCount))
      : 0;

  const readAttachmentSignals = async (name: string) => {
    const check = await runtime.evaluate({
      expression: `(() => {
        const expected = ${JSON.stringify(name)};
        const normalizedExpected = String(expected || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const expectedNoExt = normalizedExpected.replace(/\\.[a-z0-9]{1,10}$/i, '');
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const matchesExpected = (value) => {
          const text = normalize(value);
          if (!text) return false;
          if (text.includes(normalizedExpected)) return true;
          if (expectedNoExt.length >= 6 && text.includes(expectedNoExt)) return true;
          if (text.includes('…') || text.includes('...')) {
            const marker = text.includes('…') ? '…' : '...';
            const [prefixRaw, suffixRaw] = text.split(marker);
            const prefix = normalize(prefixRaw);
            const suffix = normalize(suffixRaw);
            const target = expectedNoExt.length >= 6 ? expectedNoExt : normalizedExpected;
            const matchesPrefix = !prefix || target.includes(prefix);
            const matchesSuffix = !suffix || target.includes(suffix);
            return matchesPrefix && matchesSuffix;
          }
          return false;
        };

        const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
        const findPromptNode = () => {
          for (const selector of promptSelectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              const rect = node.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return node;
            }
          }
          for (const selector of promptSelectors) {
            const node = document.querySelector(selector);
            if (node) return node;
          }
          return null;
        };
        const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
        const attachmentSelectors = [
          'input[type="file"]',
          '[data-testid*="attachment"]',
          '[data-testid*="upload"]',
          '[aria-label*="Remove"]',
          '[aria-label*="remove"]',
        ];
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
        const root = locateComposerRoot();
        const scope = (() => {
          if (!root) return document.body;
          const parent = root.parentElement;
          const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
          return parentHasSend ? parent : root;
        })();
        const rootTextRaw = root ? (root.innerText || root.textContent || '') : '';
        const chipSelector = [
          '[data-testid*="attachment"]',
          '[data-testid*="chip"]',
          '[data-testid*="upload"]',
          '[data-testid*="file"]',
          '[aria-label*="Remove"]',
          'button[aria-label*="Remove"]',
          '[aria-label*="remove"]',
        ].join(',');
        const localCandidates = scope ? Array.from(scope.querySelectorAll(chipSelector)) : [];
        const globalCandidates = Array.from(document.querySelectorAll(chipSelector));
        const matchCandidates = localCandidates.length > 0 ? localCandidates : globalCandidates;
        const serializeChip = (node) => {
          const text = node?.textContent ?? '';
          const aria = node?.getAttribute?.('aria-label') ?? '';
          const title = node?.getAttribute?.('title') ?? '';
          const testid = node?.getAttribute?.('data-testid') ?? '';
          return [text, aria, title, testid].map(normalize).join('|');
        };
        const chipSignature = localCandidates.map(serializeChip).join('||');
        let uiMatch = false;
        for (const node of matchCandidates) {
          if (node?.tagName === 'INPUT' && node?.type === 'file') continue;
          const text = node?.textContent ?? '';
          const aria = node?.getAttribute?.('aria-label') ?? '';
          const title = node?.getAttribute?.('title') ?? '';
          if ([text, aria, title].some(matchesExpected)) {
            uiMatch = true;
            break;
          }
        }

        if (!uiMatch) {
          const removeScope = root ?? document;
          const cardTexts = Array.from(removeScope.querySelectorAll('[aria-label*="Remove"],[aria-label*="remove"]')).map(
            (btn) => btn?.parentElement?.parentElement?.innerText ?? '',
          );
          if (cardTexts.some(matchesExpected)) {
            uiMatch = true;
          }
        }

        const inputScope = scope ? Array.from(scope.querySelectorAll('input[type="file"]')) : [];
        const inputs = [];
        const inputSeen = new Set();
        for (const el of [...inputScope, ...Array.from(document.querySelectorAll('input[type="file"]'))]) {
          if (!inputSeen.has(el)) {
            inputSeen.add(el);
            inputs.push(el);
          }
        }
        const inputNames = [];
        let inputCount = 0;
        for (const el of inputs) {
          if (!(el instanceof HTMLInputElement)) continue;
          const files = Array.from(el.files || []);
          if (files.length > 0) {
            inputCount += files.length;
            for (const file of files) {
              if (file?.name) inputNames.push(file.name);
            }
          }
        }
        const inputMatch = inputNames.some((file) => matchesExpected(file));
        const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
        const uploading = uploadingSelectors.some((selector) => {
          return Array.from(document.querySelectorAll(selector)).some((node) => {
            const ariaBusy = node.getAttribute?.('aria-busy');
            const dataState = node.getAttribute?.('data-state');
            if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
              return true;
            }
            const text = node.textContent?.toLowerCase?.() ?? '';
            return /\\buploading\\b/.test(text) || /\\bprocessing\\b/.test(text);
          });
        });

        const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
        const collectFileCount = (candidates) => {
          let count = 0;
          for (const node of candidates) {
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
            const values = [
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
            for (const raw of values) {
              if (!raw) continue;
              const normalized = normalize(raw);
              if (normalized.includes('file') || normalized.includes('attachment')) {
                hasFileHint = true;
                break;
              }
            }
            if (!hasFileHint) continue;
            for (const raw of values) {
              if (!raw) continue;
              const match = normalize(raw).match(countRegex);
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
        const fileCountScope = scope ?? root ?? document.body;
        const localFileNodes = fileCountScope
          ? Array.from(fileCountScope.querySelectorAll(fileCountSelectors))
          : [];
        const globalFileNodes = Array.from(document.querySelectorAll(fileCountSelectors));
        let fileCount = collectFileCount(localFileNodes);
        if (!fileCount && globalFileNodes.length > 0) {
          fileCount = collectFileCount(globalFileNodes);
        }
        const hasAttachmentSignal = localCandidates.length > 0 || inputCount > 0 || fileCount > 0 || uploading;
        if (!uiMatch && rootTextRaw && hasAttachmentSignal && matchesExpected(rootTextRaw)) {
          uiMatch = true;
        }

        return {
          ui: uiMatch,
          input: inputMatch,
          inputCount,
          chipCount: localCandidates.length,
          chipSignature,
          uploading,
          fileCount,
        };
      })()`,
      returnByValue: true,
    });
    const value = check?.result?.value as
      | {
          ui?: boolean;
          input?: boolean;
          inputCount?: number;
          chipCount?: number;
          chipSignature?: string;
          uploading?: boolean;
          fileCount?: number;
        }
      | undefined;
    return {
      ui: Boolean(value?.ui),
      input: Boolean(value?.input),
      inputCount: typeof value?.inputCount === 'number' ? value?.inputCount : 0,
      chipCount: typeof value?.chipCount === 'number' ? value?.chipCount : 0,
      chipSignature: typeof value?.chipSignature === 'string' ? value?.chipSignature : '',
      uploading: Boolean(value?.uploading),
      fileCount: typeof value?.fileCount === 'number' ? value?.fileCount : 0,
    };
  };

  // New ChatGPT UI hides the real file input behind a composer "+" menu; click it pre-emptively.
  // Learned: synthetic `.click()` is sometimes ignored (isTrusted checks). Prefer a CDP mouse click when possible.
  const clickPlusTrusted = async (): Promise<boolean> => {
    if (!input || typeof input.dispatchMouseEvent !== 'function') return false;
    const locate = await runtime
      .evaluate({
        expression: `(() => {
          const selectors = [
            '#composer-plus-btn',
            'button[data-testid="composer-plus-btn"]',
            '[data-testid*="plus"]',
            'button[aria-label*="add"]',
            'button[aria-label*="attachment"]',
            'button[aria-label*="file"]',
          ];
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!(el instanceof HTMLElement)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const nextRect = el.getBoundingClientRect();
            return { ok: true, x: nextRect.left + nextRect.width / 2, y: nextRect.top + nextRect.height / 2 };
          }
          return { ok: false };
        })()`,
        returnByValue: true,
      })
      .then((res) => res?.result?.value as { ok?: boolean; x?: number; y?: number } | undefined)
      .catch(() => undefined);
    if (!locate?.ok || typeof locate.x !== 'number' || typeof locate.y !== 'number') return false;
    const x = locate.x;
    const y = locate.y;
    await input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  };

  const clickedTrusted = await clickPlusTrusted().catch(() => false);
  if (!clickedTrusted) {
    await Promise.resolve(
      runtime.evaluate({
        expression: `(() => {
          const selectors = [
            '#composer-plus-btn',
            'button[data-testid="composer-plus-btn"]',
            '[data-testid*="plus"]',
            'button[aria-label*="add"]',
            'button[aria-label*="attachment"]',
            'button[aria-label*="file"]',
          ];
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el instanceof HTMLElement) {
              el.click();
              return true;
            }
          }
          return false;
        })()`,
        returnByValue: true,
      }),
    ).catch(() => undefined);
  }

  await delay(350);

  const normalizeForMatch = (value: string): string =>
    String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const expectedName = path.basename(attachment.path);
  const expectedNameLower = normalizeForMatch(expectedName);
  const expectedNameNoExt = expectedNameLower.replace(/\.[a-z0-9]{1,10}$/i, '');
  const matchesExpectedName = (value: string): boolean => {
    const normalized = normalizeForMatch(value);
    if (!normalized) return false;
    if (normalized.includes(expectedNameLower)) return true;
    if (expectedNameNoExt.length >= 6 && normalized.includes(expectedNameNoExt)) return true;
    return false;
  };
  const isImageAttachment = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(expectedName);
  const attachmentUiTimeoutMs = 25_000;
  const attachmentUiSignalWaitMs = 5_000;

  const initialSignals = await readAttachmentSignals(expectedName);
  let inputConfirmed = false;

  if (initialSignals.ui) {
    logger(`Attachment already present: ${path.basename(attachment.path)}`);
    return true;
  }
  const isExpectedSatisfied = (signals: {
    fileCount?: number;
    chipCount?: number;
    ui?: boolean;
  }): boolean => {
    if (expectedCount <= 0) return false;
    const fileCount = typeof signals.fileCount === 'number' ? signals.fileCount : 0;
    const chipCount = typeof signals.chipCount === 'number' ? signals.chipCount : 0;
    if (fileCount >= expectedCount) return true;
    return Boolean(signals.ui && chipCount >= expectedCount);
  };
  const initialInputSatisfied =
    expectedCount > 0 ? initialSignals.inputCount >= expectedCount : Boolean(initialSignals.input);
  if (expectedCount > 0 && (initialSignals.fileCount >= expectedCount || initialSignals.inputCount >= expectedCount)) {
    const satisfiedCount = Math.max(initialSignals.fileCount, initialSignals.inputCount);
    logger(
      `Attachment already present: composer shows ${satisfiedCount} file${satisfiedCount === 1 ? '' : 's'}`,
    );
    return true;
  }
  if (initialInputSatisfied || initialSignals.input) {
    logger(`Attachment already queued in file input: ${path.basename(attachment.path)}`);
    return true;
  }

  const documentNode = await dom.getDocument();
  const candidateSetup = await runtime.evaluate({
    expression: `(() => {
      const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
      const findPromptNode = () => {
        for (const selector of promptSelectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (const node of nodes) {
            if (!(node instanceof HTMLElement)) continue;
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return node;
          }
        }
        for (const selector of promptSelectors) {
          const node = document.querySelector(selector);
          if (node) return node;
        }
        return null;
      };
      const attachmentSelectors = [
        'input[type="file"]',
        '[data-testid*="attachment"]',
        '[data-testid*="upload"]',
        '[aria-label*="Remove"]',
        '[aria-label*="remove"]',
      ];
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
      const root = locateComposerRoot();
      const scope = (() => {
        if (!root) return document.body;
        const parent = root.parentElement;
        const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
        return parentHasSend ? parent : root;
      })();
      const localInputs = scope ? Array.from(scope.querySelectorAll('input[type="file"]')) : [];
      const globalInputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const inputs = [];
      const inputSeen = new Set();
      for (const el of [...localInputs, ...globalInputs]) {
        if (!inputSeen.has(el)) {
          inputSeen.add(el);
          inputs.push(el);
        }
      }
      const baselineInputCount = inputs.reduce((total, el) => {
        if (!(el instanceof HTMLInputElement)) return total;
        const count = Array.from(el.files || []).length;
        return total + count;
      }, 0);
      const isImageAttachment = ${JSON.stringify(isImageAttachment)};
      const acceptIsImageOnly = (accept) => {
        if (!accept) return false;
        const parts = String(accept)
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
        return parts.length > 0 && parts.every((p) => p.startsWith('image/'));
      };
      const chipContainer = scope ?? document;
        const chipSelector = '[data-testid*="attachment"],[data-testid*="chip"],[data-testid*="upload"],[data-testid*="file"],[aria-label*="Remove"],[aria-label*="remove"]';
      const baselineChipCount = chipContainer.querySelectorAll(chipSelector).length;
      const baselineChips = Array.from(chipContainer.querySelectorAll(chipSelector))
        .slice(0, 20)
        .map((node) => ({
          text: (node.textContent || '').trim(),
          aria: node.getAttribute?.('aria-label') ?? '',
          title: node.getAttribute?.('title') ?? '',
          testid: node.getAttribute?.('data-testid') ?? '',
        }));
      const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
      const baselineUploading = uploadingSelectors.some((selector) => {
        return Array.from(document.querySelectorAll(selector)).some((node) => {
          const ariaBusy = node.getAttribute?.('aria-busy');
          const dataState = node.getAttribute?.('data-state');
          if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
            return true;
          }
          const text = node.textContent?.toLowerCase?.() ?? '';
          return /\\buploading\\b/.test(text) || /\\bprocessing\\b/.test(text);
        });
      });
      const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
      const collectFileCount = (candidates) => {
        let count = 0;
        for (const node of candidates) {
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
          const values = [
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
          for (const raw of values) {
            if (!raw) continue;
            const lowered = String(raw).toLowerCase();
            if (lowered.includes('file') || lowered.includes('attachment')) {
              hasFileHint = true;
              break;
            }
          }
          if (!hasFileHint) continue;
          for (const raw of values) {
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
      const fileCountScope = scope ?? root ?? document.body;
      const localFileNodes = fileCountScope
        ? Array.from(fileCountScope.querySelectorAll(fileCountSelectors))
        : [];
      const globalFileNodes = Array.from(document.querySelectorAll(fileCountSelectors));
      let baselineFileCount = collectFileCount(localFileNodes);
      if (!baselineFileCount && globalFileNodes.length > 0) {
        baselineFileCount = collectFileCount(globalFileNodes);
      }

      // Mark candidates with stable indices so we can select them via DOM.querySelector.
      // Learned: ChatGPT sometimes renders a zero-sized file input that does *not* trigger uploads;
      // keep it as a fallback, but strongly prefer visible (even sr-only 1x1) inputs.
      const localSet = new Set(localInputs);
      let idx = 0;
      let candidates = inputs.map((el) => {
        const accept = el.getAttribute('accept') || '';
        const imageOnly = acceptIsImageOnly(accept);
        const rect = el instanceof HTMLElement ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const visible = rect.width > 0 && rect.height > 0;
        const local = localSet.has(el);
        const score =
          (el.hasAttribute('multiple') ? 100 : 0) +
          (local ? 40 : 0) +
          (visible ? 30 : -200) +
          (!imageOnly ? 30 : isImageAttachment ? 20 : 5);
        el.setAttribute('data-oracle-upload-candidate', 'true');
        el.setAttribute('data-oracle-upload-idx', String(idx));
        return { idx: idx++, score, imageOnly };
      });

      // When the attachment isn't an image, avoid inputs that only accept images.
      // Some ChatGPT surfaces expose multiple file inputs (e.g. image-only vs generic upload).
      if (!isImageAttachment) {
        const nonImage = candidates.filter((candidate) => !candidate.imageOnly);
        if (nonImage.length > 0) {
          candidates = nonImage;
        }
      }

      // Prefer higher scores first.
      candidates.sort((a, b) => b.score - a.score);
      return {
        ok: candidates.length > 0,
        baselineChipCount,
        baselineChips,
        baselineUploading,
        baselineFileCount,
        baselineInputCount,
        order: candidates.map((c) => c.idx),
      };
    })()`,
    returnByValue: true,
  });
  const candidateValue = candidateSetup?.result?.value as
    | {
        ok?: boolean;
        baselineChipCount?: number;
        baselineChips?: Array<Record<string, string>>;
        baselineUploading?: boolean;
        baselineFileCount?: number;
        baselineInputCount?: number;
        order?: number[];
      }
    | undefined;
  const candidateOrder = Array.isArray(candidateValue?.order) ? candidateValue.order : [];
  const baselineChipCount = typeof candidateValue?.baselineChipCount === 'number' ? candidateValue.baselineChipCount : 0;
  const baselineChips = Array.isArray(candidateValue?.baselineChips) ? candidateValue.baselineChips : [];
  const baselineUploading = Boolean(candidateValue?.baselineUploading);
  const baselineFileCount = typeof candidateValue?.baselineFileCount === 'number' ? candidateValue.baselineFileCount : 0;
  const baselineInputCount = typeof candidateValue?.baselineInputCount === 'number' ? candidateValue.baselineInputCount : 0;
  const serializeChips = (chips: Array<Record<string, string>>): string =>
    chips
      .map((chip) =>
        [chip.text, chip.aria, chip.title, chip.testid]
          .map((value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim())
          .join('|'),
      )
      .join('||');
  const baselineChipSignature = serializeChips(baselineChips);
  if (!candidateValue?.ok || candidateOrder.length === 0) {
    await logDomFailure(runtime, logger, 'file-input-missing');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }

  const hasChipDelta = (signals: {
    chipCount?: number;
    chipSignature?: string;
  }): boolean => {
    const chipCount = typeof signals.chipCount === 'number' ? signals.chipCount : 0;
    const chipSignature = typeof signals.chipSignature === 'string' ? signals.chipSignature : '';
    if (chipCount > baselineChipCount) return true;
    if (baselineChipSignature && chipSignature && chipSignature !== baselineChipSignature) return true;
    return false;
  };
  const hasInputDelta = (signals: { inputCount?: number }): boolean =>
    (typeof signals.inputCount === 'number' ? signals.inputCount : 0) > baselineInputCount;
  const hasUploadDelta = (signals: { uploading?: boolean }): boolean =>
    Boolean(signals.uploading && !baselineUploading);
  const hasFileCountDelta = (signals: { fileCount?: number }): boolean =>
    (typeof signals.fileCount === 'number' ? signals.fileCount : 0) > baselineFileCount;
  const waitForAttachmentUiSignal = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let sawInputSignal = false;
    let latest:
      | {
          signals: {
            ui: boolean;
            input: boolean;
            inputCount: number;
            chipCount: number;
            chipSignature: string;
            uploading: boolean;
            fileCount: number;
          };
          chipDelta: boolean;
          inputDelta: boolean;
          uploadDelta: boolean;
          fileCountDelta: boolean;
          expectedSatisfied: boolean;
        }
      | null = null;
    while (Date.now() < deadline) {
      const signals = await readAttachmentSignals(expectedName);
      const chipDelta = hasChipDelta(signals);
      const inputDelta = hasInputDelta(signals) || signals.input;
      const uploadDelta = hasUploadDelta(signals);
      const fileCountDelta = hasFileCountDelta(signals);
      const expectedSatisfied = isExpectedSatisfied(signals);
      if (inputDelta) {
        sawInputSignal = true;
      }
      latest = { signals, chipDelta, inputDelta: sawInputSignal, uploadDelta, fileCountDelta, expectedSatisfied };
      if (signals.ui || chipDelta || uploadDelta || fileCountDelta || expectedSatisfied) {
        return latest;
      }
      await delay(250);
    }
    return latest;
  };

  const inputSnapshotFor = (idx: number) => `(() => {
    const input = document.querySelector('input[type="file"][data-oracle-upload-idx="${idx}"]');
    if (!(input instanceof HTMLInputElement)) {
      return { names: [], value: '', count: 0 };
    }
    return {
      names: Array.from(input.files || []).map((file) => file?.name ?? '').filter(Boolean),
      value: input.value || '',
      count: Array.from(input.files || []).length,
    };
  })()`;

  const parseInputSnapshot = (value: unknown) => {
    const snapshot = value as { names?: string[]; value?: string; count?: number } | undefined;
    const names = Array.isArray(snapshot?.names) ? snapshot?.names ?? [] : [];
    const valueText = typeof snapshot?.value === 'string' ? snapshot.value : '';
    const count = typeof snapshot?.count === 'number' ? snapshot.count : names.length;
    return {
      names,
      value: valueText,
      count: Number.isFinite(count) ? count : names.length,
    };
  };

  const readInputSnapshot = async (idx: number) => {
    const snapshot = await runtime
      .evaluate({ expression: inputSnapshotFor(idx), returnByValue: true })
      .then((res) => parseInputSnapshot(res?.result?.value))
      .catch(() => parseInputSnapshot(undefined));
    return snapshot;
  };

  const snapshotMatchesExpected = (snapshot: { names: string[]; value: string }): boolean => {
    const nameMatch = snapshot.names.some((name) => matchesExpectedName(name));
    return nameMatch || Boolean(snapshot.value && matchesExpectedName(snapshot.value));
  };

  const inputSignalsFor = (
    baseline: { names: string[]; value: string; count: number },
    current: { names: string[]; value: string; count: number },
  ) => {
    const baselineCount = baseline.count ?? baseline.names.length;
    const currentCount = current.count ?? current.names.length;
    const countDelta = currentCount > baselineCount;
    const valueDelta = Boolean(current.value) && current.value !== baseline.value;
    const baselineEmpty = baselineCount === 0 && !baseline.value;
    const nameMatch =
      current.names.some((name) => matchesExpectedName(name)) ||
      (current.value && matchesExpectedName(current.value));
    const touched = nameMatch || countDelta || (baselineEmpty && valueDelta);
    return {
      touched,
      nameMatch,
      countDelta,
      valueDelta,
    };
  };

  const composerSnapshotFor = (idx: number) => `(() => {
    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const findPromptNode = () => {
      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return node;
        }
      }
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const composerAttachmentSelectors = [
      'input[type="file"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      '[aria-label*="remove"]',
    ];
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
            const hasAttachment = composerAttachmentSelectors.some((selector) => current.querySelector(selector));
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
    const root = locateComposerRoot();
    const scope = (() => {
      if (!root) return document.body;
      const parent = root.parentElement;
      const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
      return parentHasSend ? parent : root;
    })();
    const chipContainer = scope ?? document;
    const chipSelector = '[data-testid*="attachment"],[data-testid*="chip"],[data-testid*="upload"],[aria-label*="Remove"],[aria-label*="remove"]';
    const chips = Array.from(chipContainer.querySelectorAll(chipSelector))
      .slice(0, 20)
      .map((node) => ({
        text: (node.textContent || '').trim(),
        aria: node.getAttribute?.('aria-label') ?? '',
        title: node.getAttribute?.('title') ?? '',
        testid: node.getAttribute?.('data-testid') ?? '',
      }));
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const ariaBusy = node.getAttribute?.('aria-busy');
        const dataState = node.getAttribute?.('data-state');
        if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
          return true;
        }
        const text = node.textContent?.toLowerCase?.() ?? '';
        return /\\buploading\\b/.test(text) || /\\bprocessing\\b/.test(text);
      });
    });
    const input = document.querySelector('input[type="file"][data-oracle-upload-idx="${idx}"]');
    const inputNames =
      input instanceof HTMLInputElement
        ? Array.from(input.files || []).map((f) => f?.name ?? '').filter(Boolean)
        : [];
    const composerText = (chipContainer.innerText || '').toLowerCase();
    return {
      chipCount: chipContainer.querySelectorAll(chipSelector).length,
      chips,
      inputNames,
      composerText,
      uploading,
    };
  })()`;

  let confirmedAttachment = false;
  let lastInputNames: string[] = [];
  let lastInputValue = '';
  let finalSnapshot:
    | {
        chipCount: number;
        chips: Array<Record<string, string>>;
        inputNames: string[];
        composerText: string;
        uploading: boolean;
      }
    | null = null;
  const resolveInputNameCandidates = () => {
    const snapshot = finalSnapshot as { inputNames?: string[] } | null;
    const snapshotNames = snapshot?.inputNames;
    if (Array.isArray(snapshotNames) && snapshotNames.length > 0) {
      return snapshotNames;
    }
    return lastInputNames;
  };
  if (!inputConfirmed) {
    for (let orderIndex = 0; orderIndex < candidateOrder.length; orderIndex += 1) {
      const idx = candidateOrder[orderIndex];
      const queuedSignals = await readAttachmentSignals(expectedName);
      if (
        queuedSignals.ui ||
        isExpectedSatisfied(queuedSignals) ||
        hasChipDelta(queuedSignals) ||
        hasUploadDelta(queuedSignals) ||
        hasFileCountDelta(queuedSignals)
      ) {
        confirmedAttachment = true;
        break;
      }
      if (queuedSignals.input || hasInputDelta(queuedSignals)) {
        inputConfirmed = true;
        break;
      }
      const resultNode = await dom.querySelector({
        nodeId: documentNode.root.nodeId,
        selector: `input[type="file"][data-oracle-upload-idx="${idx}"]`,
      });
      if (!resultNode?.nodeId) {
        continue;
      }
      const baselineInputSnapshot = await readInputSnapshot(idx);

      const gatherSignals = async (waitMs = attachmentUiSignalWaitMs) => {
        const signalResult = await waitForAttachmentUiSignal(waitMs);
        const postInputSnapshot = await readInputSnapshot(idx);
        const postInputSignals = inputSignalsFor(baselineInputSnapshot, postInputSnapshot);
        const snapshot = await runtime
          .evaluate({ expression: composerSnapshotFor(idx), returnByValue: true })
          .then(
            (res) =>
              res?.result?.value as {
                chipCount?: number;
                chips?: Array<Record<string, string>>;
                inputNames?: string[];
                composerText?: string;
                uploading?: boolean;
              },
          )
          .catch(() => undefined);
        if (snapshot) {
          finalSnapshot = {
            chipCount: Number(snapshot.chipCount ?? 0),
            chips: Array.isArray(snapshot.chips) ? snapshot.chips : [],
            inputNames: Array.isArray(snapshot.inputNames) ? snapshot.inputNames : [],
            composerText: typeof snapshot.composerText === 'string' ? snapshot.composerText : '',
            uploading: Boolean(snapshot.uploading),
          };
        }
        lastInputNames = postInputSnapshot.names;
        lastInputValue = postInputSnapshot.value;
        return { signalResult, postInputSignals };
      };

      const evaluateSignals = async (
        signalResult: Awaited<ReturnType<typeof waitForAttachmentUiSignal>>,
        postInputSignals: ReturnType<typeof inputSignalsFor>,
        immediateInputMatch: boolean,
      ) => {
        const expectedSatisfied =
          Boolean(signalResult?.expectedSatisfied) ||
          (signalResult?.signals ? isExpectedSatisfied(signalResult.signals) : false);
        const inputNameCandidates = resolveInputNameCandidates();
        const inputHasFile =
          inputNameCandidates.some((name) => matchesExpectedName(name)) ||
          (lastInputValue && matchesExpectedName(lastInputValue));
        const inputEvidence =
          immediateInputMatch ||
          postInputSignals.touched ||
          Boolean(signalResult?.signals?.input) ||
          Boolean(signalResult?.inputDelta) ||
          inputHasFile;
        const uiDirect = Boolean(signalResult?.signals?.ui) || expectedSatisfied;
        const uiDelta =
          Boolean(signalResult?.chipDelta) || Boolean(signalResult?.uploadDelta) || Boolean(signalResult?.fileCountDelta);
        if (uiDirect || (uiDelta && inputEvidence)) {
          return { status: 'ui' as const };
        }
        const postSignals = await readAttachmentSignals(expectedName);
        if (
          postSignals.ui ||
          isExpectedSatisfied(postSignals) ||
          ((hasChipDelta(postSignals) || hasUploadDelta(postSignals) || hasFileCountDelta(postSignals)) && inputEvidence)
        ) {
          return { status: 'ui' as const };
        }
        const inputSignal =
          immediateInputMatch ||
          postInputSignals.touched ||
          Boolean(signalResult?.signals?.input) ||
          Boolean(signalResult?.inputDelta) ||
          inputHasFile ||
          postSignals.input ||
          hasInputDelta(postSignals);
        if (inputSignal) {
          return { status: 'input' as const };
        }
        return { status: 'none' as const };
      };

      const runInputAttempt = async (mode: 'set' | 'transfer') => {
        let immediateInputSnapshot = await readInputSnapshot(idx);
        let hasExpectedFile = snapshotMatchesExpected(immediateInputSnapshot);
        if (!hasExpectedFile) {
          if (mode === 'set') {
            await dom.setFileInputFiles({ nodeId: resultNode.nodeId, files: [attachment.path] });
          } else {
            const selector = `input[type="file"][data-oracle-upload-idx="${idx}"]`;
            try {
              await transferAttachmentViaDataTransfer(runtime, attachment, selector);
            } catch (error) {
              logger(`Attachment data transfer failed: ${(error as Error)?.message ?? String(error)}`);
            }
          }
          immediateInputSnapshot = await readInputSnapshot(idx);
          hasExpectedFile = snapshotMatchesExpected(immediateInputSnapshot);
        }
        const immediateSignals = inputSignalsFor(baselineInputSnapshot, immediateInputSnapshot);
        lastInputNames = immediateInputSnapshot.names;
        lastInputValue = immediateInputSnapshot.value;
        const immediateInputMatch = immediateSignals.touched || hasExpectedFile;
        if (immediateInputMatch) {
          inputConfirmed = true;
        }

        const signalState = await gatherSignals();
        const evaluation = await evaluateSignals(
          signalState.signalResult,
          signalState.postInputSignals,
          immediateInputMatch,
        );
        return { evaluation, signalState, immediateInputMatch };
      };

      const dispatchInputEvents = async () => {
        await runtime
          .evaluate({
            expression: `(() => {
              const input = document.querySelector('input[type="file"][data-oracle-upload-idx="${idx}"]');
              if (!(input instanceof HTMLInputElement)) return false;
              try {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              } catch {
                return false;
              }
            })()`,
            returnByValue: true,
          })
          .catch(() => undefined);
      };

      let result = await runInputAttempt('set');
      if (result.evaluation.status === 'ui') {
        confirmedAttachment = true;
        break;
      }
      if (result.evaluation.status === 'input') {
        await dispatchInputEvents();
        await delay(150);
        const forcedState = await gatherSignals(1_500);
        const forcedEvaluation = await evaluateSignals(
          forcedState.signalResult,
          forcedState.postInputSignals,
          result.immediateInputMatch,
        );
        if (forcedEvaluation.status === 'ui') {
          confirmedAttachment = true;
          break;
        }
        if (forcedEvaluation.status === 'input') {
          logger('Attachment input set; proceeding without UI confirmation.');
          inputConfirmed = true;
          break;
        }
        logger('Attachment input set; retrying with data transfer to trigger ChatGPT upload.');
        await dom.setFileInputFiles({ nodeId: resultNode.nodeId, files: [] }).catch(() => undefined);
        await delay(150);
        result = await runInputAttempt('transfer');
        if (result.evaluation.status === 'ui') {
          confirmedAttachment = true;
          break;
        }
        if (result.evaluation.status === 'input') {
          logger('Attachment input set; proceeding without UI confirmation.');
          inputConfirmed = true;
          break;
        }
      }

      const lateSignals = await readAttachmentSignals(expectedName);
      if (
        lateSignals.ui ||
        isExpectedSatisfied(lateSignals) ||
        hasChipDelta(lateSignals) ||
        hasUploadDelta(lateSignals) ||
        hasFileCountDelta(lateSignals)
      ) {
        confirmedAttachment = true;
        break;
      }
      if (lateSignals.input || hasInputDelta(lateSignals)) {
        logger('Attachment input set; proceeding without UI confirmation.');
        inputConfirmed = true;
        break;
      }

      logger('Attachment not acknowledged after file input set; retrying with data transfer.');
      result = await runInputAttempt('transfer');
      if (result.evaluation.status === 'ui') {
        confirmedAttachment = true;
        break;
      }
      if (result.evaluation.status === 'input') {
        logger('Attachment input set; proceeding without UI confirmation.');
        inputConfirmed = true;
        break;
      }
      if (orderIndex < candidateOrder.length - 1) {
        await dom.setFileInputFiles({ nodeId: resultNode.nodeId, files: [] }).catch(() => undefined);
        await delay(150);
      }
    }
  }
  if (confirmedAttachment) {
    const inputNameCandidates = resolveInputNameCandidates();
    const inputHasFile =
      inputNameCandidates.some((name) => matchesExpectedName(name)) ||
      (lastInputValue && matchesExpectedName(lastInputValue));
    await waitForAttachmentVisible(runtime, expectedName, attachmentUiTimeoutMs, logger);
    logger(inputHasFile ? 'Attachment queued (UI anchored, file input confirmed)' : 'Attachment queued (UI anchored)');
    return true;
  }

  const inputNameCandidates = resolveInputNameCandidates();
  const inputHasFile =
    inputNameCandidates.some((name) => matchesExpectedName(name)) ||
    (lastInputValue && matchesExpectedName(lastInputValue));
  if (await waitForAttachmentAnchored(runtime, expectedName, attachmentUiTimeoutMs)) {
    await waitForAttachmentVisible(runtime, expectedName, attachmentUiTimeoutMs, logger);
    logger(inputHasFile ? 'Attachment queued (UI anchored, file input confirmed)' : 'Attachment queued (UI anchored)');
    return true;
  }

  if (inputConfirmed || inputHasFile) {
    logger('Attachment input accepted the file but UI did not acknowledge it; continuing with input confirmation only.');
    return true;
  }

  await logDomFailure(runtime, logger, 'file-upload-missing');
  throw new Error('Attachment did not register with the ChatGPT composer in time.');
}

export async function clearComposerAttachments(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const expression = `(() => {
    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const findPromptNode = () => {
      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return node;
        }
      }
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const attachmentSelectors = [
      'input[type="file"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      '[aria-label*="remove"]',
    ];
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
    const root = locateComposerRoot();
    const scope = (() => {
      if (!root) return document.body;
      const parent = root.parentElement;
      const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
      return parentHasSend ? parent : root;
    })();
    const removeSelectors = [
      '[aria-label="Remove file"]',
      'button[aria-label="Remove file"]',
      '[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      '[data-testid*="remove-attachment"]',
      '[data-testid*="attachment-remove"]',
    ];
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const removeButtons = scope
      ? Array.from(scope.querySelectorAll(removeSelectors.join(','))).filter(visible)
      : [];
    for (const button of removeButtons.slice(0, 20)) {
      try {
        if (button instanceof HTMLButtonElement) {
          // Ensure remove buttons never submit the composer form.
          button.type = 'button';
        }
        button.click();
      } catch {}
    }
    const chipCount = removeButtons.length;
    const inputs = scope ? Array.from(scope.querySelectorAll('input[type="file"]')) : [];
    let inputCount = 0;
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue;
      inputCount += Array.from(input.files || []).length;
      try { input.value = ''; } catch {}
    }
    const hadAttachments = chipCount > 0 || inputCount > 0 || removeButtons.length > 0;
    return { removeClicks: removeButtons.length, chipCount, inputCount, hadAttachments };
  })()`;

  let sawAttachments = false;
  let lastState: { chipCount?: number; inputCount?: number } | null = null;
  while (Date.now() < deadline) {
    const response = await Runtime.evaluate({ expression, returnByValue: true });
    const value = response.result?.value as
      | { removeClicks?: number; chipCount?: number; inputCount?: number; hadAttachments?: boolean }
      | undefined;
    if (value?.hadAttachments) {
      sawAttachments = true;
    }
    const chipCount = typeof value?.chipCount === 'number' ? value.chipCount : 0;
    const inputCount = typeof value?.inputCount === 'number' ? value.inputCount : 0;
    lastState = { chipCount, inputCount };
    if (chipCount === 0 && inputCount === 0) {
      return;
    }
    await delay(250);
  }
  if (sawAttachments) {
    logger?.(
      `Attachment cleanup timed out; still saw ${lastState?.chipCount ?? 0} chips and ${lastState?.inputCount ?? 0} inputs.`,
    );
    throw new Error('Existing attachments still present in composer; aborting to avoid duplicate uploads.');
  }
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  expectedNames: string[] = [],
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expectedNormalized = expectedNames.map((name) => name.toLowerCase());
  let inputMatchSince: number | null = null;
  let sawInputMatch = false;
  let attachmentMatchSince: number | null = null;
  let lastVerboseLog = 0;
  const expression = `(() => {
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const findPromptNode = () => {
      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return node;
        }
      }
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const attachmentSelectors = [
      'input[type="file"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      '[aria-label*="remove"]',
    ];
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
      if (!composerRoot) return document;
      const parent = composerRoot.parentElement;
      const parentHasSend = parent && sendSelectors.some((selector) => parent.querySelector(selector));
      return parentHasSend ? parent : composerRoot;
    })();
    let button = null;
    for (const selector of sendSelectors) {
      button = document.querySelector(selector);
      if (button) break;
    }
    const disabled = button
      ? button.hasAttribute('disabled') ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.getAttribute('data-disabled') === 'true' ||
        window.getComputedStyle(button).pointerEvents === 'none'
      : null;
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((node) => {
        const ariaBusy = node.getAttribute?.('aria-busy');
        const dataState = node.getAttribute?.('data-state');
        if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
          return true;
        }
        // Avoid false positives from user prompts ("upload:") or generic UI copy; only treat explicit progress strings as uploading.
        const text = node.textContent?.toLowerCase?.() ?? '';
        return /\buploading\b/.test(text) || /\bprocessing\b/.test(text);
      });
    });
    const attachmentChipSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove"]',
      'button[aria-label*="Remove"]',
    ];
    const attachedNames = [];
    for (const selector of attachmentChipSelectors) {
      for (const node of Array.from(composerScope.querySelectorAll(selector))) {
        if (!node) continue;
        const text = node.textContent ?? '';
        const aria = node.getAttribute?.('aria-label') ?? '';
        const title = node.getAttribute?.('title') ?? '';
        const parentText = node.parentElement?.parentElement?.innerText ?? '';
        for (const value of [text, aria, title, parentText]) {
          const normalized = value?.toLowerCase?.();
          if (normalized) attachedNames.push(normalized);
        }
      }
    }
    const cardTexts = Array.from(composerScope.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    attachedNames.push(...cardTexts.filter(Boolean));

    const inputNames = [];
    const inputScope = composerScope ? Array.from(composerScope.querySelectorAll('input[type="file"]')) : [];
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
    const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
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
    const localFileCountNodes = composerScope
      ? Array.from(composerScope.querySelectorAll(fileCountSelectors))
      : [];
    let fileCount = collectFileCount(localFileCountNodes);
    if (!fileCount) {
      fileCount = collectFileCount(Array.from(document.querySelectorAll(fileCountSelectors)));
    }
    const filesAttached = attachedNames.length > 0 || fileCount > 0;
    return {
      state: button ? (disabled ? 'disabled' : 'ready') : 'missing',
      uploading,
      filesAttached,
      attachedNames,
      inputNames,
      fileCount,
    };
  })()`;
  while (Date.now() < deadline) {
    const response = await Runtime.evaluate({ expression, returnByValue: true });
    const { result } = response;
    const value = result?.value as {
      state?: string;
      uploading?: boolean;
      filesAttached?: boolean;
      attachedNames?: string[];
      inputNames?: string[];
      fileCount?: number;
    } | undefined;
    if (!value && logger?.verbose) {
      const exception = (response as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
        ?.exceptionDetails;
      if (exception) {
        const details = [exception.text, exception.exception?.description]
          .filter((part) => Boolean(part))
          .join(' - ');
        logger(`Attachment wait eval failed: ${details || 'unknown error'}`);
      }
    }
    if (value) {
      if (logger?.verbose) {
        const now = Date.now();
        if (now - lastVerboseLog > 3000) {
          lastVerboseLog = now;
          logger(
            `Attachment wait state: ${JSON.stringify({
              state: value.state,
              uploading: value.uploading,
              filesAttached: value.filesAttached,
              attachedNames: (value.attachedNames ?? []).slice(0, 3),
              inputNames: (value.inputNames ?? []).slice(0, 3),
              fileCount: value.fileCount ?? 0,
            })}`,
          );
        }
      }
      const attachedNames = (value.attachedNames ?? [])
        .map((name) => name.toLowerCase().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const inputNames = (value.inputNames ?? [])
        .map((name) => name.toLowerCase().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const fileCount = typeof value.fileCount === 'number' ? value.fileCount : 0;
      const fileCountSatisfied = expectedNormalized.length > 0 && fileCount >= expectedNormalized.length;
      const matchesExpected = (expected: string): boolean => {
        const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
        const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
        const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
        return attachedNames.some((raw) => {
          if (raw.includes(normalizedExpected)) return true;
          if (expectedNoExt.length >= 6 && raw.includes(expectedNoExt)) return true;
          if (raw.includes('…') || raw.includes('...')) {
            const marker = raw.includes('…') ? '…' : '...';
            const [prefixRaw, suffixRaw] = raw.split(marker);
            const prefix = prefixRaw.trim();
            const suffix = suffixRaw.trim();
            const target = expectedNoExt.length >= 6 ? expectedNoExt : normalizedExpected;
            const matchesPrefix = !prefix || target.includes(prefix);
            const matchesSuffix = !suffix || target.includes(suffix);
            return matchesPrefix && matchesSuffix;
          }
          return false;
        });
      };
      const missing = expectedNormalized.filter((expected) => !matchesExpected(expected));
      if (missing.length === 0 || fileCountSatisfied) {
        const stableThresholdMs = value.uploading ? 3000 : 1500;
        if (attachmentMatchSince === null) {
          attachmentMatchSince = Date.now();
        }
        const stable = Date.now() - attachmentMatchSince > stableThresholdMs;
        if (stable && value.state === 'ready') {
          return;
        }
        // Don't treat disabled button as complete - wait for it to become 'ready'.
        // The spinner detection is unreliable, so a disabled button likely means upload is in progress.
        if (value.state === 'missing' && (value.filesAttached || fileCountSatisfied)) {
          return;
        }
        // If files are attached but button isn't ready yet, give it more time but don't fail immediately.
        if (value.filesAttached || fileCountSatisfied) {
          await delay(500);
          continue;
        }
      } else {
        attachmentMatchSince = null;
      }

      // Fallback: if the file input has the expected names, allow progress once that condition is stable.
      // Some ChatGPT surfaces only render the filename after sending the message.
      const inputMissing = expectedNormalized.filter((expected) => {
        const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
        const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
        const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
        return !inputNames.some(
          (raw) => raw.includes(normalizedExpected) || (expectedNoExt.length >= 6 && raw.includes(expectedNoExt)),
        );
      });
      // Don't include 'disabled' - a disabled button likely means upload is still in progress.
      const inputStateOk = value.state === 'ready' || value.state === 'missing';
      const inputSeenNow = inputMissing.length === 0 || fileCountSatisfied;
      const inputEvidenceOk = Boolean(value.filesAttached) || Boolean(value.uploading) || fileCountSatisfied;
      const stableThresholdMs = value.uploading ? 3000 : 1500;
      if (inputSeenNow && inputStateOk && inputEvidenceOk) {
        if (inputMatchSince === null) {
          inputMatchSince = Date.now();
        }
        sawInputMatch = true;
      }
      if (inputMatchSince !== null && inputStateOk && inputEvidenceOk && Date.now() - inputMatchSince > stableThresholdMs) {
        return;
      }
      if (!inputSeenNow && !sawInputMatch) {
        inputMatchSince = null;
      }
    }
    await delay(250);
  }
  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'file-upload-timeout');
  throw new Error('Attachments did not finish uploading before timeout.');
}

export async function waitForUserTurnAttachments(
  Runtime: ChromeClient['Runtime'],
  expectedNames: string[],
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<boolean> {
  if (!expectedNames || expectedNames.length === 0) {
    return true;
  }

  const expectedNormalized = expectedNames.map((name) => name.toLowerCase());
  const conversationSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const expression = `(() => {
    const CONVERSATION_SELECTOR = ${conversationSelectorLiteral};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const userTurns = turns.filter((node) => {
      const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (attr === 'user') return true;
      return Boolean(node.querySelector('[data-message-author-role="user"]'));
    });
    const lastUser = userTurns[userTurns.length - 1];
    if (!lastUser) return { ok: false };
    const text = (lastUser.innerText || '').toLowerCase();
    const attrs = Array.from(lastUser.querySelectorAll('[aria-label],[title]')).map((el) => {
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      return (aria + ' ' + title).trim().toLowerCase();
    }).filter(Boolean);
    const attachmentSelectors = [
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="chip"]',
      '[aria-label*="file"]',
      '[aria-label*="attachment"]',
      '[title*="file"]',
      '[title*="attachment"]',
    ];
    const attachmentUiCount = lastUser.querySelectorAll(attachmentSelectors.join(',')).length;
    const hasAttachmentUi =
      attachmentUiCount > 0 || attrs.some((attr) => attr.includes('file') || attr.includes('attachment'));
    const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
    const fileCountNodes = Array.from(lastUser.querySelectorAll('button,span,div,[aria-label],[title]'));
    let fileCount = 0;
    for (const node of fileCountNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches('textarea,input,[contenteditable="true"]')) continue;
      const dataTestId = node.getAttribute?.('data-testid') ?? '';
      const aria = node.getAttribute?.('aria-label') ?? '';
      const title = node.getAttribute?.('title') ?? '';
      const tooltip =
        node.getAttribute?.('data-tooltip') ?? node.getAttribute?.('data-tooltip-content') ?? '';
      const nodeText = node.textContent ?? '';
      const candidates = [nodeText, aria, title, tooltip, dataTestId];
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
          const count = Number(match[1]);
          if (Number.isFinite(count)) {
            fileCount = Math.max(fileCount, count);
          }
        }
      }
    }
    return { ok: true, text, attrs, fileCount, hasAttachmentUi, attachmentUiCount };
  })()`;

  const deadline = Date.now() + timeoutMs;
  let sawAttachmentUi = false;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as
      | {
          ok?: boolean;
          text?: string;
          attrs?: string[];
          fileCount?: number;
          hasAttachmentUi?: boolean;
          attachmentUiCount?: number;
        }
      | undefined;
    if (!value?.ok) {
      await delay(200);
      continue;
    }
    if (value.hasAttachmentUi) {
      sawAttachmentUi = true;
    }
    const haystack = [value.text ?? '', ...(value.attrs ?? [])].join('\n');
    const fileCount = typeof value.fileCount === 'number' ? value.fileCount : 0;
    const attachmentUiCount = typeof value.attachmentUiCount === 'number' ? value.attachmentUiCount : 0;
    const fileCountSatisfied = fileCount >= expectedNormalized.length && expectedNormalized.length > 0;
    const attachmentUiSatisfied =
      attachmentUiCount >= expectedNormalized.length && expectedNormalized.length > 0;
    const missing = expectedNormalized.filter((expected) => {
      const baseName = expected.split('/').pop()?.split('\\').pop() ?? expected;
      const normalizedExpected = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
      const expectedNoExt = normalizedExpected.replace(/\.[a-z0-9]{1,10}$/i, '');
      if (haystack.includes(normalizedExpected)) return false;
      if (expectedNoExt.length >= 6 && haystack.includes(expectedNoExt)) return false;
      return true;
    });
    if (missing.length === 0 || fileCountSatisfied || attachmentUiSatisfied) {
      return true;
    }
    await delay(250);
  }

  if (!sawAttachmentUi) {
    logger?.('Sent user message did not expose attachment UI; skipping attachment verification.');
    return false;
  }

  logger?.('Sent user message did not show expected attachment names in time.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'attachment-missing-user-turn');
  throw new Error('Attachment was not present on the sent user message.');
}

export async function waitForAttachmentVisible(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
  logger?: BrowserLogger,
): Promise<void> {
  // Attachments can take a few seconds to render in the composer (headless/remote Chrome is slower),
  // so respect the caller-provided timeout instead of capping at 2s.
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const expected = ${JSON.stringify(expectedName)};
    const normalized = expected.toLowerCase();
    const normalizedNoExt = normalized.replace(/\\.[a-z0-9]{1,10}$/i, '');
    const matchesExpectedFileName = (value) => {
      const text = String(value || '').toLowerCase();
      if (!text) return false;
      if (text.includes(normalized)) return true;
      return normalizedNoExt.length >= 6 && text.includes(normalizedNoExt);
    };
    const matchNode = (node) => {
      if (!node) return false;
      if (node.tagName === 'INPUT' && node.type === 'file') return false;
      const text = (node.textContent || '').toLowerCase();
      const aria = node.getAttribute?.('aria-label')?.toLowerCase?.() ?? '';
      const title = node.getAttribute?.('title')?.toLowerCase?.() ?? '';
      const testId = node.getAttribute?.('data-testid')?.toLowerCase?.() ?? '';
      const alt = node.getAttribute?.('alt')?.toLowerCase?.() ?? '';
      const candidates = [text, aria, title, testId, alt].filter(Boolean);
      return candidates.some((value) => value.includes(normalized) || (normalizedNoExt.length >= 6 && value.includes(normalizedNoExt)));
    };

    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue;
      const files = Array.from(input.files || []);
      if (files.some((file) => matchesExpectedFileName(file?.name))) {
        return { found: true, source: 'file-input' };
      }
    }

    const promptSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const findPromptNode = () => {
      for (const selector of promptSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return node;
        }
      }
      for (const selector of promptSelectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const attachmentSelectors = [
      'input[type="file"]',
      '[data-testid*="attachment"]',
      '[data-testid*="chip"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove"]',
      '[aria-label*="remove"]',
    ];
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
            if (hasAttachment) return current;
          }
          current = current.parentElement;
        }
        return fallback ?? initial;
      }
      return document.querySelector('form') ?? document.body;
    };
    const composerRoot = locateComposerRoot() ?? document.body;

    const attachmentMatch = ['[data-testid*="attachment"]','[data-testid*="chip"]','[data-testid*="upload"]','[data-testid*="file"]'].some((selector) =>
      Array.from(composerRoot.querySelectorAll(selector)).some(matchNode),
    );
    if (attachmentMatch) {
      return { found: true, source: 'attachments' };
    }

    const removeButtons = Array.from(
      (composerRoot ?? document).querySelectorAll('[aria-label*="Remove"],[aria-label*="remove"]'),
    );
    const visibleRemove = removeButtons.some((btn) => {
      if (!(btn instanceof HTMLElement)) return false;
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    if (visibleRemove) {
      return { found: true, source: 'remove-button' };
    }

    const cardTexts = Array.from(composerRoot.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cardTexts.some((text) => text.includes(normalized) || (normalizedNoExt.length >= 6 && text.includes(normalizedNoExt)))) {
      return { found: true, source: 'attachment-cards' };
    }

    const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
    const fileCountNodes = Array.from(composerRoot.querySelectorAll('button,span,div,[aria-label],[title]'));
    let fileCount = 0;
    for (const node of fileCountNodes) {
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
          const count = Number(match[1]);
          if (Number.isFinite(count)) {
            fileCount = Math.max(fileCount, count);
          }
        }
      }
    }
    if (fileCount > 0) {
      return { found: true, source: 'file-count' };
    }

    return { found: false };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as { found?: boolean } | undefined;
    if (value?.found) {
      return;
    }
    await delay(200);
  }
  logger?.('Attachment not visible in composer; giving up.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'attachment-visible');
  throw new Error('Attachment did not appear in ChatGPT composer.');
}

async function waitForAttachmentAnchored(
  Runtime: ChromeClient['Runtime'],
  expectedName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expression = `(() => {
    const normalized = ${JSON.stringify(expectedName.toLowerCase())};
    const normalizedNoExt = normalized.replace(/\\.[a-z0-9]{1,10}$/i, '');
    const matchesExpected = (value) => {
      const text = (value ?? '').toLowerCase();
      if (!text) return false;
      if (text.includes(normalized)) return true;
      if (normalizedNoExt.length >= 6 && text.includes(normalizedNoExt)) return true;
      if (text.includes('…') || text.includes('...')) {
        const marker = text.includes('…') ? '…' : '...';
        const [prefixRaw, suffixRaw] = text.split(marker);
        const prefix = (prefixRaw ?? '').toLowerCase();
        const suffix = (suffixRaw ?? '').toLowerCase();
        const target = normalizedNoExt.length >= 6 ? normalizedNoExt : normalized;
        const matchesPrefix = !prefix || target.includes(prefix);
        const matchesSuffix = !suffix || target.includes(suffix);
        return matchesPrefix && matchesSuffix;
      }
      return false;
    };

    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue;
      for (const file of Array.from(input.files || [])) {
        if (file?.name && matchesExpected(file.name)) {
          return { found: true, text: 'file-input' };
        }
      }
    }

    const selectors = [
      '[data-testid*="attachment"]',
      '[data-testid*="chip"]',
      '[data-testid*="upload"]',
      '[aria-label*="Remove"]',
      'button[aria-label*="Remove"]',
      '[aria-label*="remove"]',
      'button[aria-label*="remove"]',
    ];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (node?.tagName === 'INPUT' && node?.type === 'file') continue;
        const text = node?.textContent || '';
        const aria = node?.getAttribute?.('aria-label') || '';
        const title = node?.getAttribute?.('title') || '';
        if ([text, aria, title].some(matchesExpected)) {
          return { found: true, text: (text || aria || title).toLowerCase() };
        }
      }
    }
    const cards = Array.from(document.querySelectorAll('[aria-label*="Remove"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cards.some(matchesExpected)) {
      return { found: true, text: cards.find(matchesExpected) };
    }
    const countRegex = /(?:^|\\b)(\\d+)\\s+(?:files?|attachments?)\\b/;
    const fileCountNodes = (() => {
      const nodes = [];
      const seen = new Set();
      const add = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        nodes.push(node);
      };
      const root =
        document.querySelector('[data-testid*="composer"]') || document.querySelector('form') || document.body;
      const localNodes = root ? Array.from(root.querySelectorAll('button,span,div,[aria-label],[title]')) : [];
      for (const node of localNodes) add(node);
      for (const node of Array.from(document.querySelectorAll('button,span,div,[aria-label],[title]'))) {
        add(node);
      }
      return nodes;
    })();
    let fileCount = 0;
    for (const node of fileCountNodes) {
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
          const count = Number(match[1]);
          if (Number.isFinite(count)) {
            fileCount = Math.max(fileCount, count);
          }
        }
      }
    }
    if (fileCount > 0) {
      return { found: true, text: 'file-count' };
    }
    return { found: false };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    if (result?.value?.found) {
      return true;
    }
    await delay(200);
  }
  return false;
}
