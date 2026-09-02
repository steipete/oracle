import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive, readProcessStartTimeMs } from "./profileState.js";
import { delay } from "./utils.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 2 * 60 * 1000;
const LEASE_HEARTBEAT_INTERVAL_MS = 15_000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_OWNER_FILENAME = "owner.json";
const REGISTRY_RECOVERY_POLL_MS = 50;
const LEGACY_OWNERLESS_LOCK_STALE_MS = 5 * 60 * 1000;
const PROCESS_START_TIME_TOLERANCE_MS = 10_000;
const REGISTRY_RENAME_RETRY_ATTEMPTS = 6;

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  processStartedAtMs?: number;
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
    onRelease?: (context: BrowserTabLeaseReleaseContext) => Promise<void>;
  }) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

export interface BrowserTabLeaseReleaseContext {
  isLastLease: boolean;
  releasedLease: BrowserTabLeaseRecord;
  remainingLeases: readonly BrowserTabLeaseRecord[];
}

interface BrowserTabLeaseRegistryFile {
  version: 1;
  leases: BrowserTabLeaseRecord[];
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  heartbeatMs?: number;
}

interface RegistryLockOwner {
  id: string;
  pid: number;
  createdAt?: string;
  processStartedAtMs?: number;
}

interface RegistryLockIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
}

