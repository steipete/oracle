import notifier from 'toasted-notifier';
import { spawn } from 'node:child_process';
import { formatUSD, formatNumber } from '../oracle/format.js';
import { MODEL_CONFIGS } from '../oracle/config.js';
import type { SessionMode, SessionMetadata } from '../sessionManager.js';
import type { NotifyConfig } from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
}

export interface NotificationContent {
  sessionId: string;
  sessionName?: string;
  mode: SessionMode;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd?: number;
  characters?: number;
}

const ORACLE_EMOJI = '🧿';

export function resolveNotificationSettings(
  {
    cliNotify,
    cliNotifySound,
    env,
    config,
  }: { cliNotify?: boolean; cliNotifySound?: boolean; env: NodeJS.ProcessEnv; config?: NotifyConfig },
): NotificationSettings {
  const defaultEnabled = !(bool(env.CI) || bool(env.SSH_CONNECTION) || muteByConfig(env, config));
  const envNotify = parseToggle(env.ORACLE_NOTIFY);
  const envSound = parseToggle(env.ORACLE_NOTIFY_SOUND);

  const enabled = cliNotify ?? envNotify ?? config?.enabled ?? defaultEnabled;
  const sound = cliNotifySound ?? envSound ?? config?.sound ?? false;

  return { enabled, sound };
}

export function deriveNotificationSettingsFromMetadata(
  metadata: SessionMetadata | null,
  env: NodeJS.ProcessEnv,
  config?: NotifyConfig,
): NotificationSettings {
  if (metadata?.notifications) {
    return metadata.notifications;
  }
  return resolveNotificationSettings({ cliNotify: undefined, cliNotifySound: undefined, env, config });
}

export async function sendSessionNotification(
  payload: NotificationContent,
  settings: NotificationSettings,
  log: (message: string) => void,
): Promise<void> {
  if (!settings.enabled || isTestEnv(process.env)) {
    return;
  }

  const title = `Oracle${ORACLE_EMOJI} finished`;
  const message = buildMessage(payload);

  try {
    if (await tryMacNativeNotifier(title, message, settings)) {
      return;
    }
    await notifier.notify({
      title,
      message,
      sound: settings.sound,
    });
  } catch (error) {
    if (isMacExecError(error)) {
      const repaired = await repairMacNotifier(log);
      if (repaired) {
        try {
          await notifier.notify({ title, message, sound: settings.sound, ...(macAppIconOption()) });
          return;
        } catch (retryError) {
          const reason = retryError instanceof Error ? retryError.message : String(retryError);
          log(`(notify skipped after retry: ${reason})`);
          return;
        }
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`(notify skipped: ${reason})`);
  }
}

function buildMessage(payload: NotificationContent): string {
  const parts: string[] = [];
  const sessionLabel = payload.sessionName || payload.sessionId;
  parts.push(`session ${sessionLabel}`);

  if (payload.mode === 'api') {
    const cost = payload.costUsd ?? inferCost(payload);
    if (cost !== undefined) {
      parts.push(formatUSD(cost));
    }
  }

  if (payload.characters != null) {
    parts.push(`${formatNumber(payload.characters)} chars`);
  }

  return parts.join(' · ');
}

function inferCost(payload: NotificationContent): number | undefined {
  const model = payload.model;
  const usage = payload.usage;
  if (!model || !usage) return undefined;
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) return undefined;
  return (
    usage.inputTokens * config.pricing.inputPerToken +
    usage.outputTokens * config.pricing.outputPerToken
  );
}

function parseToggle(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function bool(value: unknown): boolean {
  return Boolean(value && String(value).length > 0);
}

function isMacExecError(error: unknown): boolean {
  return Boolean(
    process.platform === 'darwin' &&
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'EACCES'
  );
}

async function repairMacNotifier(log: (message: string) => void): Promise<boolean> {
  const binPath = macNotifierPath();
  if (!binPath) return false;
  try {
    await fs.chmod(binPath, 0o755);
    return true;
  } catch (chmodError) {
    const reason = chmodError instanceof Error ? chmodError.message : String(chmodError);
    log(`(notify repair failed: ${reason} — try: xattr -dr com.apple.quarantine "${path.dirname(binPath)}")`);
    return false;
  }
}

function macNotifierPath(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const req = createRequire(import.meta.url);
    const modPath = req.resolve('toasted-notifier');
    const base = path.dirname(modPath);
    return path.join(
      base,
      'vendor',
      'mac.noindex',
      'terminal-notifier.app',
      'Contents',
      'MacOS',
      'terminal-notifier',
    );
  } catch {
    return null;
  }
}

function macAppIconOption(): Record<string, string> {
  if (process.platform !== 'darwin') return {};
  const iconPaths = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets-oracle-icon.png'),
    path.resolve(process.cwd(), 'assets-oracle-icon.png'),
  ];
  for (const candidate of iconPaths) {
    if (candidate && fsExistsSync(candidate)) {
      return { appIcon: candidate };
    }
  }
  return {};
}

function fsExistsSync(target: string): boolean {
  try {
    return Boolean(require('node:fs').statSync(target));
  } catch {
    return false;
  }
}

async function tryMacNativeNotifier(title: string, message: string, settings: NotificationSettings): Promise<boolean> {
  const binary = macNativeNotifierPath();
  if (!binary) return false;
  return new Promise((resolve) => {
    const child = spawn(binary, [title, message, settings.sound ? 'Glass' : ''], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

function macNativeNotifierPath(): string | null {
  if (process.platform !== 'darwin') return null;
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/oracle-notifier/OracleNotifier.app/Contents/MacOS/OracleNotifier'),
    path.resolve(process.cwd(), 'vendor/oracle-notifier/OracleNotifier.app/Contents/MacOS/OracleNotifier'),
  ];
  for (const candidate of candidates) {
    if (fsExistsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function muteByConfig(env: NodeJS.ProcessEnv, config?: NotifyConfig): boolean {
  if (!config?.muteIn) return false;
  return (
    (config.muteIn.includes('CI') && bool(env.CI)) ||
    (config.muteIn.includes('SSH') && bool(env.SSH_CONNECTION))
  );
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.ORACLE_DISABLE_NOTIFICATIONS === '1' ||
    env.NODE_ENV === 'test' ||
    Boolean(env.VITEST || env.VITEST_WORKER_ID || env.JEST_WORKER_ID)
  );
}
