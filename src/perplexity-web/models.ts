import type { BrowserLogger } from "../browser/types.js";
import type { PerplexityMode } from "../browser/providers/perplexityDomProvider.js";

export type PerplexityWebModelId = "perplexity" | "perplexity-research";

export const DEFAULT_PERPLEXITY_WEB_MODEL: PerplexityWebModelId = "perplexity";

/** Maps an Oracle model id onto the mode Perplexity's composer must be switched to. */
const MODEL_MODES: Record<PerplexityWebModelId, PerplexityMode> = {
  perplexity: "search",
  "perplexity-research": "research",
};

export function isPerplexityModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.trim().toLowerCase().startsWith("perplexity");
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
  const normalized = desired.toLowerCase().replace(/[_\s]+/g, "-");

  switch (normalized) {
    // Model ids, plus the browser picker labels that reach the executor as
    // `config.desiredModel` (see BROWSER_MODEL_LABELS).
    case "perplexity":
    case "perplexity-search":
    case "search":
    case "pplx":
      return "perplexity";
    case "perplexity-research":
    case "perplexity-deep-research":
    case "perplexity-deepresearch":
    case "deep-research":
      return "perplexity-research";
    default:
      if (normalized.includes("research")) {
        return "perplexity-research";
      }
      log?.(
        `[perplexity-web] Unsupported Perplexity model "${desired}". Falling back to ${DEFAULT_PERPLEXITY_WEB_MODEL}.`,
      );
      return DEFAULT_PERPLEXITY_WEB_MODEL;
  }
}
