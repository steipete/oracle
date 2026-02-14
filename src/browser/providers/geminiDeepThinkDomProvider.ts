import type { ProviderDomAdapter, ProviderDomFlowContext } from '../providerDomFlow.js';
import { joinSelectors } from '../providerDomFlow.js';

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

export const GEMINI_DEEP_THINK_SELECTORS = {
  input: ['rich-textarea .ql-editor', '[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'],
  sendButton: ['button.send-button', 'button[aria-label="Send message"]'],
  toolsButton: ['button.toolbox-drawer-button', 'button[aria-label="Tools"]'],
  toolsMenuItem: ['[role="menuitemcheckbox"]', '.toolbox-drawer-item-list-button'],
  deepThinkActive: ['.toolbox-drawer-item-deselect-button', 'button[aria-label*="Deselect Deep Think"]'],
  uploadButton: ['button[aria-label="Open upload file menu"]', '.upload-card-button'],
  uploadMenuItem: ['[role="menuitem"]'],
  uploadTrigger: ['.hidden-local-file-upload-button', '.hidden-local-upload-button'],
  uploaderContainer: ['.uploader-button-container', '.file-uploader'],
  uploaderElement: ['uploader.upload-button'],
  userTurnAttachment: ['.file-preview-container'],
  responseTurn: ['model-response'],
  responseText: ['message-content', '.model-response-text message-content'],
  responseComplete: ['.response-footer.complete'],
  userQuery: ['user-query'],
  userQueryText: ['user-query-content', '.query-text'],
  spinner: ['[role="progressbar"]'],
  thoughtsToggle: ['.thoughts-header-button', '[data-test-id="thoughts-header-button"]'],
  thoughtsContent: ['model-thoughts', '[data-test-id="model-thoughts"]'],
  hasThoughts: ['.has-thoughts'],
} as const;

function asSelectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.('[gemini-web] Waiting for Gemini UI to load...');
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const uiDeadline = Date.now() + UI_TIMEOUT_MS;
  let uiReady = false;
  let sawLoginRedirect = false;

  while (Date.now() < uiDeadline) {
    const state = await ctx.evaluate<{ ready?: boolean; requiresLogin?: boolean }>(
      `(() => {
        const editor = document.querySelector(${inputSelector});
        const href = location.href || '';
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const requiresLogin =
          href.includes('accounts.google.com') ||
          (bodyText.includes('sign in') && bodyText.includes('google'));
        return { ready: Boolean(editor), requiresLogin };
      })()`,
    );
    if (state?.ready) {
      uiReady = true;
      break;
    }
    if (state?.requiresLogin) {
      sawLoginRedirect = true;
    }
    await ctx.delay(1_000);
  }

  if (!uiReady) {
    if (sawLoginRedirect) {
      throw new Error('Gemini is showing a sign-in flow. Please sign in in Chrome and retry.');
    }
    throw new Error('Timed out waiting for Gemini UI prompt input to become ready.');
  }
}