type RegistryOwnerReadFile = (filePath: string, encoding: "utf8") => Promise<string>;
type RegistryLockRemove = (
  lockDir: string,
  options: { recursive: true; force: true },
) => Promise<void>;

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
  const processStartedAtMs = await (deps.readProcessStartTimeMs ?? readProcessStartTimeMs)(pid);
  const leaseId = randomUUID();
  const startedAt = now();
  let warned = false;
  let lastHeartbeatAt = 0;

  for (;;) {
    const acquired = await withRegistryLock(profileDir, async () => {
      const registry = await readRegistry(profileDir);
      const active = await pruneStaleLeases(registry.leases, {
        nowMs: now(),
        staleMs,
        isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
        readProcessStartTimeMs: deps.readProcessStartTimeMs ?? readProcessStartTimeMs,
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
        ...(processStartedAtMs === null ? {} : { processStartedAtMs }),
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
      let released = false;
      let heartbeatInFlight = false;
      let heartbeatPromise: Promise<void> | null = null;
      let heartbeatWarningEmitted = false;
      const heartbeat = setInterval(
        () => {
          if (released || heartbeatInFlight) return;
          heartbeatInFlight = true;
          const heartbeatWork = updateBrowserTabLease(profileDir, leaseId, {})
            .then(() => {
              heartbeatWarningEmitted = false;
            })
            .catch((error) => {
              if (!heartbeatWarningEmitted) {
                const message = error instanceof Error ? error.message : String(error);
                options.logger?.(
                  `[browser] ChatGPT browser slot heartbeat failed; preserving the slot until stale grace expires: ${message}`,
                );
                heartbeatWarningEmitted = true;
              }
            })
            .finally(() => {
              heartbeatInFlight = false;
              if (heartbeatPromise === heartbeatWork) heartbeatPromise = null;
            });
          heartbeatPromise = heartbeatWork;
        },
        Math.max(10, deps.heartbeatMs ?? LEASE_HEARTBEAT_INTERVAL_MS),
      );
      heartbeat.unref();
      return {
        id: leaseId,
        release: async (releaseOptions) => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await heartbeatPromise?.catch(() => undefined);
          await releaseBrowserTabLease(profileDir, leaseId, options.logger, releaseOptions);
        },
        update: async (patch) => {
          if (released) return;
          await updateBrowserTabLease(profileDir, leaseId, patch);
        },
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
    if (!registry.leases.some((lease) => lease.id === leaseId)) {
      throw new Error(
        `Oracle ChatGPT browser slot ${leaseId.slice(0, 8)} is no longer owned by this controller.`,
      );
    }
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
  options: { onRelease?: (context: BrowserTabLeaseReleaseContext) => Promise<void> } = {},
): Promise<void> {
  await withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    // Release is a safety-critical reference-count decrement. Never prune other
    // controllers here: a transient cross-process liveness false-negative would
    // make this run look like the final lease and allow it to terminate shared
    // Chrome underneath live tabs. Stale records are reclaimed by a later acquire.
    const releasedLease = registry.leases.find((lease) => lease.id === leaseId);
    if (!releasedLease) {
      throw new Error(
        `Oracle ChatGPT browser slot ${leaseId.slice(0, 8)} was already lost; refusing final shared-Chrome cleanup.`,
      );
    }
    const leases = registry.leases.filter((lease) => lease.id !== leaseId);
    await writeRegistry(profileDir, { version: 1, leases });
    logger?.(
      `[browser] ChatGPT browser slot ${leaseId.slice(0, 8)} release decision: ` +
        `isLastLease=${leases.length === 0}; remaining=${leases.length}; ` +
        `remainingSessions=${formatRemainingLeaseSessions(leases)}.`,
    );
    await options.onRelease?.({
      isLastLease: leases.length === 0,
      releasedLease,
      remainingLeases: leases,
    });
  });
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

function formatRemainingLeaseSessions(leases: readonly BrowserTabLeaseRecord[]): string {
  if (leases.length === 0) return "none";
  return leases
    .map(
      (lease) =>
        `${lease.id.slice(0, 8)}:${lease.sessionId ?? "unknown"}:pid${lease.pid}:target${lease.chromeTargetId ?? "pending"}`,
    )
    .join(",");
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  leaseId: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  return withRegistryLock(profileDir, async () => {
    const registry = await readRegistry(profileDir);
    const active = await pruneStaleLeases(registry.leases, {
      nowMs: now(),
      staleMs,
      isProcessAlive: options.isProcessAlive ?? isProcessAlive,
      readProcessStartTimeMs: options.readProcessStartTimeMs ?? readProcessStartTimeMs,
    });
    if (active.length !== registry.leases.length) {
      await writeRegistry(profileDir, { version: 1, leases: active });
    }
    return active.some((lease) => lease.id !== leaseId);
  });
}

async function withRegistryLock<T>(profileDir: string, callback: () => Promise<T>): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const lockId = randomUUID();
  const candidateDir = `${lockDir}.${lockId}`;
  const processStartedAtMs = await readProcessStartTimeMs(process.pid);
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(candidateDir, { recursive: false });
      await writeFile(
        path.join(candidateDir, REGISTRY_LOCK_OWNER_FILENAME),
        `${JSON.stringify({
          id: lockId,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          ...(processStartedAtMs === null ? {} : { processStartedAtMs }),
        })}\n`,
        "utf8",
      );
      await rename(candidateDir, lockDir);
      break;
    } catch (error) {
      await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }
      const owner = await readRegistryLockOwner(lockDir);
      if (owner && !(await isRegistryLockOwnerAlive(owner))) {
        await recoverDeadRegistryLock(profileDir, lockDir, owner);
        continue;
      }
      if (!owner) {
        const identity = await readRegistryLockIdentity(lockDir);
        if (identity && Date.now() - identity.mtimeMs >= LEGACY_OWNERLESS_LOCK_STALE_MS) {
          await recoverOwnerlessRegistryLock(profileDir, lockDir, identity);
          continue;
        }
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for Oracle tab lease registry lock ${lockDir}; preserving the existing lock to avoid split-brain cleanup.`,
        );
      }
      await delay(50);
    }
  }
  try {
    return await callback();
  } finally {
    await removeRegistryLockIfOwned(lockDir, lockId, { requireOwned: true });
  }
}

async function readRegistryLockOwner(
  lockDir: string,
  readFileImpl: RegistryOwnerReadFile = readFile,
): Promise<RegistryLockOwner | null> {
  try {
    const raw = await readFileImpl(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as {
      id?: unknown;
      pid?: unknown;
      createdAt?: unknown;
      processStartedAtMs?: unknown;
    };
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isFinite(parsed.pid) ||
      parsed.pid <= 0 ||
      (parsed.processStartedAtMs !== undefined &&
        (typeof parsed.processStartedAtMs !== "number" ||
          !Number.isFinite(parsed.processStartedAtMs)))
    ) {
      return null;
    }
    return {
      id: parsed.id,
      pid: parsed.pid,
      ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.processStartedAtMs === "number"
        ? { processStartedAtMs: parsed.processStartedAtMs }
        : {}),
    };
  } catch {
    return null;
  }
}

async function isRegistryLockOwnerAlive(owner: RegistryLockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return false;
  const actualStartedAtMs = await readProcessStartTimeMs(owner.pid);
  // Process introspection can be denied; fail closed if identity cannot be verified.
  if (actualStartedAtMs === null) return true;
  if (owner.processStartedAtMs === undefined) {
    // Legacy owners only recorded lock creation time. A live process that started
    // after the lock was created proves that the pid has since been reused.
    const lockCreatedAtMs = owner.createdAt ? Date.parse(owner.createdAt) : Number.NaN;
    return (
      !Number.isFinite(lockCreatedAtMs) ||
      actualStartedAtMs <= lockCreatedAtMs + PROCESS_START_TIME_TOLERANCE_MS
    );
  }
  return Math.abs(actualStartedAtMs - owner.processStartedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS;
}

async function readRegistryLockIdentity(lockDir: string): Promise<RegistryLockIdentity | null> {
  try {
    const value = await stat(lockDir);
    return {
      dev: value.dev,
      ino: value.ino,
      birthtimeMs: value.birthtimeMs,
      mtimeMs: value.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameRegistryLockIdentity(
  left: RegistryLockIdentity | null,
  right: RegistryLockIdentity,
): boolean {
  return (
    left !== null &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

async function removeRegistryLockIfOwned(
  lockDir: string,
  lockId: string,
  options: {
    requireOwned?: boolean;
    readFileImpl?: RegistryOwnerReadFile;
    removeImpl?: RegistryLockRemove;
  } = {},
): Promise<boolean> {
  const owner = await readRegistryLockOwnerWithRetry(lockDir, options.readFileImpl);
  const lockIdentity = owner ? null : await readRegistryLockIdentity(lockDir);
  if (!owner) {
    if (lockIdentity && options.requireOwned) {
      throw new Error(
        `Unable to verify ownership while releasing Oracle tab lease registry lock ${lockDir}.`,
      );
    }
    return false;
  }
  if (owner?.id !== lockId) {
    if (options.requireOwned) {
      throw new Error(
        `Oracle tab lease registry lock ${lockDir} changed owners before release; preserving it.`,
      );
    }
    return false;
  }
  await removeRegistryLockDirectoryWithRetry(lockDir, options.removeImpl);
  return true;
}

async function readRegistryLockOwnerWithRetry(
  lockDir: string,
  readFileImpl: RegistryOwnerReadFile = readFile,
): Promise<RegistryLockOwner | null> {
  for (let attempt = 0; ; attempt += 1) {
    const owner = await readRegistryLockOwner(lockDir, readFileImpl);
    if (owner) return owner;
    const identity = await readRegistryLockIdentity(lockDir);
    if (!identity || attempt + 1 >= REGISTRY_RENAME_RETRY_ATTEMPTS) return null;
    await delay(25 * (attempt + 1));
  }
}

async function removeRegistryLockDirectoryWithRetry(
  lockDir: string,
  removeImpl: RegistryLockRemove = rm,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeImpl(lockDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt + 1 >= REGISTRY_RENAME_RETRY_ATTEMPTS) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

export async function removeRegistryLockIfOwnedForTest(
  lockDir: string,
  lockId: string,
  options: { readFileImpl?: RegistryOwnerReadFile; removeImpl?: RegistryLockRemove } = {},
): Promise<boolean> {
  return removeRegistryLockIfOwned(lockDir, lockId, { ...options, requireOwned: true });
}

async function recoverDeadRegistryLock(
  profileDir: string,
  lockDir: string,
  observedOwner: RegistryLockOwner,
): Promise<void> {
  await withRegistryRecoveryLock(profileDir, async () => {
    // Re-read after acquiring the crash-safe recovery mutex. Another process may
    // already have reaped the dead lock and installed a live owner.
    const currentOwner = await readRegistryLockOwner(lockDir);
    if (
      currentOwner?.id !== observedOwner.id ||
      currentOwner.pid !== observedOwner.pid ||
      currentOwner.createdAt !== observedOwner.createdAt ||
      currentOwner.processStartedAtMs !== observedOwner.processStartedAtMs ||
      (await isRegistryLockOwnerAlive(currentOwner))
    ) {
      return;
    }
    await removeRegistryLockIfOwned(lockDir, currentOwner.id);
  });
}

async function recoverOwnerlessRegistryLock(
  profileDir: string,
  lockDir: string,
  observedIdentity: RegistryLockIdentity,
): Promise<void> {
  await withRegistryRecoveryLock(profileDir, async () => {
    if (await readRegistryLockOwner(lockDir)) return;
    const currentIdentity = await readRegistryLockIdentity(lockDir);
    if (
      !sameRegistryLockIdentity(currentIdentity, observedIdentity) ||
      Date.now() - observedIdentity.mtimeMs < LEGACY_OWNERLESS_LOCK_STALE_MS
    ) {
      return;
    }
    await rm(lockDir, { recursive: true, force: true });
  });
}

async function withRegistryRecoveryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
): Promise<T> {
  const identity = await canonicalProfileIdentity(profileDir);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const windowsEndpoint = `\\\\.\\pipe\\oracle-tab-lease-recovery-${digest}`;
  const posixPort = 20_000 + (Number.parseInt(digest.slice(0, 8), 16) % 40_000);
  const endpoint = process.platform === "win32" ? windowsEndpoint : `127.0.0.1:${posixPort}`;
  const startedAt = Date.now();
  let server: net.Server | null = null;

  for (;;) {
    const candidate = net.createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("error", reject);
        const listenOptions =
          process.platform === "win32"
            ? windowsEndpoint
            : { host: "127.0.0.1", port: posixPort, exclusive: true };
        candidate.listen(listenOptions, () => {
          candidate.removeListener("error", reject);
          resolve();
        });
      });
      server = candidate;
      break;
    } catch (error) {
      candidate.close();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Oracle tab lease recovery mutex ${endpoint}.`);
      }
      await delay(REGISTRY_RECOVERY_POLL_MS);
    }
  }

  try {
    return await callback();
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  }
}

