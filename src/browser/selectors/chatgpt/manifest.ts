// ChatGPT browser selector manifest (oracle-hcs).
//
// The manifest is a single source of truth for the DOM hooks the
// ChatGPT browser provider needs to find:
//
//   - assistant turn nodes (for output capture)
//   - the "Answer now" CTA that signals a Pro thinking-state interrupt
//   - thinking-state markers (visible reasoning UI)
//   - the model picker chip and effort picker controls
//   - the composer textarea + send button
//
// Each entry records primary selectors, fallback selectors for drift
// tolerance, label expectations, confidence, rank, and a last-verified
// ISO date so an operator can audit selector freshness without reading
// every DOM probe site.
//
// v18 spec §11 / oracle-hcs require the manifest version be recorded on
// browser_evidence.v1 alongside the observed labels hash; see
// `SELECTOR_MANIFEST_VERSION` and `availableEffortLabelsHash` in
// ./effortStrategy.ts.

import { createHash } from "node:crypto";

export const SELECTOR_MANIFEST_VERSION = "chatgpt-selectors.v1" as const;
export const SELECTOR_MANIFEST_LAST_VERIFIED = "2026-05-13" as const;

export type SelectorConfidence = "high" | "medium" | "low";

export type ChatGptSelectorPurpose =
  | "assistant_turn"
  | "assistant_turn_text"
  | "answer_now_cta"
  | "thinking_state"
  | "model_picker_button"
  | "model_picker_menu"
  | "model_row"
  | "effort_picker_button"
  | "effort_picker_menu"
  | "effort_row"
  | "composer_textarea"
  | "send_button"
  | "stop_button";

export interface ChatGptSelectorEntry {
  /** Logical purpose identifier consumed by the provider. */
  purpose: ChatGptSelectorPurpose;
  /** Provider scope; this manifest covers ChatGPT browser surfaces only. */
  provider: "chatgpt";
  /**
   * Primary CSS selectors to try first. Selectors are evaluated in array
   * order; the first match wins. Each selector is a single CSS string,
   * not a DOM-evaluated expression — the provider runs them directly via
   * `document.querySelector(All)`.
   */
  primary: readonly string[];
  /**
   * Fallback CSS selectors. The provider only consults these when every
   * primary selector returned no matches. Useful for tolerating ChatGPT
   * UI rewrites without hot-patching the provider.
   */
  fallback: readonly string[];
  /**
   * Optional label expectations. When the matched element's textContent
   * / aria-label / title contains one of these strings (case-insensitive),
   * the selector is considered a high-confidence match. The provider can
   * still accept a structural match without a label hit, but the
   * confidence drops one tier.
   */
  labelExpectations?: {
    readonly text?: readonly string[];
    readonly ariaLabel?: readonly string[];
  };
  /** Confidence tier when both primary selector AND label expectation match. */
  confidence: SelectorConfidence;
  /**
   * Manifest-wide rank for ordered alternatives. Lower numbers indicate
   * preferred selectors; ties broken by `primary[0]` lexicographic order.
   */
  rank: number;
  /** ISO date when this entry was last manually verified against live ChatGPT. */
  lastVerified: string;
  /**
   * Plan-bundle fixture references. When the operator needs to diagnose
   * UI drift, these point at the canonical DOM snapshots the manifest
   * was authored against.
   */
  fixtureRefs?: readonly string[];
}

const COMMON_LAST_VERIFIED = SELECTOR_MANIFEST_LAST_VERIFIED;

/**
 * The active manifest. Selectors are deliberately conservative — we
 * include several attribute hooks (`data-testid`, `data-message-id`,
 * `role`) so a single CSS-class rename does not break the provider.
 */
