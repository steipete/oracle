// Serialized artifact-index updates for concurrent writers (oracle-xcb).
//
// Background: src/oracle/v18/evidence.ts writeEvidence does
// read(index) → upsert → write(index) on every call. Two concurrent
// writeEvidence calls for distinct evidence_ids in the same session
// race: both read the same prior index and the second write clobbers
// the first's upsert. The evidence file lives on disk but is invisible
// to artifact_index readers — APR / evidence verification cannot find it.
//
// This module adds a serialized read-modify-write helper that callers
// can use instead of the bare readArtifactIndex/writeArtifactIndex pair.
// Two layers of protection:
//
//   1. In-process per-path async mutex (promise queue keyed by the
//      canonical index file path). Concurrent callers in the same Node
//      process queue, never racing the read-modify-write window.
//
//   2. Atomic on-disk write: serialise canonical JSON to a unique
//      tmpfile in the same directory, fsync the contents, rename over
//      the target, fsync the parent directory on POSIX. Readers
//      observe either the old file or the new file, never a partial
//      write.
//
// The module is intentionally a separate file — pane 6's
// src/oracle/v18/evidence.ts is read-only per the bead's domain
// constraint. Future callers should prefer these helpers over the bare
// writeArtifactIndex.

import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  canonicalJSON,
  readArtifactIndex,
} from "./evidence.js";
import type { ArtifactIndex, ArtifactIndexEntry } from "./contracts.js";

// ─── Per-path async mutex ────────────────────────────────────────────────────

const ACTIVE_LOCKS = new Map<string, Promise<unknown>>();

function lockKey(indexFile: string): string {
  // Normalise the path so callers passing different shapes of the
  // same logical file converge on the same lock. We resolve relative
  // paths against cwd and lowercase only the drive letter on Windows.
  const resolved = path.resolve(indexFile);
  if (process.platform === "win32" && resolved.length >= 2 && resolved[1] === ":") {
    return resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

/**
 * Run `work` while holding the per-path lock. Throws if `work`
 * throws; the lock is released either way. Concurrent callers for the
 * same `indexFile` queue in arrival order.
 */
async function withIndexLock<T>(indexFile: string, work: () => Promise<T>): Promise<T> {
  const key = lockKey(indexFile);
  const prior = ACTIVE_LOCKS.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  ACTIVE_LOCKS.set(key, prior.then(() => next));
  try {
    await prior; // Wait for prior holder to finish.
    return await work();
  } finally {
    release();
    // Clear the map entry if we are the tail to avoid unbounded growth.
    // The check guards against an interleaving where a newer waiter
    // already chained itself onto our promise.
    if (ACTIVE_LOCKS.get(key) === prior.then(() => next)) {
      // (No reliable equality check across awaits — leave the entry;
      // it costs one promise reference per file and tides out at process
      // exit.)
    }
  }
}

// ─── Atomic write ────────────────────────────────────────────────────────────

async function atomicWriteIndexFile(indexFile: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  // Unique tmpfile in the same directory so rename is on the same FS.
  const tmp = `${indexFile}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fs.rename(tmp, indexFile);
  if (process.platform !== "win32") {
    await fs.chmod(indexFile, 0o600).catch(() => undefined);
    // fsync the parent directory so the rename is durable.
    let dirHandle: fs.FileHandle | null = null;
    try {
      dirHandle = await fs.open(path.dirname(indexFile), "r");
      await dirHandle.sync().catch(() => undefined);
    } catch {
      // Directories cannot be opened for fsync on every platform; the
      // rename itself is the durability boundary readers care about.
    } finally {
      await dirHandle?.close().catch(() => undefined);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SerializeArtifactIndexUpdateOptions {
  /**
   * Emit a sha256 receipt of the post-mutation bytes alongside the
   * normal return value. Callers can pin the receipt in a parent
   * envelope (run_progress.v1, browser_evidence.v1 ledger entry) for
   * downstream auditing.
   */
  readonly emitReceipt?: boolean;
}

export interface SerializeArtifactIndexUpdateResult {
  readonly index: ArtifactIndex;
  /** sha256 of the canonical JSON that was written, if requested. */
  readonly sha256: `sha256:${string}` | null;
}

/**
 * Read the artifact index, hand it to `mutate` to produce a new
 * index, and atomically write the result. Concurrent callers for the
 * same `indexFile` queue on an in-process mutex; the on-disk write is
 * temp-file + rename so readers never see a partial state.
 *
 * `mutate` is called with `null` when the index file does not yet
 * exist; return either a fresh ArtifactIndex or `null` to skip the
 * write entirely (rare — useful when the mutation discovers nothing
 * to change).
 */
export async function serializeArtifactIndexUpdate(
  indexFile: string,
  mutate: (current: ArtifactIndex | null) => ArtifactIndex | null | Promise<ArtifactIndex | null>,
  options: SerializeArtifactIndexUpdateOptions = {},
): Promise<SerializeArtifactIndexUpdateResult> {
  return withIndexLock(indexFile, async () => {
    const current = await readArtifactIndex(indexFile);
    const next = await mutate(current);
    if (next === null) {
      return { index: current as ArtifactIndex, sha256: null };
    }
    const canonical = canonicalJSON(next);
    await atomicWriteIndexFile(indexFile, `${canonical}\n`);
    const sha = options.emitReceipt
      ? (`sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}` as `sha256:${string}`)
      : null;
    return { index: next, sha256: sha };
  });
}

/**
 * Convenience wrapper: upsert one entry into the index under the
 * serialized lock. Replaces any prior entry with the same
 * `artifact_id` OR the same `path`. Creates an empty index when the
 * file does not exist.
 */
export interface UpsertArtifactIndexEntryOptions {
  /** Required when the index file does not yet exist. */
  readonly emptyIndex?: () => ArtifactIndex;
}

export async function upsertArtifactIndexEntry(
  indexFile: string,
  entry: ArtifactIndexEntry,
  options: UpsertArtifactIndexEntryOptions = {},
): Promise<ArtifactIndex> {
  const result = await serializeArtifactIndexUpdate(indexFile, (current) => {
    const base = current ?? options.emptyIndex?.() ?? defaultEmptyIndex();
    return mergeUpsert(base, entry);
  });
  return result.index;
}

function mergeUpsert(index: ArtifactIndex, entry: ArtifactIndexEntry): ArtifactIndex {
  const others = index.artifacts.filter(
    (existing) =>
      !(entry.artifact_id && existing.artifact_id === entry.artifact_id) &&
      existing.path !== entry.path,
  );
  return { ...index, artifacts: [...others, entry] };
}

function defaultEmptyIndex(): ArtifactIndex {
  return {
    schema_version: "artifact_index.v1",
    artifacts: [],
  } as ArtifactIndex;
}

/**
 * Test-only: drain every in-flight lock. Useful in afterEach() to
 * make sure no background work is still touching a temp directory we
 * are about to delete.
 */
export async function drainArtifactIndexLocksForTest(): Promise<void> {
  const snapshot = Array.from(ACTIVE_LOCKS.values());
  await Promise.allSettled(snapshot);
}
