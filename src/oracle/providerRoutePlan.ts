import { isCustomBaseUrl } from "./client.js";
import { formatBaseUrlForLog, maskApiKey } from "./logging.js";
import {
  defaultOpenRouterBaseUrl,
  isOpenRouterBaseUrl,
  normalizeOpenRouterBaseUrl,
} from "./modelResolver.js";
import { resolveProviderRoutingState, validateProviderRouting } from "./providerRouting.js";
import type { ApiProviderMode, AzureOptions, ModelConfig, ModelName } from "./types.js";

const DEFAULT_PROVIDER_HOSTS: Record<string, string> = {
  anthropic: "api.anthropic.com",
  google: "generativelanguage.googleapis.com",
  openai: "api.openai.com",
  xai: "api.x.ai",
};

export interface ProviderRoutePlanInput {
  model: ModelName;
  providerMode?: ApiProviderMode;
  azure?: AzureOptions;
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderRoutePlan {
  model: ModelName;
  ok: boolean;
  provider: NonNullable<ModelConfig["provider"]> | "azure";
  providerLabel: string;
  base: string;
  keySource: string;
  keyPreview: string;
  keyPresent: boolean;
  isAzureOpenAI: boolean;
  azureConfigured: boolean;
  azureDeploymentName?: string;
  azureNote?: string;
  error?: string;
}

export function buildProviderRoutePlan(input: ProviderRoutePlanInput): ProviderRoutePlan {
  const env = input.env ?? process.env;
  const providerMode = input.providerMode ?? "auto";
  const azureConfigured = Boolean(input.azure?.endpoint?.trim());

  try {
    validateProviderRouting({
      model: input.model,
      providerMode,
      azure: input.azure,
    });
  } catch (error) {
    const state = tryResolveProviderRoutingState({
      model: input.model,
      providerMode,
      azure: input.azure,
    });
    const provider =
      state?.provider ??
      (providerMode === "openai" ? "openai" : inferProviderFromModel(input.model));
    const isAzureOpenAI = state?.isAzureOpenAI ?? providerMode === "azure";
    const key = getKeyForRoute({
      model: input.model,
      provider,
      providerMode,
      isAzureOpenAI,
      baseUrl: input.baseUrl,
      openRouterFallback: false,
      apiKey: input.apiKey,
      env,
    });
    return {
      model: input.model,
      ok: false,
      provider: isAzureOpenAI ? "azure" : provider,
      providerLabel: isAzureOpenAI ? "Azure OpenAI" : providerLabel(provider),
      base: isAzureOpenAI
        ? formatRouteTargetForLog(state?.azureEndpoint ?? input.azure?.endpoint)
        : formatRouteTargetForLog(input.baseUrl, DEFAULT_PROVIDER_HOSTS[provider]),
      keySource: key.source,
      keyPreview: key.preview,
      keyPresent: key.present,
      isAzureOpenAI,
      azureConfigured,
      azureDeploymentName: state?.azureDeploymentName,
      azureNote: azureNote(providerMode, azureConfigured, isAzureOpenAI),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const state = resolveProviderRoutingState({
    model: input.model,
    providerMode,
    azure: input.azure,
  });
  const provider = state.provider;
  const isAzureOpenAI = state.isAzureOpenAI;
  let baseUrl = input.baseUrl?.trim();
  const providerQualifiedOpenRouterCandidate =
    !isAzureOpenAI && providerMode !== "openai" && input.model.includes("/");
  if (
    baseUrl &&
    providerQualifiedOpenRouterCandidate &&
    !isOpenRouterBaseUrl(baseUrl) &&
    !isCustomBaseUrl(baseUrl)
  ) {
    baseUrl = undefined;
  }
  if (!baseUrl) {
    let envBaseUrl: string | undefined;
    if (input.model.startsWith("grok")) {
      envBaseUrl = env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1";
    } else if (provider === "anthropic") {
      envBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
    } else {
      envBaseUrl = env.OPENAI_BASE_URL?.trim();
    }
    if (!providerQualifiedOpenRouterCandidate || (envBaseUrl && isCustomBaseUrl(envBaseUrl))) {
      baseUrl = envBaseUrl;
    }
  }

  const nativeKey = getNativeKey({
    model: input.model,
    provider,
    providerMode,
    isAzureOpenAI,
    apiKey: input.apiKey,
    env,
  });
  const providerQualifiedOpenRouterRoute = providerQualifiedOpenRouterCandidate && !baseUrl;
  const providerKeyMissing =
    !isAzureOpenAI &&
    (providerQualifiedOpenRouterRoute
      ? true
      : providerMode === "openai"
        ? !nativeKey.present
        : (provider === "openai" && !nativeKey.present) ||
          (provider === "anthropic" && !nativeKey.present) ||
          (provider === "google" && !nativeKey.present) ||
          (provider === "xai" && !nativeKey.present) ||
          provider === "other");
  const openRouterKey = readKey(["OPENROUTER_API_KEY"], env);
  const openRouterFallback =
    !baseUrl &&
    (providerQualifiedOpenRouterRoute ||
      (providerMode !== "openai" &&
        providerKeyMissing &&
        (provider === "other" || openRouterKey.present)));

  if (openRouterFallback) {
    baseUrl = defaultOpenRouterBaseUrl();
  }
  if (baseUrl && isOpenRouterBaseUrl(baseUrl)) {
    baseUrl = normalizeOpenRouterBaseUrl(baseUrl);
  }

  const key = getKeyForRoute({
    model: input.model,
    provider,
    providerMode,
    isAzureOpenAI,
    baseUrl,
    openRouterFallback,
    apiKey: input.apiKey,
    env,
  });
  const routeProvider = routeProviderLabel({
    provider,
    baseUrl,
    openRouterFallback,
    isAzureOpenAI,
  });
  const fallbackHost = DEFAULT_PROVIDER_HOSTS[provider] ?? DEFAULT_PROVIDER_HOSTS.openai;

  return {
    model: input.model,
    ok: key.present,
    provider: isAzureOpenAI ? "azure" : provider,
    providerLabel: routeProvider,
    base: isAzureOpenAI
      ? formatRouteTargetForLog(state.azureEndpoint)
      : formatRouteTargetForLog(baseUrl, fallbackHost),
    keySource: key.source,
    keyPreview: key.preview,
    keyPresent: key.present,
    isAzureOpenAI,
    azureConfigured,
    azureDeploymentName: state.azureDeploymentName,
    azureNote: azureNote(providerMode, azureConfigured, isAzureOpenAI),
    error: key.present ? undefined : `Missing ${key.source}.`,
  };
}

function getNativeKey({
  model,
  provider,
  providerMode,
  isAzureOpenAI,
  apiKey,
  env,
}: {
  model: ModelName;
  provider: NonNullable<ModelConfig["provider"]>;
  providerMode: ApiProviderMode;
  isAzureOpenAI: boolean;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
}) {
  return getKeyForRoute({
    model,
    provider,
    providerMode,
    isAzureOpenAI,
    baseUrl: undefined,
    openRouterFallback: false,
    apiKey,
    env,
  });
}

function getKeyForRoute({
  model,
  provider,
  providerMode,
  isAzureOpenAI,
  baseUrl,
  openRouterFallback,
  apiKey,
  env,
}: {
  model: ModelName;
  provider: NonNullable<ModelConfig["provider"]>;
  providerMode: ApiProviderMode;
  isAzureOpenAI: boolean;
  baseUrl?: string;
  openRouterFallback: boolean;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
}): { source: string; preview: string; present: boolean } {
  if (apiKey) {
    return { source: "apiKey option", preview: maskApiKey(apiKey) ?? "set", present: true };
  }
  if (isAzureOpenAI) {
    return readKey(["AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"], env);
  }
  if (providerMode === "openai") {
    return readKey(["OPENAI_API_KEY"], env);
  }
  if (isOpenRouterBaseUrl(baseUrl) || openRouterFallback) {
    return readKey(["OPENROUTER_API_KEY"], env);
  }
  if (model.includes("/")) {
    return readKey(["OPENROUTER_API_KEY"], env);
  }
  if (model.startsWith("gpt")) {
    return readKey(["OPENAI_API_KEY"], env);
  }
  if (model.startsWith("gemini")) {
    return readKey(["GEMINI_API_KEY"], env);
  }
  if (model.startsWith("claude")) {
    return readKey(["ANTHROPIC_API_KEY"], env);
  }
  if (model.startsWith("grok")) {
    return readKey(["XAI_API_KEY"], env);
  }
  if (provider === "other") {
    return readKey(["OPENROUTER_API_KEY"], env);
  }
  return readKey(["OPENAI_API_KEY"], env);
}

function readKey(
  names: string[],
  env: NodeJS.ProcessEnv,
): { source: string; preview: string; present: boolean } {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return { source: name, preview: `${name}=${maskApiKey(value) ?? "set"}`, present: true };
    }
  }
  return { source: names.join("|"), preview: "missing", present: false };
}

function routeProviderLabel({
  provider,
  baseUrl,
  openRouterFallback,
  isAzureOpenAI,
}: {
  provider: NonNullable<ModelConfig["provider"]>;
  baseUrl?: string;
  openRouterFallback: boolean;
  isAzureOpenAI: boolean;
}): string {
  if (isAzureOpenAI) return "Azure OpenAI";
  if (isOpenRouterBaseUrl(baseUrl) || openRouterFallback) return "OpenRouter";
  if (baseUrl && isCustomBaseUrl(baseUrl)) return "OpenAI-compatible";
  return providerLabel(provider);
}

function providerLabel(provider: NonNullable<ModelConfig["provider"]>): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google Gemini";
  if (provider === "xai") return "xAI";
  return "OpenAI";
}

