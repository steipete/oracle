import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Launcher } from 'chrome-launcher';

export async function detectChromeBinary(): Promise<{ path: string | null }> {
  const envPath = (process.env.CHROME_PATH ?? '').trim();
  if (envPath) {
    const ok = await isExecutable(envPath);
    if (ok) {
      return { path: envPath };
    }
  }

  const launcherDetected = Launcher.getFirstInstallation();
  if (launcherDetected) {
    return { path: launcherDetected };
  }

  const candidates = platformChromeCandidates();
  for (const candidate of candidates.absolutePaths) {
    if (await isExecutable(candidate)) {
      return { path: candidate };
    }
  }

  const fromPath = await findOnPath(candidates.binaryNames);
  if (fromPath) {
    return { path: fromPath };
  }

  return { path: null };
}

export async function detectChromeCookieDb({ profile }: { profile: string }): Promise<string | null> {
  const profileName = profile?.trim() ? profile.trim() : 'Default';
  if (process.platform === 'win32') {
    return null;
  }

  const roots = platformProfileRoots();
  for (const root of roots) {
    const dir = path.join(root, profileName);
    const direct = path.join(dir, 'Cookies');
    if (await isFile(direct)) return direct;
    const network = path.join(dir, 'Network', 'Cookies');
    if (await isFile(network)) return network;
  }

  return null;
}

function platformChromeCandidates(): { absolutePaths: string[]; binaryNames: string[] } {
  if (process.platform === 'linux') {
    return {
      binaryNames: [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        'brave-browser',
        'microsoft-edge',
        'microsoft-edge-stable',
      ],
      absolutePaths: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome-beta',
        '/usr/bin/google-chrome-unstable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/brave-browser',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/snap/bin/chromium',
        '/snap/bin/brave',
        '/snap/bin/brave-browser',
        '/snap/bin/microsoft-edge',
        '/opt/google/chrome/chrome',
      ],
    };
  }
  if (process.platform === 'darwin') {
    return {
      binaryNames: [],
      absolutePaths: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ],
    };
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return {
      binaryNames: [],
      absolutePaths: [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ],
    };
  }
  return { binaryNames: [], absolutePaths: [] };
}

function platformProfileRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
      path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'google-chrome-beta'),
      path.join(home, '.config', 'google-chrome-unstable'),
      path.join(home, '.config', 'chromium'),
      path.join(home, '.config', 'microsoft-edge'),
      path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
      // Snap Chromium profiles
      path.join(home, 'snap', 'chromium', 'common', 'chromium'),
      path.join(home, 'snap', 'chromium', 'current', 'chromium'),
    ];
  }
  return [];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    // eslint-disable-next-line no-bitwise
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findOnPath(names: string[]): Promise<string | null> {
  const rawPath = process.env.PATH ?? '';
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}
