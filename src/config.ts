import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { getOracleHomeDir } from "./oracleHome.js";
import type {
  BrowserArchiveMode,
  BrowserModelStrategy,
  BrowserResearchMode,
} from "./browser/types.js";
import type { ThinkingTimeLevel, ModelOverridesConfig } from "./oracle/types.js";

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
  /** Optional metadata for the SSH reverse-tunnel that makes remoteHost reachable. */
  remoteViaSshReverseTunnel?: RemoteViaSshReverseTunnelConfig | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Time budget for attachment upload/readiness before clicking send. */
  attachmentTimeoutMs?: number;
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
  /**
   * Per-model overrides merged over known model configs (apiModel, reasoning,
   * inputLimit, pricing). User-config only: intentionally excluded from
   * {@link sanitizeProjectConfig} so untrusted project configs cannot reroute
   * model traffic.
   */
  modelOverrides?: ModelOverridesConfig;
}

export const PROJECT_CONFIG_RELATIVE_PATH = path.join(".oracle", "config.json");

function resolveUserConfigPath(): string {
  return path.join(getOracleHomeDir(), "config.json");
}

export interface LoadConfigResult {
  config: UserConfig;
  /** The user config path; `loaded` refers to this path only. */
  path: string;
  /** All config files that were actually loaded, including project configs. */
  paths: string[];
  loaded: boolean;
}

export interface LoadUserConfigOptions {
  cwd?: string;
  includeProject?: boolean;
}

interface ReadConfigResult {
  config: UserConfig;
  path: string;
  loaded: boolean;
}

export async function loadUserConfig(
  options: LoadUserConfigOptions = {},
): Promise<LoadConfigResult> {
  const userConfigPath = resolveUserConfigPath();
  const userConfig = await readConfigFile(userConfigPath);
  const projectConfigPaths =
    options.includeProject === false
      ? []
      : await discoverProjectConfigPaths({
          cwd: options.cwd ?? process.cwd(),
          userConfigPath,
        });

  const loadedConfigs: ReadConfigResult[] = [];
  if (userConfig.loaded) {
    loadedConfigs.push(userConfig);
  }

  let merged = userConfig.loaded ? userConfig.config : {};
  for (const projectConfigPath of projectConfigPaths) {
    const projectConfig = await readConfigFile(projectConfigPath);
    if (!projectConfig.loaded) continue;
    loadedConfigs.push(projectConfig);
    merged = mergeUserConfig(merged, sanitizeProjectConfig(projectConfig.config));
  }

  const loadedPaths = loadedConfigs.map((entry) => entry.path);
  return {
    config: merged,
    path: userConfigPath,
    paths: loadedPaths,
    loaded: userConfig.loaded,
  };
}

async function readConfigFile(configPath: string): Promise<ReadConfigResult> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON5.parse(raw) as UserConfig;
    return { config: parsed ?? {}, path: configPath, loaded: true };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return { config: {}, path: configPath, loaded: false };
    }
    console.warn(
      `Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { config: {}, path: configPath, loaded: false };
  }
}

export function configPath(): string {
  return resolveUserConfigPath();
}

async function discoverProjectConfigPaths({
  cwd,
  userConfigPath,
}: {
  cwd: string;
  userConfigPath: string;
}): Promise<string[]> {
  const start = path.resolve(cwd);
  const home = os.homedir();
  const candidates: string[] = [];
  const seen = new Set<string>([path.resolve(userConfigPath)]);
  let current = start;

  while (true) {
    if (current === home) {
      break;
    }

    const candidate = path.join(current, PROJECT_CONFIG_RELATIVE_PATH);
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      try {
        const stat = await fs.stat(resolved);
        if (stat.isFile()) {
          candidates.unshift(resolved);
          seen.add(resolved);
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          console.warn(
            `Failed to inspect ${resolved}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return candidates;
}

function mergeUserConfig(base: UserConfig, override: UserConfig): UserConfig {
  return deepMerge(base, override) as UserConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

function sanitizeProjectConfig(config: UserConfig): UserConfig {
  const sanitized: UserConfig = {};

  if (config.engine !== undefined) sanitized.engine = config.engine;
  if (config.model !== undefined) sanitized.model = config.model;
  if (config.search !== undefined) sanitized.search = config.search;
  if (config.maxFileSizeBytes !== undefined) sanitized.maxFileSizeBytes = config.maxFileSizeBytes;
  if (config.notify !== undefined) sanitized.notify = config.notify;
  if (config.heartbeatSeconds !== undefined) sanitized.heartbeatSeconds = config.heartbeatSeconds;
  if (config.filesReport !== undefined) sanitized.filesReport = config.filesReport;
  if (config.background !== undefined) sanitized.background = config.background;
  if (config.promptSuffix !== undefined) sanitized.promptSuffix = config.promptSuffix;
  // NOTE: `modelOverrides` is intentionally NOT copied here. Model routing
  // overrides are user-config only; allowing them from project configs would let
  // an untrusted repository silently redirect API calls (apiModel) or reasoning.

  if (config.browser) {
    sanitized.browser = {};
    const browser = config.browser;
    const allowedBrowserKeys: Array<keyof BrowserConfigDefaults> = [
      "attachRunning",
      "timeoutMs",
      "inputTimeoutMs",
      "attachmentTimeoutMs",
      "assistantRecheckDelayMs",
      "assistantRecheckTimeoutMs",
      "reuseChromeWaitMs",
      "profileLockTimeoutMs",
      "maxConcurrentTabs",
      "autoReattachDelayMs",
      "autoReattachIntervalMs",
      "autoReattachTimeoutMs",
      "cookieSyncWaitMs",
      "hideWindow",
      "keepBrowser",
      "modelStrategy",
      "thinkingTime",
      "researchMode",
      "archiveConversations",
      "manualLogin",
    ];

    for (const key of allowedBrowserKeys) {
      if (browser[key] !== undefined) {
        sanitized.browser[key] = browser[key] as never;
      }
    }

    const chatgptUrl = browser.chatgptUrl ?? browser.url;
    if (
      chatgptUrl === null ||
      (chatgptUrl !== undefined && isTrustedProjectChatgptUrl(chatgptUrl))
    ) {
      sanitized.browser.chatgptUrl = chatgptUrl;
      sanitized.browser.url = chatgptUrl;
    }
  }

  return sanitized;
}

function isTrustedProjectChatgptUrl(rawUrl: string): boolean {
  if (!rawUrl) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      return false;
    }
    return parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
  } catch {
    return false;
  }
}
