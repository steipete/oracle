import type { BrowserLogger } from './types.js';

export type DomEvaluate = <T>(expression: string) => Promise<T | undefined>;

export interface ProviderDomFlowContext {
  prompt: string;
  evaluate: DomEvaluate;
  delay: (ms: number) => Promise<void>;
  log?: BrowserLogger;
}

export interface ProviderDomAdapter {
  providerName: string;
  waitForUi: (ctx: ProviderDomFlowContext) => Promise<void>;
  selectMode?: (ctx: ProviderDomFlowContext) => Promise<void>;
  typePrompt: (ctx: ProviderDomFlowContext) => Promise<void>;
  submitPrompt: (ctx: ProviderDomFlowContext) => Promise<void>;
  waitForResponse: (ctx: ProviderDomFlowContext) => Promise<string>;
  extractThoughts?: (ctx: ProviderDomFlowContext) => Promise<string | null>;
}

export interface ProviderDomFlowResult {
  text: string;
  thoughts: string | null;
}

export async function runProviderDomFlow(
  adapter: ProviderDomAdapter,
  ctx: ProviderDomFlowContext,
): Promise<ProviderDomFlowResult> {
  await adapter.waitForUi(ctx);
  if (adapter.selectMode) {
    await adapter.selectMode(ctx);
  }
  await adapter.typePrompt(ctx);
  await adapter.submitPrompt(ctx);
  const text = await adapter.waitForResponse(ctx);
  const thoughts = adapter.extractThoughts ? await adapter.extractThoughts(ctx) : null;
  return { text, thoughts };
}

export function joinSelectors(selectors: readonly string[]): string {
  return selectors.join(', ');
}
