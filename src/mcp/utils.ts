import type { RunOracleOptions } from '../oracle.js';
import type { EngineMode } from '../cli/engine.js';
import type { UserConfig } from '../config.js';
import { resolveRunOptionsFromConfig } from '../cli/runOptions.js';
import { Launcher } from 'chrome-launcher';

export function mapConsultToRunOptions({
  prompt,
  files,
  model,
  models,
  engine,
  search,
  userConfig,
  env = process.env,
}: {
  prompt: string;
  files: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  search?: boolean;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): { runOptions: RunOracleOptions; resolvedEngine: EngineMode } {
  // Normalize CLI-style inputs through the shared resolver so config/env defaults apply,
  // then overlay MCP-only overrides such as explicit search toggles.
  const mergedModels =
    Array.isArray(models) && models.length > 0
      ? [model, ...models].filter((entry): entry is string => Boolean(entry?.trim()))
      : models;
  const result = resolveRunOptionsFromConfig({ prompt, files, model, models: mergedModels, engine, userConfig, env });
  if (typeof search === 'boolean') {
    result.runOptions.search = search;
  }
  return result;
}

export function ensureBrowserAvailable(engine: EngineMode): string | null {
  if (engine !== 'browser') {
    return null;
  }
  if (process.env.CHROME_PATH) {
    return null;
  }
  const found = Launcher.getFirstInstallation();
  if (!found) {
    return 'Browser engine unavailable: no Chrome installation found and CHROME_PATH is unset.';
  }
  return null;
}
