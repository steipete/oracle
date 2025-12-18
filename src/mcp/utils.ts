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
  browserAttachments,
  browserBundleFiles,
  userConfig,
  env = process.env,
}: {
  prompt: string;
  files: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  search?: boolean;
  browserAttachments?: 'auto' | 'never' | 'always';
  browserBundleFiles?: boolean;
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
  if (browserAttachments) {
    result.runOptions.browserAttachments = browserAttachments;
  }
  if (typeof browserBundleFiles === 'boolean') {
    result.runOptions.browserBundleFiles = browserBundleFiles;
  }
  return result;
}

export function ensureBrowserAvailable(engine: EngineMode, options?: { remoteHost?: string | null }): string | null {
  if (engine !== 'browser') {
    return null;
  }
  const remoteHost = options?.remoteHost?.trim() || process.env.ORACLE_REMOTE_HOST?.trim();
  if (remoteHost) {
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
