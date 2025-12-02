import { mkdir, rm, cp as copyDir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { BrowserLogger } from './types.js';
import { defaultProfileRoot, expandPath, looksLikePath } from './chromeCookies.js';

export interface ProfileSyncOptions {
  /** Profile name or absolute path to a profile directory. */
  profile?: string | null;
  /** Optional override pointing at a Cookies DB or profile directory. */
  explicitPath?: string | null;
  /** Where to copy the profile to (Chrome userDataDir). */
  targetDir: string;
  logger?: BrowserLogger;
}

export interface ProfileSyncResult {
  source: string;
  profileName: string;
  method: 'rsync' | 'robocopy' | 'node';
  status: 'copied' | 'skipped';
}

const DIR_EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'Service Worker',
  'Crashpad',
  'BrowserMetrics*',
  'GrShaderCache',
  'ShaderCache',
  'OptimizationGuide',
];

const FILE_EXCLUDES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  '*.lock',
  'lockfile',
  'Lock',
  '*.tmp',
  'DevToolsActivePort',
  path.join('Default', 'DevToolsActivePort'),
  path.join('Sessions', '*'),
  'Current Session',
  'Current Tabs',
  'Last Session',
  'Last Tabs',
];

export async function syncChromeProfile(options: ProfileSyncOptions): Promise<ProfileSyncResult> {
  const { targetDir } = options;
  await mkdir(targetDir, { recursive: true });
  const { sourceDir, profileName } = await resolveProfileSource(options.profile, options.explicitPath);
  const logger = options.logger;

  if (!existsSync(sourceDir)) {
    throw new Error(`Chrome profile not found at ${sourceDir}. Log in once in Chrome, then retry.`);
  }

  // Clean any stale DevTools ports/locks in the target before copying.
  await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(targetDir, { recursive: true });

  const result =
    process.platform === 'win32'
      ? await copyWithRobocopy(sourceDir, targetDir, logger)
      : await copyWithRsync(sourceDir, targetDir, logger);

  // Remove lock files in the copied profile to avoid "already running" errors.
  await removeLocks(targetDir);

  return {
    source: sourceDir,
    profileName,
    method: result.method,
    status: result.copied ? 'copied' : 'skipped',
  };
}

async function copyWithRsync(
  sourceDir: string,
  targetDir: string,
  logger?: BrowserLogger,
): Promise<{ copied: boolean; method: 'rsync' | 'node' }> {
  const rsyncArgs = [
    '-a',
    '--delete',
    ...DIR_EXCLUDES.flatMap((entry) => ['--exclude', entry]),
    ...FILE_EXCLUDES.flatMap((entry) => ['--exclude', entry]),
    `${sourceDir}/`,
    `${targetDir}/`,
  ];
  const attempt = spawnSync('rsync', rsyncArgs, { stdio: 'pipe' });
  if (!attempt.error && (attempt.status ?? 0) === 0) {
    return { copied: true, method: 'rsync' };
  }
  logger?.('rsync unavailable or failed; falling back to Node copy');
  await copyDirWithFilter(sourceDir, targetDir);
  return copyWithNodeFs();
}

async function copyWithRobocopy(
  sourceDir: string,
  targetDir: string,
  logger?: BrowserLogger,
): Promise<{ copied: boolean; method: 'robocopy' | 'node' }> {
  const args = [sourceDir, targetDir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/Z'];
  if (DIR_EXCLUDES.length) {
    args.push('/XD', ...DIR_EXCLUDES);
  }
  if (FILE_EXCLUDES.length) {
    args.push('/XF', ...FILE_EXCLUDES);
  }
  const attempt = spawnSync('robocopy', args, { stdio: 'pipe' });
  const exitCode = attempt.status ?? 0;
  // Robocopy treats 0-7 as success/partial success; >=8 is failure.
  if (!attempt.error && exitCode < 8) {
    return { copied: true, method: 'robocopy' };
  }
  logger?.('robocopy failed; falling back to Node copy');
  await copyDirWithFilter(sourceDir, targetDir);
  return copyWithNodeFs();
}

function copyWithNodeFs(): { copied: boolean; method: 'node' } {
  return { copied: true, method: 'node' };
}

function shouldExclude(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return DIR_EXCLUDES.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`)) ||
    FILE_EXCLUDES.some((entry) => {
      if (entry.endsWith('*')) {
        return normalized.startsWith(entry.slice(0, -1));
      }
      if (entry.includes('*')) {
        // simple glob support for BrowserMetrics*
        const prefix = entry.replace('*', '');
        return normalized.startsWith(prefix);
      }
      return path.basename(normalized) === entry || normalized.endsWith(`/${entry}`);
    });
}

async function removeLocks(targetDir: string): Promise<void> {
  const lockNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'];
  for (const lock of lockNames) {
    await rm(path.join(targetDir, lock), { force: true }).catch(() => undefined);
    await rm(path.join(targetDir, 'Default', lock), { force: true }).catch(() => undefined);
  }
}

async function resolveProfileSource(
  profile: string | null | undefined,
  explicitPath: string | null | undefined,
): Promise<{ sourceDir: string; profileName: string }> {
  const profileName = profile?.trim() ? profile.trim() : 'Default';

  if (explicitPath?.trim()) {
    const resolved = expandPath(explicitPath.trim());
    if (resolved.toLowerCase().endsWith('cookies')) {
      return { sourceDir: path.dirname(resolved), profileName };
    }
    return { sourceDir: resolved, profileName };
  }

  if (looksLikePath(profileName)) {
    return { sourceDir: expandPath(profileName), profileName };
  }

  const baseRoot = await defaultProfileRoot();
  return { sourceDir: path.join(baseRoot, profileName), profileName };
}

async function copyDirWithFilter(sourceDir: string, targetDir: string): Promise<void> {
  await copyDir(sourceDir, targetDir, {
    recursive: true,
    filter: async (source) => {
      const rel = path.relative(sourceDir, source);
      if (!rel) return true;
      return !shouldExclude(rel);
    },
  });
}
