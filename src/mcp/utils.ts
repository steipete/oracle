import type { RunOracleOptions } from '../oracle.js';
import type { EngineMode } from '../cli/engine.js';
import type { UserConfig } from '../config.js';
import { resolveRunOptionsFromConfig } from '../cli/runOptions.js';
import { Launcher } from 'chrome-launcher';

export function mapConsultToRunOptions({
  prompt,
  files,
  model,
  engine,
  search,
  userConfig,
  env = process.env,
}: {
  prompt: string;
  files: string[];
  model?: string;
  engine?: EngineMode;
  search?: boolean;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): { runOptions: RunOracleOptions; resolvedEngine: EngineMode } {
  const result = resolveRunOptionsFromConfig({ prompt, files, model, engine, userConfig, env });
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
