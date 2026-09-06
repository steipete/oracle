import type { BrowserLogger } from "../browser/types.js";
import type { PerplexityMode } from "../browser/providers/perplexityDomProvider.js";

export type PerplexityWebModelId = "perplexity" | "perplexity-research";

export const DEFAULT_PERPLEXITY_WEB_MODEL: PerplexityWebModelId = "perplexity";

/** Maps an Oracle model id onto the mode Perplexity's composer must be switched to. */
const MODEL_MODES: Record<PerplexityWebModelId, PerplexityMode> = {
  perplexity: "search",
  "perplexity-research": "research",
};

/**
 * The exact aliases that select the Perplexity web provider, mapped to their model
 * id. Matching must stay exact: a prefix test would also swallow unqualified custom
 * ids such as `perplexity-labs`, which belong on the custom/OpenRouter passthrough,
 * and provider-qualified ids such as `perplexity/sonar-pro`, which are API models.
 */
const PERPLEXITY_ALIASES: Record<string, PerplexityWebModelId> = {
  perplexity: "perplexity",
  "perplexity-search": "perplexity",
  pplx: "perplexity",
  "perplexity-research": "perplexity-research",
  "perplexity-deep-research": "perplexity-research",
  "perplexity-deepresearch": "perplexity-research",
};

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

/** Resolves an exact Perplexity alias to its model id, or null when unrecognized. */
export function perplexityAliasToModelId(
  value: string | null | undefined,
): PerplexityWebModelId | null {
  if (typeof value !== "string") return null;
  return PERPLEXITY_ALIASES[normalizeAlias(value)] ?? null;
}

/** True only for the two ids that route to the Perplexity web provider. */
export function isPerplexityModel(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false;
  const normalized = normalizeAlias(model);
  return normalized === "perplexity" || normalized === "perplexity-research";
}

export function perplexityModeForModel(model: PerplexityWebModelId): PerplexityMode {
  return MODEL_MODES[model];
}

export function resolvePerplexityWebModel(
  desiredModel: string | null | undefined,
  log?: BrowserLogger,
): PerplexityWebModelId {
  const desired = typeof desiredModel === "string" ? desiredModel.trim() : "";
  if (!desired) return DEFAULT_PERPLEXITY_WEB_MODEL;
  const normalized = normalizeAlias(desired);

  const byAlias = PERPLEXITY_ALIASES[normalized];
  if (byAlias) return byAlias;

  // Browser picker labels reach the executor as `config.desiredModel`
  // (see BROWSER_MODEL_LABELS), so they resolve here too.
  if (normalized === "search") return "perplexity";
  if (normalized === "deep-research") return "perplexity-research";

  log?.(
    `[perplexity-web] Unsupported Perplexity model "${desired}". Falling back to ${DEFAULT_PERPLEXITY_WEB_MODEL}.`,
  );
  return DEFAULT_PERPLEXITY_WEB_MODEL;
}
