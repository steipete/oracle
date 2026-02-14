import type { BrowserLogger, ChromeClient } from './types.js';
import type { ProviderDomAdapter, ProviderDomFlowContext } from './providerDomFlow.js';
import { ensurePromptReady } from './actions/navigation.js';
import { submitPrompt } from './actions/promptComposer.js';
import { waitForAssistantResponse } from './actions/assistantResponse.js';

interface ChatgptDomProviderState {
  runtime: ChromeClient['Runtime'];
  input: ChromeClient['Input'];
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  baselineTurns?: number | null;
  attachmentNames?: string[];
  committedTurns?: number | null;
}

function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger) {
    throw new Error('chatgptDomProvider requires runtime/input/logger in context.state.');
  }
  return state;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ProviderDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  const committedTurns = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      attachmentNames: state.attachmentNames ?? [],
      baselineTurns: state.baselineTurns ?? undefined,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
    },
    ctx.prompt,
    state.logger,
  );
  state.committedTurns = typeof committedTurns === 'number' && Number.isFinite(committedTurns)
    ? committedTurns
    : null;
  if (state.committedTurns != null && (state.baselineTurns == null || state.committedTurns > state.baselineTurns)) {
    state.baselineTurns = Math.max(0, state.committedTurns - 1);
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}> {
  const state = requireState(ctx);
  const answer = await waitForAssistantResponse(
    state.runtime,
    state.timeoutMs,
    state.logger,
    state.baselineTurns ?? undefined,
  );
  return {
    text: answer.text,
    html: answer.html,
    meta: answer.meta,
  };
}

export const chatgptDomProvider: ProviderDomAdapter = {
  providerName: 'chatgpt-web',
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  waitForResponse,
};
