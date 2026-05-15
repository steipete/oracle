import type { RunOracleOptions, ModelName, AzureOptions } from "../oracle.js";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "../oracle.js";
import type { UserConfig } from "../config.js";
import type { EngineMode } from "./engine.js";
import { resolveEngine } from "./engine.js";
import {
  normalizeModelOption,
  inferModelFromLabel,
  resolveApiModel,
  normalizeBaseUrl,
} from "./options.js";
import { resolveGeminiModelId } from "../oracle/gemini.js";
import { PromptValidationError } from "../oracle/errors.js";
import { normalizeChatGptModelForBrowser } from "./browserConfig.js";
import { resolveConfiguredMaxFileSizeBytes } from "./fileSize.js";
import { isAzureOpenAICandidateModel } from "../oracle/providerRouting.js";

export interface ResolveRunOptionsInput {
  prompt: string;
  files?: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedRunOptions {
  runOptions: RunOracleOptions;
  resolvedEngine: EngineMode;
  engineCoercedToApi?: boolean;
}

export function resolveRunOptionsFromConfig({
  prompt,
  files = [],
  model,
  models,
  engine,
  userConfig,
  env = process.env,
}: ResolveRunOptionsInput): ResolvedRunOptions {
  const resolvedEngine = resolveEngineWithConfig({
    engine,
    configEngine: userConfig?.engine,
    env,
  });
  const browserRequested = engine === "browser";
  const browserConfigured = userConfig?.engine === "browser";
  const envBrowserConfigured = (env.ORACLE_ENGINE ?? "").trim().toLowerCase() === "browser";
  const requestedModelList = Array.isArray(models) ? models : [];
  const normalizedRequestedModels = requestedModelList
    .map((entry) => normalizeModelOption(entry))
    .filter(Boolean);

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || DEFAULT_MODEL;
  const apiModel = resolveApiModel(cliModelArg);
  const browserModel = normalizeChatGptModelForBrowser(inferModelFromLabel(cliModelArg));
  const isCodex = apiModel.startsWith("gpt-5.1-codex");
  const isClaude = apiModel.startsWith("claude");
  const isGrok = apiModel.startsWith("grok");
  const isGeminiApiOnly = apiModel === "gemini-3.1-pro";

  const engineWasBrowser = resolvedEngine === "browser";
  const allModels: ModelName[] =
    normalizedRequestedModels.length > 0
      ? Array.from(new Set(normalizedRequestedModels.map((entry) => resolveApiModel(entry))))
      : [apiModel];
  const browserCompatibilityModels: ModelName[] =
    normalizedRequestedModels.length > 0 ? allModels : [browserModel];
  const includesGeminiApiOnly = allModels.some((m) => m === "gemini-3.1-pro");
  if ((browserRequested || browserConfigured) && includesGeminiApiOnly) {
    throw new PromptValidationError(
      "gemini-3.1-pro is API-only today. Use --engine api or switch to gemini-3-pro for Gemini web.",
      { engine: "browser", models: allModels },
    );
  }
  const isBrowserCompatible = (m: string) => m.startsWith("gpt-") || m.startsWith("gemini");
  const hasNonBrowserCompatibleTarget =
    (browserRequested || browserConfigured) &&
    browserCompatibilityModels.some((m) => !isBrowserCompatible(m));
  if (hasNonBrowserCompatibleTarget) {
    throw new PromptValidationError(
      "Browser engine only supports GPT and Gemini models. Re-run with --engine api for Grok, Claude, or other models.",
      { engine: "browser", models: allModels },
    );
  }

  const azure = resolveAzureOptions(userConfig, env);
  const azureAutoApi =
    Boolean(azure?.endpoint) &&
    !browserRequested &&
    !browserConfigured &&
    !envBrowserConfigured &&
    allModels.some(isAzureOpenAICandidateModel);
  const engineCoercedToApi =
    engineWasBrowser && (isCodex || isClaude || isGrok || isGeminiApiOnly || azureAutoApi);
  const fixedEngine: EngineMode =
    isCodex ||
    isClaude ||
    isGrok ||
    isGeminiApiOnly ||
    azureAutoApi ||
    normalizedRequestedModels.length > 0
      ? "api"
      : resolvedEngine;
  // Browser runs use ChatGPT picker labels/aliases; API runs must keep API model ids intact.
  const resolvedModel = fixedEngine === "browser" ? browserModel : apiModel;

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search = userConfig?.search !== "off";

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;
  const maxFileSizeBytes = resolveConfiguredMaxFileSizeBytes(userConfig, env);

  const baseUrl = normalizeBaseUrl(
    userConfig?.apiBaseUrl ??
      (isClaude ? env.ANTHROPIC_BASE_URL : isGrok ? env.XAI_BASE_URL : env.OPENAI_BASE_URL),
  );
  const uniqueMultiModels: ModelName[] = normalizedRequestedModels.length > 0 ? allModels : [];
  const includesCodexMultiModel = uniqueMultiModels.some((entry) =>
    entry.startsWith("gpt-5.1-codex"),
  );
  if (includesCodexMultiModel && browserRequested) {
    // Silent coerce; multi-model still forces API.
  }

  const chosenModel: ModelName = uniqueMultiModels[0] ?? resolvedModel;
  const effectiveModelId = resolveEffectiveModelId(chosenModel);

  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: chosenModel,
    models: uniqueMultiModels.length > 0 ? uniqueMultiModels : undefined,
    file: files ?? [],
    maxFileSizeBytes,
    search,
    heartbeatIntervalMs,
    filesReport: userConfig?.filesReport,
    background: userConfig?.background,
    baseUrl,
    azure,
    effectiveModelId,
  };

  return { runOptions, resolvedEngine: fixedEngine, engineCoercedToApi };
}

function resolveEngineWithConfig({
  engine,
  configEngine,
  apiProviderRequested,
  env,
}: {
  engine?: EngineMode;
  configEngine?: EngineMode;
  apiProviderRequested?: boolean;
  env: NodeJS.ProcessEnv;
}): EngineMode {
  if (engine) return engine;
  const envOverride = (env.ORACLE_ENGINE ?? "").trim().toLowerCase();
  if (envOverride === "api" || envOverride === "browser") {
    return envOverride as EngineMode;
  }
  if (configEngine) return configEngine;
  return resolveEngine({ engine: undefined, apiProviderRequested, env });
}

function resolveAzureOptions(
  userConfig: UserConfig | undefined,
  env: NodeJS.ProcessEnv,
): AzureOptions | undefined {
  const endpoint = env.AZURE_OPENAI_ENDPOINT ?? userConfig?.azure?.endpoint;
  if (!endpoint?.trim()) {
    return undefined;
  }
  return {
    endpoint,
    deployment: env.AZURE_OPENAI_DEPLOYMENT ?? userConfig?.azure?.deployment,
    apiVersion: env.AZURE_OPENAI_API_VERSION ?? userConfig?.azure?.apiVersion,
  };
}

function resolveEffectiveModelId(model: ModelName): string {
  if (typeof model === "string" && model.startsWith("gemini")) {
    return resolveGeminiModelId(model);
  }
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  return config?.apiModel ?? model;
}
