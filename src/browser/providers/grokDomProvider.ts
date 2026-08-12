import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { joinSelectors } from "../providerDomFlow.js";

const UI_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

interface GrokDomProviderState {
  inputTimeoutMs?: number;
  timeoutMs?: number;
  responseCountBeforeSubmit?: number;
}

export const GROK_SELECTORS = {
  input: [
    '[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"]',
    'textarea[aria-label="Ask Grok anything"]',
    'textarea[placeholder="What do you want to know?"]',
  ],
  sendButton: ['button[data-testid="chat-submit"]', 'button[aria-label="Submit"]'],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Cancel" i]',
  ],
  response: [
    '[data-testid="assistant-message"]',
    '[data-testid="response-message"]',
    '[data-message-author-role="assistant"]',
    '.message-bubble:not([data-testid="user-message"])',
  ],
  responseContent: [
    '[data-testid="assistant-message"] .response-content-markdown',
    '[data-testid="assistant-message"] .markdown',
    '[data-testid="response-message"] .response-content-markdown',
    '[data-testid="response-message"] .markdown',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] .response-content-markdown',
    '[data-testid="assistant-message"]',
    '[data-testid="response-message"]',
    '[data-message-author-role="assistant"]',
  ],
} as const;

function selectorLiteral(selectors: readonly string[]): string {
  return JSON.stringify(joinSelectors(selectors));
}

function readTimeouts(ctx: ProviderDomFlowContext): { ui: number; response: number } {
  const state = ctx.state as GrokDomProviderState | undefined;
  return {
    ui:
      typeof state?.inputTimeoutMs === "number"
        ? Math.max(1_000, state.inputTimeoutMs)
        : UI_TIMEOUT_MS,
    response:
      typeof state?.timeoutMs === "number" ? Math.max(1_000, state.timeoutMs) : RESPONSE_TIMEOUT_MS,
  };
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[grok-web] Waiting for Grok UI to load...");
  const input = selectorLiteral(GROK_SELECTORS.input);
  const deadline = Date.now() + readTimeouts(ctx).ui;
  while (Date.now() < deadline) {
    const state = await ctx.evaluate<{ ready?: boolean; blocked?: boolean }>(
      `(() => {
        const body = (document.body?.innerText || '').toLowerCase();
        return {
          ready: Boolean(document.querySelector(${input})),
          blocked: body.includes('verify you are human') || body.includes('checking your browser')
        };
      })()`,
    );
    if (state?.ready) return;
    if (state?.blocked) {
      throw new Error(
        "Grok is showing a browser verification challenge. Complete it in Chrome and retry.",
      );
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for the Grok prompt input.");
}

async function typePrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[grok-web] Typing prompt...");
  const input = selectorLiteral(GROK_SELECTORS.input);
  const result = await ctx.evaluate<string>(
    `(() => {
      const editor = document.querySelector(${input});
      if (!(editor instanceof HTMLElement)) return 'not-found';
      editor.focus();
      if (editor instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(editor, ${JSON.stringify(ctx.prompt)});
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return editor.value === ${JSON.stringify(ctx.prompt)} ? 'typed' : 'mismatch';
      }
      editor.textContent = '';
      const inserted = typeof document.execCommand === 'function' &&
        document.execCommand('insertText', false, ${JSON.stringify(ctx.prompt)});
      if (!inserted) {
        editor.textContent = ${JSON.stringify(ctx.prompt)};
        editor.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          inputType: 'insertText',
          data: ${JSON.stringify(ctx.prompt)}
        }));
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: ${JSON.stringify(ctx.prompt)}
        }));
      }
      return (editor.innerText || editor.textContent || '').trim() === ${JSON.stringify(ctx.prompt)}
        ? 'typed'
        : 'mismatch';
    })()`,
  );
  if (result !== "typed") {
    throw new Error(`Failed to type the Grok prompt (${result ?? "unknown"}).`);
  }
  await ctx.delay(300);
}

async function submitPrompt(ctx: ProviderDomFlowContext): Promise<void> {
  ctx.log?.("[grok-web] Sending prompt...");
  const send = selectorLiteral(GROK_SELECTORS.sendButton);
  const result = await ctx.evaluate<string>(
    `(() => {
      const button = document.querySelector(${send});
      if (!(button instanceof HTMLButtonElement)) return 'not-found';
      if (button.disabled) return 'disabled';
      button.click();
      return 'clicked';
    })()`,
  );
  if (result !== "clicked") {
    throw new Error(`Failed to submit the Grok prompt (${result ?? "unknown"}).`);
  }
}

async function waitForResponse(
  ctx: ProviderDomFlowContext,
): Promise<{ text: string; html?: string }> {
  ctx.log?.("[grok-web] Waiting for Grok response...");
  const response = selectorLiteral(GROK_SELECTORS.response);
  const responseContent = selectorLiteral(GROK_SELECTORS.responseContent);
  const stop = selectorLiteral(GROK_SELECTORS.stopButton);
  const state = ctx.state as GrokDomProviderState | undefined;
  const initialCount = state?.responseCountBeforeSubmit ?? 0;
  const deadline = Date.now() + readTimeouts(ctx).response;
  let previousText = "";
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const raw = await ctx.evaluate<string>(
      `(() => {
        const turns = Array.from(document.querySelectorAll(${response}));
        const body = (document.body?.innerText || '').toLowerCase();
        const loginRequired =
          Boolean(document.querySelector('[data-testid="anon-paywall-sign-up-card"]')) ||
          (body.includes('continue your conversation') && body.includes('sign up'));
        if (loginRequired) return JSON.stringify({ status: 'login-required' });
        if (turns.length <= ${initialCount}) return JSON.stringify({ status: 'waiting' });
        const last = turns[turns.length - 1];
        const content = last.matches(${responseContent}) ? last : last.querySelector(${responseContent});
        const text = (content?.innerText || content?.textContent || '').trim();
        const stopVisible = Array.from(document.querySelectorAll(${stop})).some(
          (node) => node instanceof HTMLElement && node.offsetParent !== null
        );
        if (!text || /^thought for \\d+s?$/i.test(text)) {
          return JSON.stringify({ status: stopVisible ? 'streaming' : 'waiting', text: '' });
        }
        const html = content?.innerHTML || '';
        return JSON.stringify({ status: stopVisible ? 'streaming' : 'idle', text, html });
      })()`,
    );
    const payload = JSON.parse(raw ?? "{}") as { status?: string; text?: string; html?: string };
    if (payload.status === "login-required") {
      throw new Error(
        "Grok requires sign-in before it will answer. Sign in at grok.com in the attached Chrome profile and retry.",
      );
    }
    const currentText = payload.text?.trim() ?? "";
    if (currentText && currentText === previousText && payload.status === "idle") {
      stablePolls += 1;
      if (stablePolls >= 2) return { text: currentText, html: payload.html };
    } else {
      stablePolls = 0;
      previousText = currentText;
    }
    await ctx.delay(1_000);
  }
  throw new Error("Timed out waiting for Grok to finish responding.");
}

export const grokDomProvider: ProviderDomAdapter = {
  providerName: "grok-web",
  waitForUi,
  typePrompt,
  submitPrompt,
  waitForResponse,
};
