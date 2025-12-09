import path from 'node:path';
import type { ChromeClient, BrowserAttachment, BrowserLogger } from '../types.js';
import { FILE_INPUT_SELECTORS, SEND_BUTTON_SELECTORS, UPLOAD_STATUS_SELECTORS } from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function uploadAttachmentFile(
  deps: { runtime: ChromeClient['Runtime']; dom?: ChromeClient['DOM'] },
  attachment: BrowserAttachment,
  logger: BrowserLogger,
) {
  const { runtime, dom } = deps;
  if (!dom) {
    throw new Error('DOM domain unavailable while uploading attachments.');
  }

  const isAttachmentPresent = async (name: string) => {
    const check = await runtime.evaluate({
      expression: `(() => {
        const expected = ${JSON.stringify(name.toLowerCase())};
        const selectors = [
          '[data-testid*="attachment"]',
          '[data-testid*="chip"]',
          '[data-testid*="upload"]'
        ];
        const chips = selectors.some((selector) =>
          Array.from(document.querySelectorAll(selector)).some((node) =>
            (node?.textContent || '').toLowerCase().includes(expected),
          ),
        );
        if (chips) return true;
        const cardTexts = Array.from(document.querySelectorAll('[aria-label="Remove file"]')).map((btn) =>
          btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
        );
        if (cardTexts.some((text) => text.includes(expected))) return true;

        const filesPill = Array.from(document.querySelectorAll('button,div')).some((node) => {
          const text = (node?.textContent || '').toLowerCase();
          return /\bfiles\b/.test(text) && text.includes('file');
        });
        if (filesPill) return true;

        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
          Array.from(el.files || []).some((f) => f?.name?.toLowerCase?.().includes(expected)),
        );
        return inputs;
      })()`,
      returnByValue: true,
    });
    return Boolean(check?.result?.value);
  };

  // New ChatGPT UI hides the real file input behind a composer "+" menu; click it pre-emptively.
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

  await delay(250);

  // Helper to click the upload menu item (if present) to reveal the real attachment input.
  await Promise.resolve(
    runtime.evaluate({
      expression: `(() => {
        const menuItems = Array.from(document.querySelectorAll('[data-testid*="upload"],[data-testid*="attachment"], [role="menuitem"], [data-radix-collection-item]'));
        for (const el of menuItems) {
          const text = (el.textContent || '').toLowerCase();
          const tid = el.getAttribute?.('data-testid')?.toLowerCase?.() || '';
          if (tid.includes('upload') || tid.includes('attachment') || text.includes('upload') || text.includes('file')) {
            if (el instanceof HTMLElement) { el.click(); return true; }
          }
        }
        return false;
      })()`,
      returnByValue: true,
    }),
  ).catch(() => undefined);

  const expectedName = path.basename(attachment.path);

  if (await isAttachmentPresent(expectedName)) {
    logger(`Attachment already present: ${path.basename(attachment.path)}`);
    return;
  }

  // Find a real input; prefer non-image accept fields and tag it for DOM.setFileInputFiles.
  const markResult = await runtime.evaluate({
    expression: `(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const acceptIsImageOnly = (accept) => {
        if (!accept) return false;
        const parts = String(accept)
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
        return parts.length > 0 && parts.every((p) => p.startsWith('image/'));
      };
      const nonImage = inputs.filter((el) => !acceptIsImageOnly(el.getAttribute('accept')));
      const target = (nonImage.length ? nonImage[nonImage.length - 1] : inputs[inputs.length - 1]) ?? null;
      if (target) {
        target.setAttribute('data-oracle-upload-target', 'true');
        return true;
      }
      return false;
    })()`,
    returnByValue: true,
  });
  const marked = Boolean(markResult?.result?.value);
  if (!marked) {
    await logDomFailure(runtime, logger, 'file-input-missing');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }

  const documentNode = await dom.getDocument();
  const resultNode = await dom.querySelector({ nodeId: documentNode.root.nodeId, selector: 'input[type="file"][data-oracle-upload-target="true"]' });
  if (!resultNode?.nodeId) {
    await logDomFailure(runtime, logger, 'file-input-missing');
    throw new Error('Unable to locate ChatGPT file attachment input.');
  }
  const resolvedNodeId = resultNode.nodeId;

  const dispatchEvents = FILE_INPUT_SELECTORS
    .map((selector) => `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el instanceof HTMLInputElement) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })();
    `)
    .join('\\n');

  const tryFileInput = async () => {
    await dom.setFileInputFiles({ nodeId: resolvedNodeId, files: [attachment.path] });
    await runtime.evaluate({ expression: `(function(){${dispatchEvents} return true;})()`, returnByValue: true });
  };

  await tryFileInput();

  if (await waitForAttachmentAnchored(runtime, expectedName, 20_000)) {
    await waitForAttachmentVisible(runtime, expectedName, 20_000, logger);
    logger('Attachment queued (file input)');
    return;
  }

  await logDomFailure(runtime, logger, 'file-upload-missing');
  throw new Error('Attachment did not register with the ChatGPT composer in time.');
}