function tryResolveProviderRoutingState(input: {
  model: ModelName;
  providerMode: ApiProviderMode;
  azure?: AzureOptions;
}): ReturnType<typeof resolveProviderRoutingState> | undefined {
  try {
    return resolveProviderRoutingState(input);
  } catch {
    return undefined;
  }
}

function inferProviderFromModel(model: ModelName): NonNullable<ModelConfig["provider"]> {
  const prefix = model.includes("/") ? model.split("/", 1)[0] : undefined;
  if (prefix === "openai") return "openai";
  if (prefix === "anthropic") return "anthropic";
  if (prefix === "google") return "google";
  if (prefix === "xai") return "xai";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("gemini")) return "google";
  if (model.startsWith("grok")) return "xai";
  return "other";
}

function azureNote(
  providerMode: ApiProviderMode,
  azureConfigured: boolean,
  isAzureOpenAI: boolean,
): string | undefined {
  if (!azureConfigured) return undefined;
  if (providerMode === "openai") return "ignored, --provider openai/--no-azure is active";
  if (isAzureOpenAI) return "active because Azure endpoint is configured";
  return "configured, not used for this model";
}

export function formatRouteTargetForLog(raw: string | undefined, fallbackHost = ""): string {
  if (!raw) return fallbackHost;
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let routePath = "";
    if (segments.length > 0) {
      routePath = `/${segments[0]}`;
      if (segments.length > 1) {
        routePath += "/...";
      }
    }
    return `${parsed.host}${routePath}`;
  } catch {
    const formatted = formatBaseUrlForLog(raw).replace(/^https?:\/\//u, "");
    return formatted || fallbackHost;
  }
}