export const CHATGPT_SELECTOR_MANIFEST: readonly ChatGptSelectorEntry[] = Object.freeze([
  // ─── Assistant output capture ───────────────────────────────────────────
  {
    purpose: "assistant_turn",
    provider: "chatgpt",
    primary: [
      'article[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
      '[data-message-author-role="assistant"]',
    ],
    fallback: [
      'div.group[data-message-author-role="assistant"]',
      'div[data-testid^="conversation-turn-"] div[data-message-author-role="assistant"]',
    ],
    confidence: "high",
    rank: 10,
    lastVerified: COMMON_LAST_VERIFIED,
    fixtureRefs: ["docs/manual-tests.md#chatgpt-pro-formal-plan"],
  },
  {
    purpose: "assistant_turn_text",
    provider: "chatgpt",
    primary: [
      '[data-message-author-role="assistant"] [data-testid="conversation-turn-content"]',
      '[data-message-author-role="assistant"] div.markdown',
    ],
    fallback: ['[data-message-author-role="assistant"] div[class*="markdown"]'],
    confidence: "high",
    rank: 20,
    lastVerified: COMMON_LAST_VERIFIED,
  },

  // ─── Pro thinking-state markers ─────────────────────────────────────────
  //
  // Per AGENTS.md: NEVER click ChatGPT's "Answer now" button. The
  // provider treats this as a placeholder and must wait for the real
  // assistant response. We expose the selector so the state machine can
  // *detect* it (and skip clicking).
  {
    purpose: "answer_now_cta",
    provider: "chatgpt",
    primary: [
      'button[data-testid="stop-answer-now-button"]',
      'button[aria-label^="Answer now"]',
    ],
    fallback: ['button[aria-label*="Answer now" i]', 'button:has-text("Answer now")'],
    labelExpectations: { text: ["Answer now"], ariaLabel: ["answer now"] },
    confidence: "high",
    rank: 30,
    lastVerified: COMMON_LAST_VERIFIED,
    fixtureRefs: ["docs/manual-tests.md#pro-thinking-do-not-click"],
  },
  {
    purpose: "thinking_state",
    provider: "chatgpt",
    primary: [
      'div[data-testid="thinking-indicator"]',
      'div[role="status"][aria-live="polite"]',
    ],
    fallback: ['div[class*="thinking"]', 'div[aria-busy="true"]'],
    labelExpectations: {
      text: ["Thinking…", "Reasoning…", "Pro thinking", "Heavy thinking"],
    },
    confidence: "medium",
    rank: 40,
    lastVerified: COMMON_LAST_VERIFIED,
  },

  // ─── Model picker ───────────────────────────────────────────────────────
  {
    purpose: "model_picker_button",
    provider: "chatgpt",
    primary: [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button[data-testid="__composer-pill"]',
    ],
    fallback: ['button[aria-haspopup="menu"][aria-label*="model" i]'],
    labelExpectations: { ariaLabel: ["model", "switch model", "current model"] },
    confidence: "high",
    rank: 50,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "model_picker_menu",
    provider: "chatgpt",
    primary: ['[role="menu"][data-testid*="model"]', '[role="listbox"][aria-label*="model" i]'],
    fallback: ['[role="menu"]'],
    confidence: "medium",
    rank: 60,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "model_row",
    provider: "chatgpt",
    primary: [
      '[role="menuitem"][data-testid^="model-switcher-"]',
      '[role="option"][data-testid^="model-row-"]',
    ],
    fallback: ['[role="menuitem"]'],
    confidence: "medium",
    rank: 70,
    lastVerified: COMMON_LAST_VERIFIED,
  },

  // ─── Effort picker (Pro Extended / Heavy / etc.) ────────────────────────
  {
    purpose: "effort_picker_button",
    provider: "chatgpt",
    primary: [
      'button[data-testid="effort-picker-button"]',
      'button[data-testid="thinking-effort-button"]',
    ],
    fallback: ['button[aria-label*="effort" i]', 'button[aria-label*="thinking" i]'],
    confidence: "high",
    rank: 80,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "effort_picker_menu",
    provider: "chatgpt",
    primary: ['[role="menu"][data-testid*="effort"]', '[role="listbox"][aria-label*="effort" i]'],
    fallback: ['[role="menu"]'],
    confidence: "medium",
    rank: 90,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "effort_row",
    provider: "chatgpt",
    primary: [
      '[role="menuitem"][data-testid^="effort-row-"]',
      '[role="option"][data-testid^="thinking-effort-"]',
    ],
    fallback: ['[role="menuitem"]'],
    confidence: "medium",
    rank: 100,
    lastVerified: COMMON_LAST_VERIFIED,
  },

  // ─── Composer ───────────────────────────────────────────────────────────
  {
    purpose: "composer_textarea",
    provider: "chatgpt",
    primary: [
      '#prompt-textarea',
      'textarea[data-testid="composer-input"]',
      'div[contenteditable="true"][data-testid="composer-input"]',
    ],
    fallback: ['textarea[placeholder*="Message" i]', 'div[contenteditable="true"]'],
    confidence: "high",
    rank: 110,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "send_button",
    provider: "chatgpt",
    primary: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
    fallback: ['button[aria-label*="Send" i][type="submit"]'],
    confidence: "high",
    rank: 120,
    lastVerified: COMMON_LAST_VERIFIED,
  },
  {
    purpose: "stop_button",
    provider: "chatgpt",
    primary: ['button[data-testid="stop-button"]', 'button[aria-label="Stop generating"]'],
    fallback: ['button[aria-label*="Stop" i]'],
    confidence: "high",
    rank: 130,
    lastVerified: COMMON_LAST_VERIFIED,
  },
]);

const ENTRIES_BY_PURPOSE: ReadonlyMap<ChatGptSelectorPurpose, ChatGptSelectorEntry> = new Map(
  CHATGPT_SELECTOR_MANIFEST.map((entry) => [entry.purpose, entry]),
);

/** Return the manifest entry for a given purpose, or null if not registered. */
export function chatgptSelector(
  purpose: ChatGptSelectorPurpose,
): ChatGptSelectorEntry | null {
  return ENTRIES_BY_PURPOSE.get(purpose) ?? null;
}

/** Return primary + fallback selectors flattened in evaluation order. */
export function chatgptSelectorList(purpose: ChatGptSelectorPurpose): readonly string[] {
  const entry = chatgptSelector(purpose);
  if (!entry) return [];
  return [...entry.primary, ...entry.fallback];
}

/**
 * Hash the sorted CSS selector strings for a given purpose. Used as a
 * stable identifier so a verification ledger can record which selectors
 * were active at run time without quoting the strings themselves.
 */
export function chatgptSelectorFingerprint(
  purpose: ChatGptSelectorPurpose,
): `sha256:${string}` | null {
  const entry = chatgptSelector(purpose);
  if (!entry) return null;
  const canonical = [...entry.primary, ...entry.fallback].sort().join("\n");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** Manifest-wide fingerprint: hash of every entry's fingerprint. */
export function chatgptManifestFingerprint(): `sha256:${string}` {
  const parts = CHATGPT_SELECTOR_MANIFEST.map((entry) => {
    const canonical = [...entry.primary, ...entry.fallback].sort().join("\n");
    return `${entry.purpose}\t${canonical}`;
  }).sort();
  const digest = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
  return `sha256:${digest}`;
}
