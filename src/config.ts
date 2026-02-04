import fs from 'node:fs/promises';
import path from 'node:path';
import JSON5 from 'json5';
import { getOracleHomeDir } from './oracleHome.js';
import type { BrowserModelStrategy } from './browser/types.js';
import type { ThinkingTimeLevel } from './oracle/types.js';

export type EnginePreference = 'api' | 'browser';

export interface NotifyConfig {
  enabled?: boolean;
  sound?: boolean;
  muteIn?: Array<'CI' | 'SSH'>;
}

export interface BrowserConfigDefaults {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  chatgptUrl?: string | null;
  url?: string;
  /** Delegate browser automation to a remote `oracle serve` instance (host:port). */
  remoteHost?: string | null;
  /** Access token clients must provide to the remote `oracle serve` instance. */
  remoteToken?: string | null;
  /** Optional metadata for the SSH reverse-tunnel that makes remoteHost reachable. */
  remoteViaSshReverseTunnel?: RemoteViaSshReverseTunnelConfig | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSyncWaitMs?: number;
  headless?: boolean;
  hideWindow?: boolean;
  keepBrowser?: boolean;
  modelStrategy?: BrowserModelStrategy;
  /** Thinking time intensity (ChatGPT Thinking/Pro models): 'light', 'standard', 'extended', 'heavy' */
  thinkingTime?: ThinkingTimeLevel;
  /** Skip cookie sync and reuse a persistent automation profile (waits for manual ChatGPT login). */
  manualLogin?: boolean;
  /** Manual-login profile directory override (also available via ORACLE_BROWSER_PROFILE_DIR). */
  manualLoginProfileDir?: string | null;
}

export interface AzureConfig {
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

export interface RemoteViaSshReverseTunnelConfig {
  ssh?: string;
  remotePort?: number;
  localPort?: number;
  identity?: string;
  extraArgs?: string;
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
  azure?: AzureConfig;
  sessionRetentionHours?: number;
}

function resolveConfigPath(): string {
  return path.join(getOracleHomeDir(), 'config.json');
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
