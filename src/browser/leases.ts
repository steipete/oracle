import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { getOracleHomeDir } from "../oracleHome.js";
import {
  assertBrowserLeaseProvider,
  assertProfileIdHash,
  browserLeaseRecoveryCommand,
  buildStoredBrowserLease,
  parseStoredBrowserLease,
  type BrowserLeaseProvider,
  type BrowserLeaseReadState,
  type StoredBrowserLeaseRecord,
} from "../oracle/v18/browser_lease.js";

export const BROWSER_LEASES_DIRNAME = "browser-leases";
export const DEFAULT_BROWSER_LEASE_TTL_SECONDS = 15 * 60;
const DEFAULT_BROWSER_LEASE_MUTATION_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_BROWSER_LEASE_MUTATION_LOCK_STALE_MS = 30_000;
const DEFAULT_BROWSER_LEASE_MUTATION_LOCK_POLL_MS = 10;

export interface BrowserLeaseStoreOptions {
  leaseDir?: string;
  now?: () => Date;
  pid?: number;
  uuid?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  mutationLockTimeoutMs?: number;
  mutationLockStaleMs?: number;
  mutationLockPollMs?: number;
}

export interface CreateBrowserLeaseInput {
  provider: BrowserLeaseProvider;
  profileIdHash: string;
  ttlSeconds?: number;
  holder?: string;
  commandSummary?: string;
  localPid?: number;
  remoteSessionId?: string;
  remoteBrowser?: Record<string, unknown>;
  profileScope?: string;
  sharedProfilePolicy?: string;
}

export interface RenewBrowserLeaseInput {
  provider: BrowserLeaseProvider;
  profileIdHash: string;
  leaseId: string;
  ttlSeconds?: number;
}

export interface BrowserLeaseMutationInput {
  provider: BrowserLeaseProvider;
  profileIdHash?: string;
  leaseId?: string;
}

export type BrowserLeaseReadResult =
  | {
      state: "missing";
      provider: BrowserLeaseProvider;
      path: string;
      recoveryCommand: string;
    }
  | {
      state: "corrupt";
      provider: BrowserLeaseProvider;
      path: string;
      recoveryCommand: string;
      raw: string;
      error: string;
    }
  | {
      state: Exclude<BrowserLeaseReadState, "missing" | "corrupt">;
      provider: BrowserLeaseProvider;
      path: string;
      recoveryCommand: string;
      record: StoredBrowserLeaseRecord;
      profileMatches: boolean;
    };

export class BrowserLeaseStateError extends Error {
  readonly result: BrowserLeaseReadResult;

  constructor(message: string, result: BrowserLeaseReadResult) {
    super(message);
    this.name = "BrowserLeaseStateError";
    this.result = result;
  }
}

export function browserLeaseDir(options: BrowserLeaseStoreOptions = {}): string {
  return path.resolve(options.leaseDir ?? path.join(getOracleHomeDir(), BROWSER_LEASES_DIRNAME));
}

export function browserLeasePath(
  provider: BrowserLeaseProvider,
  options: BrowserLeaseStoreOptions = {},
): string {
  return path.join(browserLeaseDir(options), `${assertBrowserLeaseProvider(provider)}.json`);
}

export async function createBrowserLease(
  input: CreateBrowserLeaseInput,
  options: BrowserLeaseStoreOptions = {},
): Promise<StoredBrowserLeaseRecord> {
  const provider = assertBrowserLeaseProvider(input.provider);
  const profileIdHash = assertProfileIdHash(input.profileIdHash);
  return withBrowserLeaseMutationLock(provider, options, async () => {
    const existing = await readBrowserLease(provider, {
      ...options,
      expectedProfileIdHash: profileIdHash,
    });
    if (existing.state !== "missing" && existing.state !== "released") {
      throw new BrowserLeaseStateError(
        `Browser lease ${provider} is ${existing.state}; run ${existing.recoveryCommand} before acquiring a new lease.`,
        existing,
      );
    }

    const now = currentDate(options);
    const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds);
    const leaseId = options.uuid?.() ?? randomUUID();
    const localPid =
      input.remoteSessionId && input.localPid === undefined
        ? undefined
        : (input.localPid ?? options.pid ?? process.pid);
    const record = buildStoredBrowserLease({
      leaseId,
      provider,
      profileIdHash,
      issuedAt: now.toISOString(),
      expiresAt: addSeconds(now, ttlSeconds).toISOString(),
      ttlSeconds,
      holder: input.holder ?? defaultHolder(),
      commandSummary: input.commandSummary ?? defaultCommandSummary(),
      localPid,
      remoteSessionId: input.remoteSessionId,
      remoteBrowser: input.remoteBrowser,
      profileScope: input.profileScope,
      sharedProfilePolicy: input.sharedProfilePolicy,
    });
    await writeLeaseRecord(provider, record, options);
    return record;
  });
}

