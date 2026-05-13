import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import { ensureOracleHomeDir, getOracleHomeDir } from "./oracleHome.js";
import type {
  BrowserArchiveMode,
  BrowserModelStrategy,
  BrowserResearchMode,
} from "./browser/types.js";
import type { ThinkingTimeLevel } from "./oracle/types.js";

export type EnginePreference = "api" | "browser";

export interface NotifyConfig {
  enabled?: boolean;
  sound?: boolean;
  muteIn?: Array<"CI" | "SSH">;
}

export interface BrowserConfigDefaults {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  chatgptUrl?: string | null;
  url?: string;
  /** Delegate browser automation to a remote `oracle serve` instance (host:port). */
  remoteHost?: string | null;
  /** Access token clients must provide to the remote `oracle serve` instance. */
  remoteToken?: string | null;
  /** Remote browser mode: preferred, required, or off. */
  remoteBrowser?: string | null;
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
  /** Soft limit for concurrent ChatGPT tabs sharing one manual-login profile. */
  maxConcurrentTabs?: number;
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
  /** Browser-only research mode. "deep" activates ChatGPT Deep Research. */
  researchMode?: BrowserResearchMode;
  /** Archive completed ChatGPT conversations after local artifacts are saved. */
  archiveConversations?: BrowserArchiveMode;
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
  search?: "on" | "off";
  maxFileSizeBytes?: number;
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
  return path.join(getOracleHomeDir(), "config.json");
}

export interface LoadConfigResult {
  config: UserConfig;
  path: string;
  loaded: boolean;
}

export interface LoadUserConfigOptions {
  env?: NodeJS.ProcessEnv;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEngine(value: unknown): EnginePreference | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized === "api" || normalized === "browser" ? normalized : undefined;
}

function normalizeConfigRecord(value: unknown, configPath: string): UserConfig {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${configPath} to contain a JSON object.`);
  }
  return value as UserConfig;
}

export function applyEnvConfigOverrides(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
): UserConfig {
  const next: UserConfig = { ...config };
  const envEngine = normalizeEngine(env.ORACLE_ENGINE);
  if (envEngine) {
    next.engine = envEngine;
  }

  const remoteHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const remoteToken = normalizeString(env.ORACLE_REMOTE_TOKEN);
  if (remoteHost || remoteToken) {
    next.browser = { ...(next.browser ?? {}) };
    if (remoteHost) {
      next.browser.remoteHost = remoteHost;
    }
    if (remoteToken) {
      next.browser.remoteToken = remoteToken;
    }
  }
  return next;
}

export async function loadUserConfig(
  options: LoadUserConfigOptions = {},
): Promise<LoadConfigResult> {
  const CONFIG_PATH = resolveConfigPath();
  const env = options.env ?? process.env;
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = normalizeConfigRecord(JSON5.parse(raw), CONFIG_PATH);
    return {
      config: applyEnvConfigOverrides(parsed, env),
      path: CONFIG_PATH,
      loaded: true,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        config: applyEnvConfigOverrides({}, env),
        path: CONFIG_PATH,
        loaded: false,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Config file at ${CONFIG_PATH} had a parse error: ${message}; using defaults`);
    return {
      config: applyEnvConfigOverrides({}, env),
      path: CONFIG_PATH,
      loaded: false,
    };
  }
}
export function configPath(): string {
  return resolveConfigPath();
}

export async function writeUserConfig(
  config: UserConfig,
  targetPath: string = resolveConfigPath(),
): Promise<void> {
  const resolvedTarget = path.resolve(targetPath);
  const dir = path.dirname(resolvedTarget);
  if (resolvedTarget === resolveConfigPath()) {
    await ensureOracleHomeDir();
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = path.join(dir, `.config.json.tmp-${process.pid}-${randomUUID()}`);
  try {
    await fs.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(tempPath, resolvedTarget);
    if (process.platform !== "win32") {
      await fs.chmod(resolvedTarget, 0o600).catch(() => undefined);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
