import type { RunOracleOptions, ModelName } from '../oracle.js';
import { DEFAULT_MODEL, MODEL_CONFIGS } from '../oracle.js';
import type { UserConfig } from '../config.js';
import type { EngineMode } from './engine.js';
import { resolveEngine } from './engine.js';
import { normalizeModelOption, inferModelFromLabel, resolveApiModel, normalizeBaseUrl } from './options.js';
import { resolveGeminiModelId } from '../oracle/gemini.js';
import { PromptValidationError } from '../oracle/errors.js';
import { normalizeChatGptModelForBrowser } from './browserConfig.js';

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
  const resolvedEngine = resolveEngineWithConfig({ engine, configEngine: userConfig?.engine, env });
  const browserRequested = engine === 'browser';
  const browserConfigured = userConfig?.engine === 'browser';
  const requestedModelList = Array.isArray(models) ? models : [];
  const normalizedRequestedModels = requestedModelList.map((entry) => normalizeModelOption(entry)).filter(Boolean);

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || DEFAULT_MODEL;
  const inferredModel =
    resolvedEngine === 'browser' && normalizedRequestedModels.length === 0
      ? inferModelFromLabel(cliModelArg)
      : resolveApiModel(cliModelArg);
  // Browser engine maps Pro/legacy aliases to the latest ChatGPT picker targets (GPT-5.2 / GPT-5.2 Pro).
  const resolvedModel = resolvedEngine === 'browser' ? normalizeChatGptModelForBrowser(inferredModel) : inferredModel;
  const isCodex = resolvedModel.startsWith('gpt-5.1-codex');
  const isClaude = resolvedModel.startsWith('claude');
  const isGrok = resolvedModel.startsWith('grok');

  const engineWasBrowser = resolvedEngine === 'browser';
  const allModels: ModelName[] =
    normalizedRequestedModels.length > 0
      ? Array.from(new Set(normalizedRequestedModels.map((entry) => resolveApiModel(entry))))
      : [resolvedModel];
  const isBrowserCompatible = (m: string) => m.startsWith('gpt-') || m.startsWith('gemini');
  const hasNonBrowserCompatibleTarget = (browserRequested || browserConfigured) && allModels.some((m) => !isBrowserCompatible(m));
  if (hasNonBrowserCompatibleTarget) {
    throw new PromptValidationError(
      'Browser engine only supports GPT and Gemini models. Re-run with --engine api for Grok, Claude, or other models.',
      { engine: 'browser', models: allModels },
    );
  }

  const engineCoercedToApi = engineWasBrowser && (isCodex || isClaude || isGrok);
  const fixedEngine: EngineMode =
    isCodex || isClaude || isGrok || normalizedRequestedModels.length > 0 ? 'api' : resolvedEngine;

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search = userConfig?.search !== 'off';

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;

  const baseUrl = normalizeBaseUrl(
    userConfig?.apiBaseUrl ??
      (isClaude ? env.ANTHROPIC_BASE_URL : isGrok ? env.XAI_BASE_URL : env.OPENAI_BASE_URL),
  );
  const uniqueMultiModels: ModelName[] = normalizedRequestedModels.length > 0 ? allModels : [];
  const includesCodexMultiModel = uniqueMultiModels.some((entry) => entry.startsWith('gpt-5.1-codex'));
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
    search,
    heartbeatIntervalMs,
    filesReport: userConfig?.filesReport,
    background: userConfig?.background,
    baseUrl,
    effectiveModelId,
  };

  return { runOptions, resolvedEngine: fixedEngine, engineCoercedToApi };
}

function resolveEngineWithConfig({
  engine,
  configEngine,
  env,
}: {
  engine?: EngineMode;
  configEngine?: EngineMode;
  env: NodeJS.ProcessEnv;
}): EngineMode {
  if (engine) return engine;
  if (configEngine) return configEngine;
  return resolveEngine({ engine: undefined, env });
}

function resolveEffectiveModelId(model: ModelName): string {
  if (typeof model === 'string' && model.startsWith('gemini')) {
    return resolveGeminiModelId(model);
  }
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  return config?.apiModel ?? model;
}