export async function readBrowserLease(
  providerInput: BrowserLeaseProvider,
  options: BrowserLeaseStoreOptions & { expectedProfileIdHash?: string } = {},
): Promise<BrowserLeaseReadResult> {
  const provider = assertBrowserLeaseProvider(providerInput);
  const lockPath = browserLeasePath(provider, options);
  const recoveryCommand = browserLeaseRecoveryCommand(provider);
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return { state: "missing", provider, path: lockPath, recoveryCommand };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      state: "corrupt",
      provider,
      path: lockPath,
      recoveryCommand,
      raw,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const record = parseStoredBrowserLease(parsed);
  if (!record) {
    return {
      state: "corrupt",
      provider,
      path: lockPath,
      recoveryCommand,
      raw,
      error: "Lease file does not match browser_lease.v1 storage shape.",
    };
  }

  const expectedProfileIdHash = options.expectedProfileIdHash
    ? assertProfileIdHash(options.expectedProfileIdHash)
    : undefined;
  const profileMatches = !expectedProfileIdHash || record.profile_id_hash === expectedProfileIdHash;
  const state = profileMatches ? classifyLeaseRecord(record, options) : "profile_mismatch";
  return {
    state,
    provider,
    path: lockPath,
    recoveryCommand: record.safe_recovery_command || recoveryCommand,
    record,
    profileMatches,
  };
}

export async function renewBrowserLease(
  input: RenewBrowserLeaseInput,
  options: BrowserLeaseStoreOptions = {},
): Promise<StoredBrowserLeaseRecord> {
  const provider = assertBrowserLeaseProvider(input.provider);
  const profileIdHash = assertProfileIdHash(input.profileIdHash);
  return withBrowserLeaseMutationLock(provider, options, async () => {
    const result = await readBrowserLease(provider, {
      ...options,
      expectedProfileIdHash: profileIdHash,
    });
    assertMutableLease(result, input.leaseId, "renew");
    const now = currentDate(options);
    const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds ?? result.record.ttl_seconds);
    const next: StoredBrowserLeaseRecord = {
      ...result.record,
      status: "acquired",
      ttl_seconds: ttlSeconds,
      expires_at: addSeconds(now, ttlSeconds).toISOString(),
      updated_at: now.toISOString(),
      renewable: true,
    };
    await writeLeaseRecord(provider, next, options);
    return next;
  });
}

export async function expireBrowserLease(
  input: BrowserLeaseMutationInput,
  options: BrowserLeaseStoreOptions = {},
): Promise<StoredBrowserLeaseRecord> {
  return markBrowserLease(input, "expired", options);
}

export async function releaseBrowserLease(
  input: BrowserLeaseMutationInput,
  options: BrowserLeaseStoreOptions = {},
): Promise<StoredBrowserLeaseRecord> {
  return markBrowserLease(input, "released", options);
}

async function markBrowserLease(
  input: BrowserLeaseMutationInput,
  status: "expired" | "released",
  options: BrowserLeaseStoreOptions,
): Promise<StoredBrowserLeaseRecord> {
  const provider = assertBrowserLeaseProvider(input.provider);
  const expectedProfileIdHash = input.profileIdHash
    ? assertProfileIdHash(input.profileIdHash)
    : undefined;
  return withBrowserLeaseMutationLock(provider, options, async () => {
    const result = await readBrowserLease(provider, {
      ...options,
      expectedProfileIdHash,
    });
    assertReadableRecord(result, input.leaseId, status);
    const now = currentDate(options).toISOString();
    const next: StoredBrowserLeaseRecord = {
      ...result.record,
      status,
      ttl_seconds: status === "expired" ? 0 : result.record.ttl_seconds,
      expires_at: status === "expired" ? now : result.record.expires_at,
      released_at: status === "released" ? now : result.record.released_at,
      renewable: false,
      updated_at: now,
    };
    await writeLeaseRecord(provider, next, options);
    return next;
  });
}

function classifyLeaseRecord(
  record: StoredBrowserLeaseRecord,
  options: BrowserLeaseStoreOptions,
): Exclude<BrowserLeaseReadState, "missing" | "corrupt" | "profile_mismatch"> {
  if (record.status === "released") {
    return "released";
  }
  if (record.status === "expired") {
    return "expired";
  }
  const expiresAt = Date.parse(record.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= currentDate(options).getTime()) {
    return "expired";
  }
  if (
    typeof record.local_pid === "number" &&
    options.isProcessAlive &&
    !options.isProcessAlive(record.local_pid)
  ) {
    return "stale";
  }
  return "active";
}

function assertMutableLease(
  result: BrowserLeaseReadResult,
  leaseId: string,
  action: string,
): asserts result is BrowserLeaseReadResult & {
  state: "active";
  record: StoredBrowserLeaseRecord;
} {
  if (result.state !== "active") {
    throw new BrowserLeaseStateError(
      `Cannot ${action} browser lease while it is ${result.state}; run ${result.recoveryCommand}.`,
      result,
    );
  }
  if (result.record.lease_id !== leaseId) {
    throw new BrowserLeaseStateError(
      `Cannot ${action} browser lease ${leaseId}; active lease is ${result.record.lease_id}.`,
      result,
    );
  }
}

