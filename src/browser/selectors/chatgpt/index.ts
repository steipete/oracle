// Barrel: ChatGPT browser selector manifest + effort strategy.
//
// Importers should depend on this module rather than reaching into
// ./manifest.ts or ./effortStrategy.ts directly so the file layout can
// evolve without touching every call site.

export {
  CHATGPT_SELECTOR_MANIFEST,
  SELECTOR_MANIFEST_LAST_VERIFIED,
  SELECTOR_MANIFEST_VERSION,
  chatgptManifestFingerprint,
  chatgptSelector,
  chatgptSelectorFingerprint,
  chatgptSelectorList,
  type ChatGptSelectorEntry,
  type ChatGptSelectorPurpose,
  type SelectorConfidence,
} from "./manifest.js";

export {
  CHATGPT_EFFORT_TIERS,
  availableEffortLabelsHash,
  highestKnownLabel,
  pickHighestVisibleEffort,
  tierForLabel,
  type ChatGptEffortTier,
  type ChatGptEffortTierEntry,
  type EffortStatus,
  type EffortStrategyResult,
  type PickHighestVisibleEffortInput,
} from "./effortStrategy.js";