export async function waitForAttachmentCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  expectedNames: string[] = [],
  logger?: BrowserLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expectedNormalized = expectedNames.map((name) => name.toLowerCase());
  const expression = `(() => {
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
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
        const text = node.textContent?.toLowerCase?.() ?? '';
        return text.includes('upload') || text.includes('processing') || text.includes('uploading');
      });
    });
    const attachmentSelectors = ['[data-testid*="chip"]', '[data-testid*="attachment"]', '[data-testid*="upload"]'];
    const attachedNames = [];
    for (const selector of attachmentSelectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = node?.textContent?.toLowerCase?.();
        if (text) attachedNames.push(text);
      }
    }
    for (const input of Array.from(document.querySelectorAll('input[type="file"]'))) {
      if (!(input instanceof HTMLInputElement) || !input.files?.length) continue;
      for (const file of Array.from(input.files)) {
        if (file?.name) attachedNames.push(file.name.toLowerCase());
      }
    }
    const cardTexts = Array.from(document.querySelectorAll('[aria-label="Remove file"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    attachedNames.push(...cardTexts.filter(Boolean));
    const filesPills = Array.from(document.querySelectorAll('button,div'))
      .map((node) => (node?.textContent || '').toLowerCase())
      .filter((text) => /\bfiles\b/.test(text));
    attachedNames.push(...filesPills);
    const filesAttached = attachedNames.length > 0;
    return { state: button ? (disabled ? 'disabled' : 'ready') : 'missing', uploading, filesAttached, attachedNames };
  })()`;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = result?.value as {
      state?: string;
      uploading?: boolean;
      filesAttached?: boolean;
      attachedNames?: string[];
    } | undefined;
    if (value && !value.uploading) {
      const attached = new Set((value.attachedNames ?? []).map((name) => name.toLowerCase()));
      const missing = expectedNormalized.filter((name) => !attached.has(name));
      if (missing.length === 0) {
        if (value.state === 'ready') {
          return;
        }
        if (value.state === 'missing' && value.filesAttached) {
          return;
        }
      }
    }
    await delay(250);
  }
  logger?.('Attachment upload timed out while waiting for ChatGPT composer to become ready.');
  await logDomFailure(Runtime, logger ?? (() => {}), 'file-upload-timeout');
  throw new Error('Attachments did not finish uploading before timeout.');
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
    const matchNode = (node) => {
      if (!node) return false;
      const text = (node.textContent || '').toLowerCase();
      const aria = node.getAttribute?.('aria-label')?.toLowerCase?.() ?? '';
      const title = node.getAttribute?.('title')?.toLowerCase?.() ?? '';
      const testId = node.getAttribute?.('data-testid')?.toLowerCase?.() ?? '';
      const alt = node.getAttribute?.('alt')?.toLowerCase?.() ?? '';
      return [text, aria, title, testId, alt].some((value) => value.includes(normalized));
    };

    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    const userTurns = turns.filter((node) => node.querySelector('[data-message-author-role="user"]'));
    const lastUser = userTurns[userTurns.length - 1];
    if (lastUser) {
      const turnMatch = Array.from(lastUser.querySelectorAll('*')).some(matchNode);
      if (turnMatch) return { found: true, userTurns: userTurns.length, source: 'turn' };
    }

    const composerSelectors = [
      '[data-testid*="composer"]',
      'form textarea',
      'form [data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="chip"]',
      'form',
      'button',
      'label'
    ];
    const composerMatch = composerSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(matchNode),
    );
    if (composerMatch) {
      return { found: true, userTurns: userTurns.length, source: 'composer' };
    }

    const attachmentSelectors = ['[data-testid*="attachment"]','[data-testid*="chip"]','[data-testid*="upload"]'];
    const attachmentMatch = attachmentSelectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(matchNode),
    );
    if (attachmentMatch) {
      return { found: true, userTurns: userTurns.length, source: 'attachments' };
    }

    const cardTexts = Array.from(document.querySelectorAll('[aria-label="Remove file"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cardTexts.some((text) => text.includes(normalized))) {
      return { found: true, userTurns: userTurns.length, source: 'attachment-cards' };
    }

    const filesPills = Array.from(document.querySelectorAll('button,div')).map((node) =>
      (node?.textContent || '').toLowerCase(),
    );
    if (filesPills.some((text) => /\bfiles\b/.test(text))) {
      return { found: true, userTurns: userTurns.length, source: 'files-pill' };
    }

    const attrMatch = Array.from(document.querySelectorAll('[aria-label], [title], [data-testid]')).some(matchNode);
    if (attrMatch) {
      return { found: true, userTurns: userTurns.length, source: 'attrs' };
    }

    const bodyMatch = (document.body?.innerText || '').toLowerCase().includes(normalized);
    if (bodyMatch) {
      return { found: true, userTurns: userTurns.length, source: 'body' };
    }

    const inputHit = Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
      Array.from(el.files || []).some((file) => file?.name?.toLowerCase?.().includes(normalized)),
    );
    return { found: inputHit, userTurns: userTurns.length, source: inputHit ? 'input' : undefined };
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
    const selectors = ['[data-testid*="attachment"]','[data-testid*="chip"]','[data-testid*="upload"]'];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node?.textContent || '').toLowerCase();
        if (text.includes(normalized)) {
          return { found: true, text };
        }
      }
    }
    const cards = Array.from(document.querySelectorAll('[aria-label="Remove file"]')).map((btn) =>
      btn?.parentElement?.parentElement?.innerText?.toLowerCase?.() ?? '',
    );
    if (cards.some((text) => text.includes(normalized))) {
      return { found: true, text: cards.find((t) => t.includes(normalized)) };
    }

    const filesPills = Array.from(document.querySelectorAll('button,div')).map((node) =>
      (node?.textContent || '').toLowerCase(),
    );
    if (filesPills.some((text) => /\bfiles\b/.test(text))) {
      return { found: true, text: filesPills.find((t) => /\bfiles\b/.test(t)) };
    }

    // As a last resort, treat file inputs that hold the target name as anchored. Some UIs delay chip rendering.
    const inputHit = Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
      Array.from(el.files || []).some((file) => file?.name?.toLowerCase?.().includes(normalized)),
    );
    if (inputHit) {
      return { found: true, text: 'input-only' };
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
