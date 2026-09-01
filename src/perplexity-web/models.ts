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
 * True only for the bare browser model ids. Provider-qualified ids such as
 * `perplexity/sonar-pro` are OpenRouter API models and must keep routing to the
 * API provider — accepting them here would open the signed-in Perplexity web UI
 * and silently answer in Search mode instead.
 */
export function isPerplexityModel(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("perplexity") && !normalized.includes("/");
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
