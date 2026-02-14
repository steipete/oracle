import type { BrowserLogger } from './types.js';

export type DomEvaluate = <T>(expression: string) => Promise<T | undefined>;

export interface ProviderDomFlowContext {
  prompt: string;
  evaluate: DomEvaluate;
  delay: (ms: number) => Promise<void>;
  log?: BrowserLogger;
  state?: Record<string, unknown>;
}

export interface ProviderDomResponse {
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}

export interface ProviderDomAdapter {
  providerName: string;
  waitForUi: (ctx: ProviderDomFlowContext) => Promise<void>;
  selectMode?: (ctx: ProviderDomFlowContext) => Promise<void>;
  typePrompt: (ctx: ProviderDomFlowContext) => Promise<void>;
  submitPrompt: (ctx: ProviderDomFlowContext) => Promise<void>;
  waitForResponse: (ctx: ProviderDomFlowContext) => Promise<ProviderDomResponse>;
  extractThoughts?: (ctx: ProviderDomFlowContext) => Promise<string | null>;
}

export interface ProviderDomFlowResult extends ProviderDomResponse {
  thoughts: string | null;
}

export async function runProviderSubmissionFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
): Promise<void> {
  await adapter.waitForUi(ctx);
  if (adapter.selectMode) {
    await adapter.selectMode(ctx);
  }
  await adapter.typePrompt(ctx);
  await adapter.submitPrompt(ctx);
}

export async function runProviderDomFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
): Promise<ProviderDomFlowResult> {
  await runProviderSubmissionFlow(adapter, ctx);
  const response = await adapter.waitForResponse(ctx);
  const thoughts = adapter.extractThoughts ? await adapter.extractThoughts(ctx) : null;
  return { ...response, thoughts };
}

export function joinSelectors(selectors: readonly string[]): string {
  return selectors.join(', ');
}
