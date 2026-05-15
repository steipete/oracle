import { createRequire } from "node:module";
import type { ModelConfig, ModelName, KnownModelName, TokenizerFn, ProModelName } from "./types.js";
import { MODEL_CONFIGS, PRO_MODELS } from "./config.js";
import { pricingFromUsdPerMillion } from "tokentally";

const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const require = createRequire(import.meta.url);
let countTokensGpt5ProImpl: TokenizerFn | undefined;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const countTokensGpt5Pro: TokenizerFn = (
  input: unknown,
  options?: Record<string, unknown>,
): number => {
  countTokensGpt5ProImpl ??= require("gpt-tokenizer/model/gpt-5-pro").countTokens as TokenizerFn;
  return countTokensGpt5ProImpl(input, options);
};

export function isKnownModel(model: string): model is KnownModelName {
  return Object.hasOwn(MODEL_CONFIGS, model);
}

export function isOpenRouterBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("openrouter.ai");
  } catch {
    return false;
  }
}

export function defaultOpenRouterBaseUrl(): string {
  return OPENROUTER_DEFAULT_BASE;
}

export function normalizeOpenRouterBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    // If user passed the responses endpoint, trim it so the client does not double-append.
    if (url.pathname.endsWith("/responses")) {
      url.pathname = url.pathname.replace(/\/responses\/?$/, "");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

export function safeModelSlug(model: string): string {
  return model.replace(/[/\\]/g, "__").replace(/[:*?"<>|]/g, "_");
}

interface OpenRouterModelInfo {
  id: string;
  context_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
}

const catalogCache = new Map<string, { fetchedAt: number; models: OpenRouterModelInfo[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

/**
 * Prune stale entries from the catalog cache to prevent unbounded growth.
 * Removes entries older than TTL and enforces a maximum cache size.
 */
function pruneCatalogCache(now: number): void {
  // Remove stale entries first
  for (const [key, entry] of catalogCache) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) {
      catalogCache.delete(key);
    }
  }
  // If still over limit, evict oldest fetched entries (not true LRU; no last-access tracking).
  if (catalogCache.size > MAX_CACHE_ENTRIES) {
    const entries = [...catalogCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const toRemove = entries.slice(0, catalogCache.size - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) {
      catalogCache.delete(key);
    }
  }
}

async function fetchOpenRouterCatalog(
  apiKey: string,
  fetcher: FetchFn,
): Promise<OpenRouterModelInfo[]> {
  const now = Date.now();
  const cached = catalogCache.get(apiKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  const response = await fetcher(OPENROUTER_MODELS_ENDPOINT, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load OpenRouter models (${response.status})`);
  }
  const json = (await response.json()) as { data?: OpenRouterModelInfo[] };
  const models = json?.data ?? [];
  catalogCache.set(apiKey, { fetchedAt: now, models });
  // Prune after insert so the max-size constraint is strictly enforced.
  pruneCatalogCache(now);
  return models;
}

function mapToOpenRouterId(
  candidate: string,
  catalog: OpenRouterModelInfo[],
  providerHint?: string,
): string {
  if (candidate.includes("/")) return candidate;
  const byExact = catalog.find((entry) => entry.id === candidate);
  if (byExact) return byExact.id;
  const bySuffix = catalog.find((entry) => entry.id.endsWith(`/${candidate}`));
  if (bySuffix) return bySuffix.id;
  if (providerHint) {
    return `${providerHint}/${candidate}`;
  }
  return candidate;
}

export async function resolveModelConfig(
  model: ModelName,
  options: {
    baseUrl?: string;
    openRouterApiKey?: string;
    fetcher?: FetchFn;
  } = {},
): Promise<ModelConfig> {
  const known = isKnownModel(model) ? (MODEL_CONFIGS[model] as ModelConfig) : null;
  const fetcher: FetchFn = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const openRouterActive =
    isOpenRouterBaseUrl(options.baseUrl) || Boolean(options.openRouterApiKey);

  if (known && !openRouterActive) {
    return known;
  }

  // Try to enrich from OpenRouter catalog when available.
  if (openRouterActive && options.openRouterApiKey) {
    try {
      const catalog = await fetchOpenRouterCatalog(options.openRouterApiKey, fetcher);
      const targetId = mapToOpenRouterId(
        typeof model === "string" ? model : String(model),
        catalog,
        known?.provider,
      );
      const info = catalog.find((entry) => entry.id === targetId) ?? null;
      if (info) {
        return {
          ...(known ?? {
            model,
            tokenizer: countTokensGpt5Pro as TokenizerFn,
            inputLimit: info.context_length ?? 200_000,
            reasoning: null,
          }),
          apiModel: targetId,
          openRouterId: targetId,
          provider: known?.provider ?? "other",
          inputLimit: info.context_length ?? known?.inputLimit ?? 200_000,
          pricing:
            info.pricing && info.pricing.prompt != null && info.pricing.completion != null
              ? (() => {
                  const pricing = pricingFromUsdPerMillion({
                    inputUsdPerMillion: info.pricing.prompt,
                    outputUsdPerMillion: info.pricing.completion,
                  });
                  return {
                    inputPerToken: pricing.inputUsdPerToken,
                    outputPerToken: pricing.outputUsdPerToken,
                  };
                })()
              : (known?.pricing ?? null),
          supportsBackground: known?.supportsBackground ?? true,
          supportsSearch: known?.supportsSearch ?? true,
        };
      }
      // No metadata hit; fall through to synthesized config.
      return {
        ...(known ?? {
          model,
          tokenizer: countTokensGpt5Pro as TokenizerFn,
          inputLimit: 200_000,
          reasoning: null,
        }),
        apiModel: targetId,
        openRouterId: targetId,
        provider: known?.provider ?? "other",
        supportsBackground: known?.supportsBackground ?? true,
        supportsSearch: known?.supportsSearch ?? true,
        pricing: known?.pricing ?? null,
      };
    } catch {
      // If catalog fetch fails, fall back to a synthesized config.
    }
  }

  // Synthesized generic config for custom endpoints or failed catalog fetch.
  return {
    ...(known ?? {
      model,
      tokenizer: countTokensGpt5Pro as TokenizerFn,
      inputLimit: 200_000,
      reasoning: null,
    }),
    provider: known?.provider ?? "other",
    supportsBackground: known?.supportsBackground ?? true,
    supportsSearch: known?.supportsSearch ?? true,
    pricing: known?.pricing ?? null,
  };
}

export function isProModel(model: ModelName): boolean {
  return isKnownModel(model) && PRO_MODELS.has(model as KnownModelName & ProModelName);
}

export function resetOpenRouterCatalogCacheForTest(): void {
  catalogCache.clear();
}

export function getOpenRouterCatalogCacheSizeForTest(): number {
  return catalogCache.size;
}

export function getOpenRouterCatalogCacheMaxEntriesForTest(): number {
  return MAX_CACHE_ENTRIES;
}
