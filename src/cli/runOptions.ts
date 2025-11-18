import type { RunOracleOptions } from '../oracle.js';
import type { UserConfig } from '../config.js';
import type { EngineMode } from './engine.js';
import { resolveEngine } from './engine.js';
import { normalizeModelOption, inferModelFromLabel, resolveApiModel } from './options.js';

export interface ResolveRunOptionsInput {
  prompt: string;
  files?: string[];
  model?: string;
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
  engine,
  userConfig,
  env = process.env,
}: ResolveRunOptionsInput): ResolvedRunOptions {
  const resolvedEngine = resolveEngineWithConfig({ engine, configEngine: userConfig?.engine, env });

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || 'gpt-5-pro';
  const resolvedModel = resolvedEngine === 'browser' ? inferModelFromLabel(cliModelArg) : resolveApiModel(cliModelArg);

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search =
    userConfig?.search === 'off'
      ? false
      : userConfig?.search === 'on'
        ? true
        : true;

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;

  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: resolvedModel,
    file: files ?? [],
    search,
    heartbeatIntervalMs,
    filesReport: userConfig?.filesReport,
    background: userConfig?.background,
  };

  return { runOptions, resolvedEngine };
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
