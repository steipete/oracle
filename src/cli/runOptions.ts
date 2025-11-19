import type { RunOracleOptions, ModelName } from '../oracle.js';
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

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || 'gpt-5-pro';
  const resolvedModel =
    resolvedEngine === 'browser' && normalizedRequestedModels.length === 0
      ? inferModelFromLabel(cliModelArg)
      : resolveApiModel(cliModelArg);
  const isGemini = resolvedModel.startsWith('gemini');
  // Keep the resolved model id alongside the canonical model name so we can log
  // and dispatch the exact identifier (useful for Gemini preview aliases).
  const effectiveModelId = isGemini ? resolveGeminiModelId(resolvedModel) : resolvedModel;

  if (isGemini && browserRequested) {
    throw new Error('Gemini is only supported via API. Use --engine api.');
  }
  // When Gemini is selected, always force API engine (overrides config/env auto browser).
  const fixedEngine: EngineMode =
    isGemini || normalizedRequestedModels.length > 0 ? 'api' : resolvedEngine;

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

  return { runOptions, resolvedEngine: fixedEngine };
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
