import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const appendQueues = new Map<string, Promise<void>>();

export const EVIDENCE_LEDGER_APPEND_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INITIAL_MS = 2;
const DEFAULT_RETRY_MAX_MS = 25;

export interface EvidenceLedgerAppendSerializationOptions {
  readonly staleMs?: number;
  readonly timeoutMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => Date;
}

/**
 * Serializes a ledger append critical section by ledger path.
 *
 * The in-process queue prevents Promise.all callers from racing the
 * read-tail/compute-next/append sequence. The lock file extends that
 * cooperation across Oracle processes that use this module; direct
 * writes to ledger.jsonl remain unsupported because they bypass the
 * append-only chain contract.
 */
export async function serializeEvidenceLedgerAppend<T>(
  ledgerPath: string,
  task: () => Promise<T>,
  options: EvidenceLedgerAppendSerializationOptions = {},
): Promise<T> {
  const key = path.resolve(ledgerPath);
  return enqueueAppend(key, () => withAppendLockFile(key, task, options));
}

function enqueueAppend<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  appendQueues.set(key, tail);

  return previous
    .catch(() => undefined)
    .then(async () => {
      try {
        return await task();
      } finally {
        release();
        if (appendQueues.get(key) === tail) {
          appendQueues.delete(key);
        }
      }
    });
}

async function withAppendLockFile<T>(
  ledgerPath: string,
  task: () => Promise<T>,
  options: EvidenceLedgerAppendSerializationOptions,
): Promise<T> {
  const lockPath = evidenceLedgerAppendLockPath(ledgerPath);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const startedAt = millis(options);
  let attempt = 0;
  while (true) {
    const handle = await tryAcquireLockFile(lockPath, ledgerPath, options);
    if (handle) {
      try {
        return await task();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }

    await removeStaleLock(lockPath, options);
    const elapsed = millis(options) - startedAt;
    if (elapsed > (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)) {
      throw new Error(
        `Timed out waiting for evidence ledger append lock ${lockPath} after ${elapsed}ms`,
      );
    }

    const delayMs = Math.min(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      (options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS) * 2 ** attempt,
    );
    attempt += 1;
    await sleep(delayMs);
  }
}

export function evidenceLedgerAppendLockPath(ledgerPath: string): string {
  return `${ledgerPath}.append.lock`;
}

async function tryAcquireLockFile(
  lockPath: string,
  ledgerPath: string,
  options: EvidenceLedgerAppendSerializationOptions,
): Promise<FileHandle | null> {
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        ledger_path: ledgerPath,
        created_at: (options.now ? options.now() : new Date()).toISOString(),
      })}\n`,
      "utf8",
    );
    await handle.sync().catch(() => undefined);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
}

async function removeStaleLock(
  lockPath: string,
  options: EvidenceLedgerAppendSerializationOptions,
): Promise<void> {
  const staleMs = options.staleMs ?? EVIDENCE_LEDGER_APPEND_LOCK_STALE_MS;
  const stat = await fs.stat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (millis(options) - stat.mtimeMs < staleMs) return;
  await fs.unlink(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

function millis(options: EvidenceLedgerAppendSerializationOptions): number {
  return options.now ? options.now().getTime() : Date.now();
}