async function canonicalProfileIdentity(profileDir: string): Promise<string> {
  let resolved = path.resolve(profileDir);
  try {
    resolved = await realpath(resolved);
  } catch {
    // The profile normally exists before lease acquisition. Keep an absolute,
    // normalized fallback so an introspection failure remains fail-closed.
  }
  resolved = path.normalize(resolved);
  if (process.platform === "win32") {
    if (/^\\\\\?\\UNC\\/iu.test(resolved)) {
      resolved = `\\\\${resolved.slice(8)}`;
    } else {
      resolved = resolved.replace(/^\\\\\?\\/u, "");
    }
    resolved = resolved.toLowerCase();
  }
  const root = path.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/u.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export async function canonicalProfileIdentityForTest(profileDir: string): Promise<string> {
  return canonicalProfileIdentity(profileDir);
}

async function readRegistry(profileDir: string): Promise<BrowserTabLeaseRegistryFile> {
  try {
    const raw = await readFile(registryPath(profileDir), "utf8");
    const parsed = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
    if (!Array.isArray(parsed.leases)) {
      throw new Error("Oracle tab lease registry is missing its leases array.");
    }
    if (!parsed.leases.every(isLeaseRecord)) {
      throw new Error("Oracle tab lease registry contains an invalid lease record.");
    }
    return {
      version: 1,
      leases: parsed.leases,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, leases: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Oracle tab lease registry: ${message}`, { cause: error });
  }
}

async function writeRegistry(
  profileDir: string,
  registry: BrowserTabLeaseRegistryFile,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const destination = registryPath(profileDir);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  try {
    await renameRegistryFileWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renameRegistryFileWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt + 1 >= REGISTRY_RENAME_RETRY_ATTEMPTS) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

function registryPath(profileDir: string): string {
  return path.join(profileDir, REGISTRY_FILENAME);
}

async function pruneStaleLeases(
  leases: BrowserTabLeaseRecord[],
  options: {
    nowMs: number;
    staleMs: number;
    isProcessAlive: (pid: number) => boolean;
    readProcessStartTimeMs: (pid: number) => Promise<number | null>;
  },
): Promise<BrowserTabLeaseRecord[]> {
  const active: BrowserTabLeaseRecord[] = [];
  for (const lease of leases) {
    const updatedAt = Date.parse(lease.updatedAt);
    // One cross-process liveness probe is not trustworthy enough to delete a
    // fresh foreign lease. Active controllers refresh updatedAt every 15s; only
    // a missed heartbeat beyond the grace period permits identity verification.
    // Invalid timestamps fail closed.
    if (!Number.isFinite(updatedAt) || options.nowMs - updatedAt <= options.staleMs) {
      active.push(lease);
      continue;
    }
    if (!options.isProcessAlive(lease.pid)) continue;

    // A live PID is insufficient because Windows can reuse it after the owner
    // exits. Preserve the lease only when the live process is the same process
    // that acquired it. Introspection failure remains fail closed.
    const actualStartedAtMs = await options.readProcessStartTimeMs(lease.pid);
    if (actualStartedAtMs === null) {
      active.push(lease);
      continue;
    }
    if (lease.processStartedAtMs !== undefined) {
      if (
        Math.abs(actualStartedAtMs - lease.processStartedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS
      ) {
        active.push(lease);
      }
      continue;
    }

    // Legacy records predate processStartedAtMs. A process that started after
    // lease creation proves PID reuse; otherwise preserve the ambiguous record.
    const createdAt = Date.parse(lease.createdAt);
    if (
      !Number.isFinite(createdAt) ||
      actualStartedAtMs <= createdAt + PROCESS_START_TIME_TOLERANCE_MS
    ) {
      active.push(lease);
    }
  }
  return active;
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabLeaseRecord;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    (record.processStartedAtMs === undefined ||
      (typeof record.processStartedAtMs === "number" &&
        Number.isFinite(record.processStartedAtMs))) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
