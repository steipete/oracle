import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";
import { delay } from "./utils.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
// Generous because the lock is legitimately held across tab close and Chrome
// termination on the last-lease path. The old 10s budget was short enough that a
// normal teardown could push a waiter over it — and the waiter's response was to
// break the lock.
const REGISTRY_LOCK_TIMEOUT_MS = 45_000;

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
  release: (options?: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
  }) => Promise<void>;
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
        release: async (releaseOptions) =>
          releaseBrowserTabLease(profileDir, leaseId, options.logger, releaseOptions),
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
  options: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> } = {},
): Promise<void> {
  // The release callback runs while the lock is still held, and deliberately so:
  // it closes tabs and can terminate the shared Chrome, and a peer that acquired
  // a slot midway through would have its browser killed underneath it. The cost
  // is that the lock is held for seconds, which is why the lock waits rather than
  // breaking, and why the wait budget is generous.
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const active = pruneStaleLeases(registry.leases, {
      nowMs: Date.now(),
      staleMs: DEFAULT_STALE_MS,
      isProcessAlive,
    });
    const leases = active.filter((lease) => lease.id !== leaseId);
    await writeRegistry(profileDir, { version: 1, leases });
    await options.onRelease?.({ isLastLease: leases.length === 0 });
  }).catch((error) => {
    // Previously swallowed. If the registry could not be read or written, this
    // run never learned whether it was the last one out — and the teardown that
    // decision gates is browser-wide. Saying so is the difference between a
    // skipped cleanup and an unexplained dead Chrome in somebody else's run.
    logger?.(
      `[browser] Could not update the ChatGPT slot registry while releasing ${leaseId.slice(0, 8)}; skipping shared-profile teardown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  leaseId: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  return withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const active = pruneStaleLeases(registry.leases, {
      nowMs: now(),
      staleMs,
      isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    });
    if (active.length !== registry.leases.length) {
      await writeRegistry(profileDir, { version: 1, leases: active });
    }
    return active.some((lease) => lease.id !== leaseId);
  });
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
        // Deliberately not self-breaking. Stealing the lock here means the
        // original holder's `finally` then removes the *new* holder's lock, and
        // two writers proceed against the same file — which is how a live peer's
        // lease disappears. Waiting longer is recoverable; a lost lease is not.
        // A truly abandoned lock is cleared by the stale-PID prune on the next
        // successful pass, not by a timer.
        throw new Error(
          `timed out after ${REGISTRY_LOCK_TIMEOUT_MS}ms waiting for the ChatGPT slot registry lock at ${lockDir}`,
        );
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

/**
 * A missing registry means "nobody has taken a slot yet" and is normal. An
 * unreadable one means "the answer is unknown", which is not the same thing and
 * must not be rendered as an empty lease list: callers treat emptiness as
 * permission to close tabs and kill the shared Chrome.
 */
class UnreadableTabLeaseRegistryError extends Error {
  constructor(cause: unknown) {
    super(
      `tab-lease registry is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "UnreadableTabLeaseRegistryError";
  }
}

async function readRegistry(profileDir: string): Promise<BrowserTabLeaseRegistryFile> {
  let raw: string;
  try {
    raw = await readFile(registryPath(profileDir), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, leases: [] };
    }
    throw new UnreadableTabLeaseRegistryError(error);
  }
  try {
    const parsed = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
    if (!Array.isArray(parsed.leases)) {
      throw new Error("registry has no leases array");
    }
    return {
      version: 1,
      leases: parsed.leases.filter(isLeaseRecord),
    };
  } catch (error) {
    throw new UnreadableTabLeaseRegistryError(error);
  }
}

async function writeRegistry(
  profileDir: string,
  registry: BrowserTabLeaseRegistryFile,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  // Written through a temp file and renamed, because a torn read of this file
  // does not fail loudly — readRegistry treats unparseable content as "no
  // leases", and callers read "no leases" as "this profile is idle" before
  // closing tabs and terminating the shared Chrome. A partial write is therefore
  // indistinguishable from permission to tear down somebody else's run.
  const target = registryPath(profileDir);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
