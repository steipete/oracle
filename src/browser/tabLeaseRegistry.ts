import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";
import { delay } from "./utils.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  sessionId?: string;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTabLease {
  id: string;
  release: () => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

interface BrowserTabLeaseRegistryFile {
  version: 1;
  leases: BrowserTabLeaseRecord[];
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export function normalizeMaxConcurrentTabs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  return Math.max(1, Math.trunc(numeric));
}

export async function acquireBrowserTabLease(
  profileDir: string,
  options: {
    maxConcurrentTabs?: number;
    timeoutMs?: number;
    pollMs?: number;
    logger?: BrowserLogger;
    sessionId?: string;
    chromeHost?: string;
    chromePort?: number;
    staleMs?: number;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const leaseId = randomUUID();
  const startedAt = now();
  let warned = false;
  let lastHeartbeatAt = 0;

  for (;;) {
    const acquired = await withRegistryLock(profileDir, async () => {
      const registry = await readRegistry(profileDir);
      const active = pruneStaleLeases(registry.leases, {
        nowMs: now(),
        staleMs,
        isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
      });
      if (active.length >= maxConcurrentTabs) {
        if (active.length !== registry.leases.length) {
          await writeRegistry(profileDir, { version: 1, leases: active });
        }
        return null;
      }
      const timestamp = new Date(now()).toISOString();
      const lease: BrowserTabLeaseRecord = {
        id: leaseId,
        pid,
        sessionId: options.sessionId,
        chromeHost: options.chromeHost,
        chromePort: options.chromePort,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeRegistry(profileDir, { version: 1, leases: [...active, lease] });
      return lease;
    });

    if (acquired) {
      options.logger?.(
        `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
      );
      return {
        id: leaseId,
        release: async () => releaseBrowserTabLease(profileDir, leaseId, options.logger),
        update: async (patch) => updateBrowserTabLease(profileDir, leaseId, patch),
      };
    }

    const elapsed = now() - startedAt;
    if (!warned || now() - lastHeartbeatAt >= 30_000) {
      options.logger?.(
        `[browser] Waiting for ChatGPT browser slot (${maxConcurrentTabs} max, ${Math.round(elapsed / 1000)}s elapsed).`,
      );
      warned = true;
      lastHeartbeatAt = now();
    }
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ChatGPT browser slot after ${Math.round(elapsed / 1000)}s (${maxConcurrentTabs} max).`,
      );
    }
    await delay(timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs);
  }
}

export async function updateBrowserTabLease(
  profileDir: string,
  leaseId: string,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const leases = registry.leases.map((lease) =>
      lease.id === leaseId
        ? { ...lease, ...patch, id: lease.id, updatedAt: new Date().toISOString() }
        : lease,
    );
    await writeRegistry(profileDir, { version: 1, leases });
  });
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
): Promise<void> {
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const leases = registry.leases.filter((lease) => lease.id !== leaseId);
    await writeRegistry(profileDir, { version: 1, leases });
  }).catch(() => undefined);
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

async function withRegistryLock<T>(profileDir: string, callback: () => Promise<T>): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await delay(50);
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readRegistry(profileDir: string): Promise<BrowserTabLeaseRegistryFile> {
  try {
    const raw = await readFile(registryPath(profileDir), "utf8");
    const parsed = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
    if (!Array.isArray(parsed.leases)) {
      return { version: 1, leases: [] };
    }
    return {
      version: 1,
      leases: parsed.leases.filter(isLeaseRecord),
    };
  } catch {
    return { version: 1, leases: [] };
  }
}

async function writeRegistry(
  profileDir: string,
  registry: BrowserTabLeaseRegistryFile,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  await writeFile(registryPath(profileDir), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function registryPath(profileDir: string): string {
  return path.join(profileDir, REGISTRY_FILENAME);
}

function pruneStaleLeases(
  leases: BrowserTabLeaseRecord[],
  options: { nowMs: number; staleMs: number; isProcessAlive: (pid: number) => boolean },
): BrowserTabLeaseRecord[] {
  return leases.filter((lease) => {
    if (!options.isProcessAlive(lease.pid)) {
      return false;
    }
    const updatedAt = Date.parse(lease.updatedAt);
    if (Number.isFinite(updatedAt) && options.nowMs - updatedAt > options.staleMs) {
      return false;
    }
    return true;
  });
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabLeaseRecord;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
