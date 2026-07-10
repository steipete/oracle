import { createRequire } from "node:module";
import type {
  ModelConfig,
  ModelName,
  KnownModelName,
  TokenizerFn,
  ProModelName,
  ModelOverridesConfig,
  ReasoningEffort,
} from "./types.js";
import { MODEL_CONFIGS, PRO_MODELS } from "./config.js";
import { pricingFromUsdPerToken } from "tokentally";

const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const REQUESTY_DEFAULT_BASE = "https://router.requesty.ai/v1";
const REQUESTY_MODELS_ENDPOINT = "https://router.requesty.ai/v1/models";
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

export function isRequestyBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname.includes("requesty.ai");
  } catch {
    return false;
  }
}

export function defaultOpenRouterBaseUrl(): string {
  return OPENROUTER_DEFAULT_BASE;
}

export function defaultRequestyBaseUrl(): string {
  return REQUESTY_DEFAULT_BASE;
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

export function normalizeRequestyBaseUrl(baseUrl: string): string {
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
    prompt?: string | number;
    completion?: string | number;
  };
}

/**
 * Requesty's `/v1/models` payload is OpenAI-shaped but exposes capability and
 * pricing metadata under different field names than OpenRouter. Requesty prices
 * are USD per token (like OpenRouter) but live on flat `input_price`/`output_price`
 * fields, and context length is reported as `context_window`.
 */
interface RequestyModelInfo {
  id: string;
  context_window?: number;
  input_price?: string | number;
  output_price?: string | number;
  supports_tool_calling?: boolean;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
}

function openRouterPricing(pricing: OpenRouterModelInfo["pricing"]): ModelConfig["pricing"] {
  const parsePrice = (value: string | number | undefined): number | null => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  const inputUsdPerToken = parsePrice(pricing?.prompt);
  const outputUsdPerToken = parsePrice(pricing?.completion);
  if (inputUsdPerToken === null || outputUsdPerToken === null) return null;

  const normalized = pricingFromUsdPerToken({ inputUsdPerToken, outputUsdPerToken });
  return {
    inputPerToken: normalized.inputUsdPerToken,
    outputPerToken: normalized.outputUsdPerToken,
  };
}

/**
 * Adapt a Requesty catalog entry to the internal {@link OpenRouterModelInfo}
 * shape so the shared hydration path can enrich configs regardless of gateway.
 * Requesty reports context length as `context_window` and prices as flat
 * per-token `input_price`/`output_price` fields (vs OpenRouter's nested
 * `pricing.prompt`/`pricing.completion`).
 */
