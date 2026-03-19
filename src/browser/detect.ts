import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Launcher } from "chrome-launcher";

export type AttachRunningBrowserFamily = "chrome" | "chromium" | "edge" | "brave";

export interface AttachRunningProfileRoot {
  family: AttachRunningBrowserFamily;
  root: string;
}

export interface DevToolsActivePortInfo {
  port: number;
  browserWSEndpoint: string;
  path: string;
}

export interface DevToolsActivePortCandidate extends DevToolsActivePortInfo {
  profileRoot: string;
  mtimeMs: number;
}

export async function detectChromeBinary(): Promise<{ path: string | null }> {
  const envPath = (process.env.CHROME_PATH ?? "").trim();
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

  const candidates = platformChromeCandidates(process.platform, os.homedir());
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

export async function detectChromeCookieDb({
  profile,
}: {
  profile: string;
}): Promise<string | null> {
  const profileName = profile?.trim() ? profile.trim() : "Default";
  if (process.platform === "win32") {
    return null;
  }

  const roots = resolveAttachRunningProfileRoots();
  for (const root of roots) {
    const dir = path.join(root.root, profileName);
    const direct = path.join(dir, "Cookies");
    if (await isFile(direct)) return direct;
    const network = path.join(dir, "Network", "Cookies");
    if (await isFile(network)) return network;
  }

  return null;
}

export function resolveAttachRunningProfileRoots(
  platform = process.platform,
  homeDir = os.homedir(),
): AttachRunningProfileRoot[] {
  if (platform === "darwin") {
    return [
      {
        family: "chrome",
        root: path.join(homeDir, "Library", "Application Support", "Google", "Chrome"),
      },
      {
        family: "chromium",
        root: path.join(homeDir, "Library", "Application Support", "Chromium"),
      },
      {
        family: "edge",
        root: path.join(homeDir, "Library", "Application Support", "Microsoft Edge"),
      },
      {
        family: "brave",
        root: path.join(
          homeDir,
          "Library",
          "Application Support",
          "BraveSoftware",
          "Brave-Browser",
        ),
      },
    ];
  }
  if (platform === "linux") {
    return [
      { family: "chrome", root: path.join(homeDir, ".config", "google-chrome") },
      { family: "chromium", root: path.join(homeDir, ".config", "chromium") },
      { family: "edge", root: path.join(homeDir, ".config", "microsoft-edge") },
      {
        family: "brave",
        root: path.join(homeDir, ".config", "BraveSoftware", "Brave-Browser"),
      },
      { family: "chromium", root: path.join(homeDir, "snap", "chromium", "common", "chromium") },
      { family: "chromium", root: path.join(homeDir, "snap", "chromium", "current", "chromium") },
    ];
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    return [
      {
        family: "chrome",
        root: path.join(localAppData, "Google", "Chrome", "User Data"),
      },
      {
        family: "chromium",
        root: path.join(localAppData, "Chromium", "User Data"),
      },
      {
        family: "edge",
        root: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      },
      {
        family: "brave",
        root: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      },
    ];
  }
  return [];
}

export function resolveDevToolsActivePortDiscoveryRoots(
  platform = process.platform,
  homeDir = os.homedir(),
): string[] {
  if (platform === "darwin") {
    return [path.join(homeDir, "Library", "Application Support")];
  }
  if (platform === "linux") {
    return [path.join(homeDir, ".config"), path.join(homeDir, "snap")];
  }
  if (platform === "win32") {
    return [process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local")];
  }
  return [];
}

export function inferAttachRunningBrowserFamily(
  chromePath?: string | null,
): AttachRunningBrowserFamily | null {
  const normalized = chromePath?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("microsoft edge") || normalized.includes("msedge")) {
    return "edge";
  }
  if (normalized.includes("brave")) {
    return "brave";
  }
  if (normalized.includes("chromium")) {
    return "chromium";
  }
  if (normalized.includes("chrome")) {
    return "chrome";
  }
  return null;
}

export function parseDevToolsActivePort(
  raw: string,
  options: {
    host?: string;
  } = {},
): { port: number; browserWSEndpoint: string } {
  const host = formatWebSocketHost(options.host ?? "127.0.0.1");
  const [rawPort, rawBrowserPath] = raw.split(/\r?\n/u);
  const port = Number.parseInt(rawPort?.trim() ?? "", 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    throw new Error("DevToolsActivePort did not contain a valid port.");
  }
  const browserPath = rawBrowserPath?.trim() || "/devtools/browser";
  const normalizedPath = browserPath.startsWith("/") ? browserPath : `/${browserPath}`;
  return {
    port,
    browserWSEndpoint: `ws://${host}:${port}${normalizedPath}`,
  };
}

export async function readDevToolsActivePortInfo(
  profileRoot: string,
  options: {
    host?: string;
  } = {},
): Promise<DevToolsActivePortInfo | null> {
  const candidates = [
    path.join(profileRoot, "DevToolsActivePort"),
    path.join(profileRoot, "Default", "DevToolsActivePort"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = parseDevToolsActivePort(raw, options);
      return { ...parsed, path: candidate };
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function discoverDevToolsActivePortCandidates(
  options: {
    host?: string;
    platform?: NodeJS.Platform;
    homeDir?: string;
    maxDepth?: number;
  } = {},
): Promise<DevToolsActivePortCandidate[]> {
  const { host, platform = process.platform, homeDir = os.homedir(), maxDepth = 6 } = options;
  const roots = resolveDevToolsActivePortDiscoveryRoots(platform, homeDir);
  const candidates: DevToolsActivePortCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const root of roots) {
    await walkForDevToolsActivePort(root, maxDepth, async (candidatePath, stat) => {
      if (seenPaths.has(candidatePath)) {
        return;
      }
      seenPaths.add(candidatePath);
      try {
        const raw = await fs.readFile(candidatePath, "utf8");
        const parsed = parseDevToolsActivePort(raw, { host });
        candidates.push({
          ...parsed,
          path: candidatePath,
          profileRoot: deriveDevToolsProfileRoot(candidatePath),
          mtimeMs: Number(stat.mtimeMs),
        });
      } catch {
        // ignore unreadable or malformed DevToolsActivePort files
      }
    });
  }

  return candidates;
}

function platformChromeCandidates(
  platform = process.platform,
  homeDir = os.homedir(),
): { absolutePaths: string[]; binaryNames: string[] } {
  if (platform === "linux") {
    return {
      binaryNames: [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
      ],
      absolutePaths: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome-beta",
        "/usr/bin/google-chrome-unstable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/brave-browser",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/snap/bin/chromium",
        "/snap/bin/brave",
        "/snap/bin/brave-browser",
        "/snap/bin/microsoft-edge",
        "/opt/google/chrome/chrome",
      ],
    };
  }
  if (platform === "darwin") {
    return {
      binaryNames: [],
      absolutePaths: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ],
    };
  }
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    return {
      binaryNames: [],
      absolutePaths: [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
    };
  }
  return { binaryNames: [], absolutePaths: [] };
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
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
  const rawPath = process.env.PATH ?? "";
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

function deriveDevToolsProfileRoot(activePortPath: string): string {
  const parentDir = path.dirname(activePortPath);
  if (path.basename(parentDir).toLowerCase() === "default") {
    return path.dirname(parentDir);
  }
  return parentDir;
}

function formatWebSocketHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

async function walkForDevToolsActivePort(
  root: string,
  maxDepth: number,
  onFile: (candidatePath: string, stat: Stats) => Promise<void>,
): Promise<void> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidatePath = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isFile()) {
        if (entry.name !== "DevToolsActivePort") {
          continue;
        }
        try {
          const stat = await fs.stat(candidatePath);
          await onFile(candidatePath, stat);
        } catch {
          // ignore unreadable candidates
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: candidatePath, depth: current.depth + 1 });
      }
    }
  }
}