async function selectMode(ctx: ProviderDomFlowContext): Promise<void> {
  const toolsButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsButton);
  const toolsClickResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${toolsButtonSelectors});
      if (btn instanceof HTMLElement) {
        btn.click();
        return 'clicked';
      }
      return 'not-found';
    })()`,
  );
  if (toolsClickResult !== 'clicked') {
    throw new Error('Unable to open Gemini tools menu; Deep Think toggle is not accessible.');
  }
  await ctx.delay(1_000);

  const deepThinkItemSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.toolsMenuItem);
  const deepThinkClickResult = await ctx.evaluate<string>(
    `(() => {
      const items = Array.from(document.querySelectorAll(${deepThinkItemSelectors}));
      for (const item of items) {
        const text = item.textContent?.trim().toLowerCase() ?? '';
        if (!text.includes('deep think')) continue;
        if (item instanceof HTMLElement) item.click();
        return 'clicked';
      }
      return 'not-found';
    })()`,
  );
  if (deepThinkClickResult !== 'clicked') {
    throw new Error('Unable to select "Deep Think" from Gemini tools menu.');
  }
  await ctx.delay(1_500);

  const deepThinkActiveSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.deepThinkActive);
  const deepThinkActive = await ctx.evaluate<boolean>(
    `(() => {
      const active = document.querySelector(${deepThinkActiveSelectors});
      if (!(active instanceof HTMLElement)) return false;
      const label = active.getAttribute('aria-label')?.toLowerCase() ?? '';
      const text = active.textContent?.toLowerCase() ?? '';
      return label.includes('deep think') || text.includes('deep think');
    })()`,
  );
  if (!deepThinkActive) {
    throw new Error('Deep Think did not appear selected after clicking the tools menu item.');
  }
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.('[gemini-web] Typing prompt...');
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const typeResult = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${inputSelector});
      if (!(editor instanceof HTMLElement)) return 'no-editor';
      editor.focus();
      editor.textContent = '';
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, ${JSON.stringify(ctx.prompt)});
      } else {
        editor.textContent = ${JSON.stringify(ctx.prompt)};
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(ctx.prompt)} }));
      }
      const typed = (editor.textContent || '').trim().length > 0;
      return typed ? 'typed' : 'empty';
    })()`,
  );
  if (typeResult !== 'typed') {
    throw new Error(`Failed to type Gemini prompt (status=${typeResult ?? 'unknown'}).`);
  }
  await ctx.delay(500);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.('[gemini-web] Sending prompt...');
  const inputSelector = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.input);
  const sendButtonSelectors = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.sendButton);
  const sendResult = await ctx.evaluate<string>(
    `(() => {
      const btn = document.querySelector(${sendButtonSelectors});
      if (btn instanceof HTMLElement) {
        btn.click();
        return 'clicked';
      }
      const editor = document.querySelector(${inputSelector});
      if (editor instanceof HTMLElement) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        return 'enter';
      }
      return 'not-found';
    })()`,
  );
  if (sendResult !== 'clicked' && sendResult !== 'enter') {
    throw new Error('Failed to submit prompt in Gemini Deep Think mode (send control not found).');
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{ text: string }> {
  ctx.log?.('[gemini-web] Waiting for Deep Think response (this may take a while)...');
  const responseTurnSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseTurn);
  const responseTextSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseText);
  const responseCompleteSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.responseComplete);
  const spinnerSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.spinner);
  const responseDeadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let lastLog = 0;
  let responseText = '';

  while (Date.now() < responseDeadline) {
    const payload = await ctx.evaluate<string>(
      `(() => {
        const turns = document.querySelectorAll(${responseTurnSel});
        if (turns.length === 0) return JSON.stringify({ status: 'waiting' });
        const lastTurn = turns[turns.length - 1];
        const footer = lastTurn.querySelector(${responseCompleteSel});
        const content = lastTurn.querySelector(${responseTextSel});
        const text = content?.textContent?.trim() ?? '';
        const lower = text.toLowerCase();
        if (lower.includes('generating your response') || lower.includes('check back later') || lower.includes("i'm on it")) {
          return JSON.stringify({ status: 'generating' });
        }
        if (footer && text.length > 0) {
          return JSON.stringify({ status: 'done', text });
        }
        const spinners = lastTurn.querySelectorAll(${spinnerSel});
        const visibleSpinners = Array.from(spinners).filter((s) => s instanceof HTMLElement && s.offsetParent !== null);
        if (text.length > 0 && visibleSpinners.length === 0 && !footer) {
          return JSON.stringify({ status: 'streaming' });
        }
        return JSON.stringify({ status: 'generating' });
      })()`,
    );

    try {
      const parsed = JSON.parse(payload ?? '{}') as { status?: string; text?: string };
      if (parsed.status === 'done' && typeof parsed.text === 'string' && parsed.text.length > 0) {
        responseText = parsed.text;
        break;
      }
      const now = Date.now();
      if (now - lastLog > 10_000) {
        ctx.log?.(`[gemini-web] Deep Think still generating... (${parsed.status ?? 'unknown'})`);
        lastLog = now;
      }
    } catch {
      // ignore parse errors while polling
    }
    await ctx.delay(3_000);
  }

  if (!responseText) {
    throw new Error('Deep Think timed out waiting for response (10 minutes).');
  }
  return { text: responseText };
}

async function extractThoughts(ctx: ProviderDomFlowContext): Promise<string | null> {
  const thoughtsToggleSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsToggle);
  const thoughtsContentSel = asSelectorLiteral(GEMINI_DEEP_THINK_SELECTORS.thoughtsContent);

  const thinkResult = await ctx.evaluate<string>(
    `(() => {
      const toggle = document.querySelector(${thoughtsToggleSel});
      if (!(toggle instanceof HTMLElement)) return 'no-toggle';
      toggle.click();
      return 'clicked';
    })()`,
  );
  if (thinkResult !== 'clicked') {
    return null;
  }

  await ctx.delay(1_500);
  const extractedThoughts = await ctx.evaluate<string>(
    `(() => {
      const el = document.querySelector(${thoughtsContentSel});
      if (!el) return '';
      const full = el.textContent?.trim() ?? '';
      const btn = el.querySelector('.thoughts-header-button, [data-test-id="thoughts-header-button"]');
      const btnText = btn?.textContent?.trim() ?? '';
      if (btnText && full.startsWith(btnText)) {
        return full.slice(btnText.length).trim();
      }
      return full;
    })()`,
  );
  return typeof extractedThoughts === 'string' && extractedThoughts.length > 0 ? extractedThoughts : null;
}

export const geminiDeepThinkDomProvider: ProviderDomAdapter = {
  providerName: 'gemini-web',
  waitForUi,
  selectMode,
  typePrompt,
  submitPrompt,
  waitForResponse,
  extractThoughts,
};
