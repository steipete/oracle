import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ProfileStateLogger = (message: string) => void;

const DEVTOOLS_ACTIVE_PORT_FILENAME = 'DevToolsActivePort';
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join('Default', DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const CHROME_PID_FILENAME = 'chrome.pid';

const execFileAsync = promisify(execFile);

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? '', 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, 'utf8');
    } catch {
      // best effort
    }
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, 'utf8')).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    await writeFile(pidPath, `${Math.trunc(pid)}\n`, 'utf8');
  } catch {
    // best effort
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export async function verifyDevToolsReachable({
  port,
  host = '127.0.0.1',
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: 'unreachable' };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  if (!options.connectionClosedUnexpectedly) {
    return true;
  }
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: 'never' | 'if_oracle_pid_dead' } = {},
): Promise<void> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      // ignore cleanup errors
    }
  }

  const lockRemovalMode = options.lockRemovalMode ?? 'never';
  if (lockRemovalMode === 'never') {
    return;
  }

  const pid = await readChromePid(userDataDir);
  if (!pid) {
    return;
  }
  if (isProcessAlive(pid)) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return;
  }

  // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
  // without remote debugging), never delete lock files.
  if (await isChromeUsingUserDataDir(userDataDir)) {
    logger?.('Detected running Chrome using this profile; skipping profile lock cleanup');
    return;
  }

  const lockFiles = [
    path.join(userDataDir, 'lockfile'),
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonSocket'),
    path.join(userDataDir, 'SingletonCookie'),
  ];
  for (const lock of lockFiles) {
    await rm(lock, { force: true }).catch(() => undefined);
  }
  logger?.('Cleaned up stale Chrome profile locks');
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  if (process.platform === 'win32') {
    // On Windows, lockfiles are typically held open and removal should fail anyway; avoid expensive process scans.
    return false;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'command='], { maxBuffer: 10 * 1024 * 1024 });
    const lines = String(stdout ?? '').split('\n');
    const needle = userDataDir;
    for (const line of lines) {
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!lower.includes('chrome') && !lower.includes('chromium')) continue;
      if (line.includes(needle) && lower.includes('user-data-dir')) {
        return true;
      }
    }
  } catch {
    // best effort
  }
  return false;
}