function assertReadableRecord(
  result: BrowserLeaseReadResult,
  leaseId: string | undefined,
  action: string,
): asserts result is BrowserLeaseReadResult & {
  record: StoredBrowserLeaseRecord;
} {
  if (result.state === "missing" || result.state === "corrupt") {
    throw new BrowserLeaseStateError(
      `Cannot mark browser lease ${action} while it is ${result.state}; run ${result.recoveryCommand}.`,
      result,
    );
  }
  if (leaseId && result.record.lease_id !== leaseId) {
    throw new BrowserLeaseStateError(
      `Cannot mark browser lease ${action}; expected lease ${leaseId} but found ${result.record.lease_id}.`,
      result,
    );
  }
}

async function writeLeaseRecord(
  provider: BrowserLeaseProvider,
  record: StoredBrowserLeaseRecord,
  options: BrowserLeaseStoreOptions,
): Promise<void> {
  const dir = browserLeaseDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const targetPath = browserLeasePath(provider, options);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify(sortJson(record), null, 2)}\n`;
  await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, targetPath);
}

async function withBrowserLeaseMutationLock<T>(
  provider: BrowserLeaseProvider,
  options: BrowserLeaseStoreOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireBrowserLeaseMutationLock(provider, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function acquireBrowserLeaseMutationLock(
  provider: BrowserLeaseProvider,
  options: BrowserLeaseStoreOptions,
): Promise<() => Promise<void>> {
  const dir = browserLeaseDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = browserLeaseMutationLockPath(provider, options);
  const ownerPath = path.join(lockPath, "owner.json");
  const timeoutMs = normalizeMilliseconds(
    options.mutationLockTimeoutMs,
    DEFAULT_BROWSER_LEASE_MUTATION_LOCK_TIMEOUT_MS,
    "Browser lease mutation lock timeout",
  );
  const staleMs = normalizeMilliseconds(
    options.mutationLockStaleMs,
    DEFAULT_BROWSER_LEASE_MUTATION_LOCK_STALE_MS,
    "Browser lease mutation lock stale timeout",
  );
  const pollMs = normalizeMilliseconds(
    options.mutationLockPollMs,
    DEFAULT_BROWSER_LEASE_MUTATION_LOCK_POLL_MS,
    "Browser lease mutation lock poll interval",
  );
  const startedAt = Date.now();

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const owner = {
          created_at: new Date().toISOString(),
          pid: process.pid,
          provider,
        };
        await writeFile(ownerPath, `${JSON.stringify(sortJson(owner), null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await removeStaleBrowserLeaseMutationLock(lockPath, staleMs);
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw new Error(
          `Timed out acquiring browser lease mutation lock for ${provider}; retry or remove ${lockPath} if no oracle process is using it.`,
        );
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsedMs)));
    }
  }
}

function browserLeaseMutationLockPath(
  provider: BrowserLeaseProvider,
  options: BrowserLeaseStoreOptions,
): string {
  return path.join(browserLeaseDir(options), `.${provider}.mutation.lock`);
}

async function removeStaleBrowserLeaseMutationLock(
  lockPath: string,
  staleMs: number,
): Promise<void> {
  const owner = await readBrowserLeaseMutationLockOwner(lockPath);
  if (owner?.pid && !isLocalProcessRunning(owner.pid)) {
    const latestOwner = await readBrowserLeaseMutationLockOwner(lockPath);
    if (latestOwner?.pid === owner.pid) {
      await rm(lockPath, { recursive: true, force: true });
    }
    return;
  }

  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs >= staleMs) {
    const latestStat = await stat(lockPath).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    });
    if (latestStat && Date.now() - latestStat.mtimeMs >= staleMs) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function readBrowserLeaseMutationLockOwner(
  lockPath: string,
): Promise<{ pid?: number } | null> {
  try {
    const raw = await readFile(path.join(lockPath, "owner.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) ? { pid } : null;
  } catch {
    return null;
  }
}

function isLocalProcessRunning(pid: number): boolean {
  if (pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const sorted = sortJson(record[key]);
      if (sorted !== undefined) {
        acc[key] = sorted;
      }
      return acc;
    }, {});
}

function normalizeTtlSeconds(value: number | undefined): number {
  const ttl = value ?? DEFAULT_BROWSER_LEASE_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("Browser lease TTL must be a positive number of seconds.");
  }
  return Math.trunc(ttl);
}

function normalizeMilliseconds(value: number | undefined, fallback: number, label: string): number {
  const milliseconds = value ?? fallback;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`${label} must be a positive number of milliseconds.`);
  }
  return Math.trunc(milliseconds);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function currentDate(options: BrowserLeaseStoreOptions): Date {
  return options.now?.() ?? new Date();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function defaultHolder(): string {
  const user = safeUsername();
  const host = os.hostname() || "unknown-host";
  return `${user}@${host}`;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || "unknown-user";
  } catch {
    return "unknown-user";
  }
}

function defaultCommandSummary(): string {
  return process.argv.slice(0, 4).join(" ");
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "EEXIST");
}
