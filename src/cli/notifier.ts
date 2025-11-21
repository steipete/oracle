import notifier from 'toasted-notifier';
import { spawn } from 'node:child_process';
import { formatUSD, formatNumber } from '../oracle/format.js';
import { MODEL_CONFIGS } from '../oracle/config.js';
import type { SessionMode, SessionMetadata } from '../sessionStore.js';
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
  answerPreview?: string,
): Promise<void> {
  if (!settings.enabled || isTestEnv(process.env)) {
    return;
  }

  const title = `Oracle${ORACLE_EMOJI} finished`;
  const message = buildMessage(payload, sanitizePreview(answerPreview));

  try {
    if (await tryMacNativeNotifier(title, message, settings)) {
      return;
    }
    if (!(await shouldSkipToastedNotifier())) {
      // Fallback to toasted-notifier (cross-platform). macAppIconOption() is only honored on macOS.
      await notifier.notify({
        title,
        message,
        sound: settings.sound,
      });
      return;
    }
  } catch (error) {
    if (isMacExecError(error)) {
      const repaired = await repairMacNotifier(log);
      if (repaired) {
        try {
          await notifier.notify({ title, message, sound: settings.sound, ...(macAppIconOption()) });
          return;
        } catch (retryError) {
          const reason = describeNotifierError(retryError);
          log(`(notify skipped after retry: ${reason})`);
          return;
        }
      }
    }
    if (isMacBadCpuError(error)) {
      const reason = describeNotifierError(error);
      log(`(notify skipped: ${reason})`);
      return;
    }
    const reason = describeNotifierError(error);
    log(`(notify skipped: ${reason})`);
  }
  // Last-resort macOS fallback: AppleScript alert (simple, noisy, but works when helpers are blocked).
  if (process.platform === 'darwin') {
    try {
      await sendOsascriptAlert(title, message, log);
      return;
    } catch (scriptError) {
      const reason = describeNotifierError(scriptError);
      log(`(notify skipped: osascript fallback failed: ${reason})`);
    }
  }
}

function buildMessage(payload: NotificationContent, answerPreview?: string): string {
  const parts: string[] = [];
  const sessionLabel = payload.sessionName || payload.sessionId;
  parts.push(sessionLabel);

  // Show cost only for API runs.
  if (payload.mode === 'api') {
    const cost = payload.costUsd ?? inferCost(payload);
    if (cost !== undefined) {
      // Round to $0.00 for a concise toast.
      parts.push(formatUSD(Number(cost.toFixed(2))));
    }
  }

  if (payload.characters != null) {
    parts.push(`${formatNumber(payload.characters)} chars`);
  }

  if (answerPreview) {
    parts.push(answerPreview);
  }

  return parts.join(' · ');
}

function sanitizePreview(preview?: string): string | undefined {
  if (!preview) return undefined;
  let text = preview;
  // Strip code fences and inline code markers.
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]+)`/g, '$1');
  // Convert markdown links and images to their visible text.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Drop bold/italic markers.
  text = text.replace(/(\*\*|__|\*|_)/g, '');
  // Remove headings / list markers / blockquotes.
  text = text.replace(/^\s*#+\s*/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*>\s+/gm, '');
  // Collapse whitespace and trim.
  text = text.replace(/\s+/g, ' ').trim();
  // Limit length to keep notifications short.
  const max = 200;
  if (text.length > max) {
    text = `${text.slice(0, max - 1)}…`;
  }
  return text;
}

// Exposed for unit tests only.
export const testHelpers = { sanitizePreview };

function inferCost(payload: NotificationContent): number | undefined {
  const model = payload.model;
  const usage = payload.usage;
  if (!model || !usage) return undefined;
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config?.pricing) return undefined;
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

function isMacBadCpuError(error: unknown): boolean {
  return Boolean(
    process.platform === 'darwin' &&
    error &&
    typeof error === 'object' &&
    'errno' in error &&
    (error as { errno?: number }).errno === -86
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

async function shouldSkipToastedNotifier(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  // On Apple Silicon without Rosetta, prefer the native helper and skip x86-only fallback.
  const arch = process.arch;
  if (arch !== 'arm64') return false;
  return !(await hasRosetta());
}

async function hasRosetta(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('pkgutil', ['--files', 'com.apple.pkg.RosettaUpdateAuto'], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function sendOsascriptAlert(title: string, message: string, _log: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`], {
      stdio: 'ignore',
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`osascript exited with code ${code ?? -1}`));
      }
    });
    child.on('error', reject);
  });
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

function describeNotifierError(error: unknown): string {
  if (error && typeof error === 'object') {
    const err = error as NodeJS.ErrnoException;
    if (typeof err.errno === 'number' || typeof err.code === 'string') {
      const errno = typeof err.errno === 'number' ? err.errno : undefined;
      // macOS returns errno -86 for “Bad CPU type in executable” (e.g., wrong arch or quarantined binary).
      if (errno === -86) {
        return 'notifier binary failed to launch (Bad CPU type/quarantine); try xattr -dr com.apple.quarantine vendor/oracle-notifier && ./vendor/oracle-notifier/build-notifier.sh';
      }
    }
    if (typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
  }
  return typeof error === 'string' ? error : String(error);
}
