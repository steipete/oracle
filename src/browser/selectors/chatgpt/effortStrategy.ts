// ChatGPT "highest-visible effort" strategy (oracle-hcs).
//
// The v18 contract is `Pro` + `requested_reasoning_effort:
// max_browser_available`, NOT a literal "Heavy" label. ChatGPT
// regularly renames the visible thinking-effort tier — "Heavy",
// "Pro Extended", "Thinking Heavy", "Ultra" — so the browser provider
// must rank whatever labels happen to be visible and pick the highest.
//
// This module:
//
//   1. Canonicalises the known effort tier names into a ranked table.
//   2. Tolerates renames via a synonym map (so "Heavy" today and
//      "Thinking Heavy" tomorrow both resolve to the same canonical
//      tier).
//   3. Computes a stable `available_effort_labels_hash` over the
//      observed labels so browser_evidence can record what the UI
//      offered at run time.
//   4. Returns a structured verdict with `selected`, `rank`,
//      `confidence`, `status`, and (on failure) the appropriate v18
//      error code so the calling state machine can wire it directly
//      into a json_envelope.v1.

import { createHash } from "node:crypto";

import { SELECTOR_MANIFEST_VERSION } from "./manifest.js";

// ─── Canonical effort tiers ──────────────────────────────────────────────────
//
// Ranked low → high. The strategy picks the visible label with the
// highest `rank`. Adding a new tier should be a manifest-version bump.

export type ChatGptEffortTier =
  | "instant"
  | "standard"
  | "thinking"
  | "thinking_mini"
  | "pro_extended"
  | "heavy"
  | "ultra";

export interface ChatGptEffortTierEntry {
  readonly tier: ChatGptEffortTier;
  /** Numeric rank — strictly increasing. Higher = more effort. */
  readonly rank: number;
  /**
   * Canonical display labels we have observed for this tier in the
   * ChatGPT UI. Matching is case-insensitive and tolerates surrounding
   * whitespace. Order does not matter.
   */
  readonly aliases: readonly string[];
}

export const CHATGPT_EFFORT_TIERS: readonly ChatGptEffortTierEntry[] = Object.freeze([
  {
    tier: "instant",
    rank: 10,
    aliases: ["Instant", "Fast"],
  },
  {
    tier: "standard",
    rank: 20,
    aliases: ["Standard", "Default", "Auto"],
  },
  {
    tier: "thinking",
    rank: 30,
    aliases: ["Thinking", "Think"],
  },
  {
    tier: "thinking_mini",
    rank: 40,
    aliases: ["Thinking Mini", "Mini Thinking"],
  },
  {
    tier: "pro_extended",
    rank: 50,
    aliases: ["Pro Extended", "Extended", "Extended Reasoning"],
  },
  {
    tier: "heavy",
    rank: 60,
    aliases: ["Heavy", "Thinking Heavy", "Heavy Thinking", "Pro Heavy"],
  },
  {
    tier: "ultra",
    rank: 70,
    aliases: ["Ultra", "Pro Ultra", "Max"],
  },
]);

const ALIAS_TO_TIER: ReadonlyMap<string, ChatGptEffortTierEntry> = (() => {
  const map = new Map<string, ChatGptEffortTierEntry>();
  for (const entry of CHATGPT_EFFORT_TIERS) {
    for (const alias of entry.aliases) {
      map.set(normalizeLabel(alias), entry);
    }
  }
  return map;
})();

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Map a free-form label to its canonical tier, or null if unknown. */
export function tierForLabel(label: string): ChatGptEffortTierEntry | null {
  return ALIAS_TO_TIER.get(normalizeLabel(label)) ?? null;
}

/**
 * Compute the `available_effort_labels_hash` for `browser_evidence.v1`.
 * Labels are normalised (trim + collapse whitespace) and sorted before
 * hashing so two runs that observed the same labels in different order
 * produce the same digest.
 */
export function availableEffortLabelsHash(
  labels: readonly string[],
): `sha256:${string}` {
  const canonical = [...labels]
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length > 0)
    .sort()
    .join("\n");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
}

// ─── Strategy result ─────────────────────────────────────────────────────────

import type { V18ErrorCode } from "../../../oracle/v18/json_envelope.js";

export type EffortStatus = "verified" | "unverified" | "ui_drift_suspected";

