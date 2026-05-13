import { joinSelectors } from "../../browser/providerDomFlow.js";

export interface SelectorEntry {
  readonly primary: string[];
  readonly fallback?: string[];
  readonly rank: number;
  readonly confidence: number;
}

export interface GeminiDeepThinkManifest {
  readonly provider: "gemini-web";
  readonly purpose: "deep-think-orchestration";
  readonly selectors: {
    readonly input: SelectorEntry;
    readonly sendButton: SelectorEntry;
    readonly toolsButton: SelectorEntry;
    readonly toolsMenuItem: SelectorEntry;
    readonly deepThinkActive: SelectorEntry;
    readonly responseTurn: SelectorEntry;
    readonly responseText: SelectorEntry;
    readonly responseComplete: SelectorEntry;
    readonly thoughtsToggle: SelectorEntry;
    readonly thoughtsContent: SelectorEntry;
    readonly spinner: SelectorEntry;
  };
  readonly observedDeepThinkLabel: string;
  readonly thinkingLevelControl?: {
    readonly selector: SelectorEntry;
    readonly options: Record<string, string>;
  };
  readonly lastVerified: string;
  readonly fixtureReferences: string[];
}

export const GEMINI_DEEP_THINK_MANIFEST: GeminiDeepThinkManifest = {
  provider: "gemini-web",
  purpose: "deep-think-orchestration",
  selectors: {
    input: {
      primary: ["rich-textarea .ql-editor"],
      fallback: ['[role="textbox"][aria-label*="prompt" i]', 'div[contenteditable="true"]'],
      rank: 1,
      confidence: 0.9,
    },
    sendButton: {
      primary: ["button.send-button"],
      fallback: ['button[aria-label="Send message"]'],
      rank: 1,
      confidence: 0.9,
    },
    toolsButton: {
      primary: ["button.toolbox-drawer-button"],
      fallback: ['button[aria-label="Tools"]'],
      rank: 1,
      confidence: 0.9,
    },
    toolsMenuItem: {
      primary: ['[role="menuitemcheckbox"]'],
      fallback: [".toolbox-drawer-item-list-button"],
      rank: 1,
      confidence: 0.8,
    },
    deepThinkActive: {
      primary: [".toolbox-drawer-item-deselect-button"],
      fallback: ['button[aria-label*="Deselect Deep Think"]'],
      rank: 1,
      confidence: 0.8,
    },
    responseTurn: {
      primary: ["model-response"],
      rank: 1,
      confidence: 1.0,
    },
    responseText: {
      primary: ["message-content"],
      fallback: [".model-response-text message-content"],
      rank: 1,
      confidence: 0.9,
    },
    responseComplete: {
      primary: [".response-footer.complete"],
      rank: 1,
      confidence: 0.9,
    },
    thoughtsToggle: {
      primary: [".thoughts-header-button"],
      fallback: ['[data-test-id="thoughts-header-button"]'],
      rank: 1,
      confidence: 0.9,
    },
    thoughtsContent: {
      primary: ["model-thoughts"],
      fallback: ['[data-test-id="model-thoughts"]'],
      rank: 1,
      confidence: 0.9,
    },
    spinner: {
      primary: ['[role="progressbar"]'],
      rank: 1,
      confidence: 0.8,
    },
  },
  observedDeepThinkLabel: "deep think",
  thinkingLevelControl: {
    selector: {
      primary: [".thinking-level-option", '[role="menuitemradio"]'],
      rank: 1,
      confidence: 0.5,
    },
    options: {
      high: "high",
      standard: "standard",
    },
  },
  lastVerified: "2026-05-11",
  fixtureReferences: ["tests/fixtures/gemini-web/deep-think.html"],
};

export function getManifestSelectors(entry: SelectorEntry): string[] {
  return [...entry.primary, ...(entry.fallback ?? [])];
}

export function getManifestSelectorLiteral(entry: SelectorEntry): string {
  return JSON.stringify(joinSelectors(getManifestSelectors(entry)));
}
