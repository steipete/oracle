import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';

export type EnginePreference = 'api' | 'browser';

export interface NotifyConfig {
  enabled?: boolean;
  sound?: boolean;
  muteIn?: Array<'CI' | 'SSH'>;
}

export interface BrowserConfigDefaults {
  chromeProfile?: string | null;
  chromePath?: string | null;
  url?: string;
  timeoutMs?: number;
  inputTimeoutMs?: number;
  headless?: boolean;
  hideWindow?: boolean;
  keepBrowser?: boolean;
}

export interface UserConfig {
  engine?: EnginePreference;
  model?: string;
  search?: 'on' | 'off';
  notify?: NotifyConfig;
  browser?: BrowserConfigDefaults;
  heartbeatSeconds?: number;
  filesReport?: boolean;
  background?: boolean;
  promptSuffix?: string;
  apiBaseUrl?: string;
}

function resolveConfigPath(): string {
  const oracleHome = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), '.oracle');
  return path.join(oracleHome, 'config.json');
}

export interface LoadConfigResult {
  config: UserConfig;
  path: string;
  loaded: boolean;
}

export async function loadUserConfig(): Promise<LoadConfigResult> {
  const CONFIG_PATH = resolveConfigPath();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON5.parse(raw) as UserConfig;
    return { config: parsed ?? {}, path: CONFIG_PATH, loaded: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      return { config: {}, path: CONFIG_PATH, loaded: false };
    }
    console.warn(`Failed to read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return { config: {}, path: CONFIG_PATH, loaded: false };
  }
}
export function configPath(): string {
  return resolveConfigPath();
}