export interface EffortStrategyResult {
  /** Overall verdict for the state machine. */
  status: EffortStatus;
  /** Selected label (verbatim as observed in the UI) or null. */
  selected: string | null;
  /** Canonical tier of the selected label, or null when unknown. */
  tier: ChatGptEffortTier | null;
  /** Numeric rank of the selected label (higher = more effort), or null. */
  rank: number | null;
  /**
   * Whether the selected label is the highest *visible* label. Always
   * true on success; false when the verifier downgraded because the
   * apparent top label was outside the known taxonomy.
   */
  selectedIsHighestVisible: boolean;
  /** sha256 of sorted observed labels — embed on browser_evidence.v1. */
  availableEffortLabelsHash: `sha256:${string}`;
  /** Manifest version this verdict was produced against. */
  selectorManifestVersion: typeof SELECTOR_MANIFEST_VERSION;
  /** v18 error code when status is not "verified". */
  errorCode: V18ErrorCode | null;
  /** Free-form human-readable detail. */
  reason: string;
  /** Labels we observed (verbatim) so the caller can record them. */
  observedLabels: readonly string[];
}

export interface PickHighestVisibleEffortInput {
  /** Labels visible in the effort picker DOM, in any order. */
  readonly observedLabels: readonly string[];
  /**
   * When true (default), the strategy requires at least one of the
   * observed labels to map to a known canonical tier. Pass false in
   * dry-run / capabilities probes where the UI may be partly hidden.
   */
  readonly requireKnownTier?: boolean;
}

/**
 * Pick the highest-ranked known label among the observed ones.
 *
 * Decision table:
 *   - empty observedLabels → unverified / output_capture_unverified
 *   - at least one observed label, none known → ui_drift_suspected
 *   - at least one known label → verified, selected is the highest-rank known
 *
 * The strategy NEVER throws — every observable outcome is encoded in
 * the verdict so callers can route the result into a json_envelope.v1
 * error array directly.
 */
export function pickHighestVisibleEffort(
  input: PickHighestVisibleEffortInput,
): EffortStrategyResult {
  const observedLabels = input.observedLabels
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length > 0);

  const hash = availableEffortLabelsHash(observedLabels);

  if (observedLabels.length === 0) {
    return {
      status: "unverified",
      selected: null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: SELECTOR_MANIFEST_VERSION,
      errorCode: "output_capture_unverified",
      reason:
        "No effort-picker labels were visible; the effort control may be missing or hidden.",
      observedLabels,
    };
  }

  // Resolve each label to a tier. Sort by rank descending so the top
  // known label is at index 0.
  const ranked: Array<{ label: string; tier: ChatGptEffortTierEntry | null }> = observedLabels
    .map((label) => ({ label, tier: tierForLabel(label) }))
    .sort((a, b) => (b.tier?.rank ?? -1) - (a.tier?.rank ?? -1));

  const top = ranked[0];

  if (!top.tier) {
    // No observed label mapped to a known tier — UI drift.
    return {
      status: "ui_drift_suspected",
      selected: null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: SELECTOR_MANIFEST_VERSION,
      errorCode: "ui_drift_suspected",
      reason: `Observed labels [${observedLabels.join(", ")}] do not map to any known effort tier in manifest ${SELECTOR_MANIFEST_VERSION}.`,
      observedLabels,
    };
  }

  return {
    status: "verified",
    selected: top.label,
    tier: top.tier.tier,
    rank: top.tier.rank,
    selectedIsHighestVisible: true,
    availableEffortLabelsHash: hash,
    selectorManifestVersion: SELECTOR_MANIFEST_VERSION,
    errorCode: null,
    reason: `Selected "${top.label}" (tier=${top.tier.tier}, rank=${top.tier.rank}) as the highest visible effort.`,
    observedLabels,
  };
}

/**
 * Convenience: returns the highest-ranked known label from a list,
 * ignoring drift. Used by the state machine when it needs to *probe*
 * the UI without producing a full verdict envelope.
 */
export function highestKnownLabel(labels: readonly string[]): string | null {
  let best: { label: string; rank: number } | null = null;
  for (const label of labels) {
    const tier = tierForLabel(label);
    if (!tier) continue;
    if (!best || tier.rank > best.rank) best = { label, rank: tier.rank };
  }
  return best?.label ?? null;
}