function normalizeRequestyModel(info: RequestyModelInfo): OpenRouterModelInfo {
  return {
    id: info.id,
    context_length: info.context_window,
    pricing: {
      prompt: info.input_price,
      completion: info.output_price,
    },
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

async function fetchRequestyCatalog(
  apiKey: string,
  fetcher: FetchFn,
): Promise<OpenRouterModelInfo[]> {
  const cacheKey = `requesty:${apiKey}`;
  const now = Date.now();
  const cached = catalogCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  const response = await fetcher(REQUESTY_MODELS_ENDPOINT, {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to load Requesty models (${response.status})`);
  }
  const json = (await response.json()) as { data?: RequestyModelInfo[] };
  const models = (json?.data ?? []).map(normalizeRequestyModel);
  catalogCache.set(cacheKey, { fetchedAt: now, models });
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
    requestyApiKey?: string;
    fetcher?: FetchFn;
    modelOverrides?: ModelOverridesConfig;
  } = {},
): Promise<ModelConfig> {
  const base = await resolveBaseModelConfig(model, options);
  // Apply user-config per-model overrides last, after known/OpenRouter/synthesized
  // resolution, so an explicit override always wins.
  return applyModelOverride(base, model, options.modelOverrides);
}

async function resolveBaseModelConfig(
  model: ModelName,
  options: {
    baseUrl?: string;
    openRouterApiKey?: string;
    requestyApiKey?: string;
    fetcher?: FetchFn;
  } = {},
): Promise<ModelConfig> {
  const known = isKnownModel(model) ? (MODEL_CONFIGS[model] as ModelConfig) : null;
  const fetcher: FetchFn = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const requestyActive = isRequestyBaseUrl(options.baseUrl) || Boolean(options.requestyApiKey);
  // OpenRouter and Requesty share the same provider/model catalog convention. When a
  // Requesty base URL is targeted we never treat it as OpenRouter, so first-party keys
  // still win exactly like the OpenRouter path.
  const openRouterActive =
    !requestyActive && (isOpenRouterBaseUrl(options.baseUrl) || Boolean(options.openRouterApiKey));

  if (known && !openRouterActive && !requestyActive) {
    return known;
  }

  // Try to enrich from the Requesty catalog when available.
  if (requestyActive && options.requestyApiKey) {
    try {
      const catalog = await fetchRequestyCatalog(options.requestyApiKey, fetcher);
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
          pricing: openRouterPricing(info.pricing) ?? known?.pricing ?? null,
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
          pricing: openRouterPricing(info.pricing) ?? known?.pricing ?? null,
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

const VALID_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the override's `apiModel` for a *known* model when present and non-empty,
 * otherwise `undefined`. Single source of truth for the override apiModel rule,
 * shared by {@link applyModelOverride} and the CLI's `effectiveModelId` resolution.
 */
export function resolveOverriddenApiModel(
  model: ModelName,
  overrides?: ModelOverridesConfig,
): string | undefined {
  if (!overrides || !isKnownModel(model)) return undefined;
  const override: unknown = overrides[model];
  if (!isRecord(override)) return undefined;
  if (typeof override.apiModel === "string" && override.apiModel.trim() !== "") {
    return override.apiModel.trim();
  }
  return undefined;
}

/**
 * Apply a user-config per-model override on top of a resolved config.
 *
 * Scope is intentionally narrow: only *known* models can be overridden, so the
 * tokenizer (a function, not expressible in JSON) and any unspecified fields are
 * inherited from the base config. Override fields are validated defensively
 * because they come from user-authored JSON5.
 */
export function applyModelOverride(
  base: ModelConfig,
  model: ModelName,
  overrides?: ModelOverridesConfig,
): ModelConfig {
  if (!overrides || !isKnownModel(model)) return base;
  const override: unknown = overrides[model];
  if (!isRecord(override)) return base;

  const result: ModelConfig = { ...base };

  const apiModel = resolveOverriddenApiModel(model, overrides);
  if (apiModel) {
    result.apiModel = apiModel;
  }

  if (Object.hasOwn(override, "reasoning")) {
    const reasoning = override.reasoning;
    if (reasoning === null) {
      // Explicit null clears the known model's reasoning effort.
      result.reasoning = null;
    } else if (
      isRecord(reasoning) &&
      typeof reasoning.effort === "string" &&
      VALID_REASONING_EFFORTS.includes(reasoning.effort as ReasoningEffort)
    ) {
      result.reasoning = { effort: reasoning.effort as ReasoningEffort };
    }
    // Malformed reasoning override is ignored (base value preserved).
  }

  if (
    typeof override.inputLimit === "number" &&
    Number.isSafeInteger(override.inputLimit) &&
    override.inputLimit > 0
  ) {
    result.inputLimit = override.inputLimit;
  }
  // Non-positive or non-integer inputLimit (e.g. 0, 0.5, NaN, Infinity) is ignored.

  if (Object.hasOwn(override, "pricing")) {
    const pricing = override.pricing;
    if (pricing === null) {
      result.pricing = null;
    } else if (
      isRecord(pricing) &&
      typeof pricing.inputPerToken === "number" &&
      Number.isFinite(pricing.inputPerToken) &&
      pricing.inputPerToken >= 0 &&
      typeof pricing.outputPerToken === "number" &&
      Number.isFinite(pricing.outputPerToken) &&
      pricing.outputPerToken >= 0
    ) {
      result.pricing = {
        inputPerToken: pricing.inputPerToken,
        outputPerToken: pricing.outputPerToken,
      };
    }
    // Malformed pricing override is ignored (base value preserved).
  }

  return result;
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
