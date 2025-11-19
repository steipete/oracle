import type { RunOracleOptions, ModelName } from '../oracle.js';
import { DEFAULT_MODEL } from '../oracle.js';
import type { UserConfig } from '../config.js';
import type { EngineMode } from './engine.js';
import { resolveEngine } from './engine.js';
import { normalizeModelOption, inferModelFromLabel, resolveApiModel, normalizeBaseUrl } from './options.js';
import { resolveGeminiModelId } from '../oracle/gemini.js';

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
  const requestedModelList = Array.isArray(models) ? models : [];
  const normalizedRequestedModels = requestedModelList.map((entry) => normalizeModelOption(entry)).filter(Boolean);

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || DEFAULT_MODEL;
  const resolvedModel =
    resolvedEngine === 'browser' && normalizedRequestedModels.length === 0
      ? inferModelFromLabel(cliModelArg)
      : resolveApiModel(cliModelArg);
  const isGemini = resolvedModel.startsWith('gemini');
  const isCodex = resolvedModel.startsWith('gpt-5.1-codex');
  // Keep the resolved model id alongside the canonical model name so we can log
  // and dispatch the exact identifier (useful for Gemini preview aliases).
  const effectiveModelId = isGemini ? resolveGeminiModelId(resolvedModel) : resolvedModel;

  const engineCoercedToApi = (isGemini || isCodex) && browserRequested;
  // When Gemini or Codex is selected, always force API engine (overrides config/env auto browser).
  const fixedEngine: EngineMode =
    isGemini || isCodex || normalizedRequestedModels.length > 0 ? 'api' : resolvedEngine;

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search = userConfig?.search !== 'off';

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;

  const baseUrl = normalizeBaseUrl(userConfig?.apiBaseUrl ?? env.OPENAI_BASE_URL);
  const uniqueMultiModels: ModelName[] =
    normalizedRequestedModels.length > 0
      ? Array.from(new Set(normalizedRequestedModels.map((entry) => resolveApiModel(entry))))
      : [];
  const includesCodexMultiModel = uniqueMultiModels.some((entry) => entry.startsWith('gpt-5.1-codex'));
  if (includesCodexMultiModel && browserRequested) {
    // Silent coerce; multi-model still forces API.
  }

  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: uniqueMultiModels[0] ?? resolvedModel,
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
