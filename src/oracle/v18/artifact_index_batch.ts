// Batched artifact-index updates (oracle-dpp).
//
// `serializeArtifactIndexUpdate` from artifact_index_lock.ts (oracle-xcb)
// fixes lost-update races + makes the on-disk commit atomic, but it is
// still single-entry oriented. Each call does:
//
//   1. acquire per-path lock
//   2. readArtifactIndex (parse the full JSON)
//   3. mutate
//   4. canonical-JSON serialize the full index
//   5. write tmpfile + fsync + rename + fsync parent dir
//   6. release lock
//
// For N evidence artifacts in one session that's N read/parse/serialize
// cycles AND up to N×2 fsync calls on POSIX. Empirically the cumulative
// entry work is O(N²) because each cycle re-scans the growing index.
//
// This module adds a batch path: collect every upsert into one
// mutator pass, write the merged index ONCE. Same correctness
// guarantees (per-path mutex via the existing lock helper; atomic
// temp+rename via the same primitive), but one fsync cycle per batch
// instead of one per entry.
//
// Keep the single-entry helper for simple callers — the migration is
// opt-in, not a breaking change.

import {
  serializeArtifactIndexUpdate,
  type SerializeArtifactIndexUpdateOptions,
  type SerializeArtifactIndexUpdateResult,
} from "./artifact_index_lock.js";
import type { ArtifactIndex, ArtifactIndexEntry } from "./contracts.js";

// ─── Batch mutator ───────────────────────────────────────────────────────────

export interface SerializeArtifactIndexBatchUpdateOptions
  extends SerializeArtifactIndexUpdateOptions {
  /** Optional factory for the genesis index when the file does not exist. */
  readonly emptyIndex?: () => ArtifactIndex;
}

/**
 * Run `mutate` against the current index under the per-path lock and
 * write the result atomically — identical in shape to
 * `serializeArtifactIndexUpdate` but typed as a batch entry point so
 * call sites can self-document that they intend to make multiple
 * changes within one commit. `mutate` may return `null` to skip the
 * write entirely.
 */
export async function serializeArtifactIndexBatchUpdate(
  indexFile: string,
  mutate: (current: ArtifactIndex | null) => ArtifactIndex | null | Promise<ArtifactIndex | null>,
  options: SerializeArtifactIndexBatchUpdateOptions = {},
): Promise<SerializeArtifactIndexUpdateResult> {
  return serializeArtifactIndexUpdate(indexFile, mutate, options);
}

// ─── Convenience: bulk upsert ───────────────────────────────────────────────

/**
 * Upsert many entries into the artifact index under one lock + one
 * atomic write. Replaces any prior entry with the same `artifact_id`
 * OR the same `path`. When two entries in the same batch collide on
 * either key, the LATER entry wins (callers that want first-wins
 * semantics can dedupe before calling).
 *
 * Performance: a batch of N entries performs exactly one
 * read-modify-write cycle (one parse, one canonical serialise, one
 * temp+rename, one parent-dir fsync on POSIX). Compared to N calls
 * to `upsertArtifactIndexEntry`, that is N→1 rename calls and a
 * dramatic reduction in cumulative entry scans (O(N²)→O(N)).
 */
export async function upsertArtifactIndexEntries(
  indexFile: string,
  entries: readonly ArtifactIndexEntry[],
  options: SerializeArtifactIndexBatchUpdateOptions = {},
): Promise<ArtifactIndex> {
  if (entries.length === 0) {
    // No-op: read the current index without writing. Callers that
    // expect a created file should pass at least one entry.
    const result = await serializeArtifactIndexBatchUpdate(indexFile, () => null, options);
    return result.index as ArtifactIndex;
  }
  const result = await serializeArtifactIndexBatchUpdate(
    indexFile,
    (current) => {
      const base = current ?? options.emptyIndex?.() ?? defaultEmptyIndex();
      return mergeBatch(base, entries);
    },
    options,
  );
  return result.index;
}

function mergeBatch(
  index: ArtifactIndex,
  entries: readonly ArtifactIndexEntry[],
): ArtifactIndex {
  // Build (artifact_id, path) -> entry maps in arrival order so later
  // entries win. We then filter out any pre-existing index entries that
  // collide with the batched ones on either key, and append the batch.
  const byArtifactId = new Map<string, ArtifactIndexEntry>();
  const byPath = new Map<string, ArtifactIndexEntry>();
  for (const entry of entries) {
    if (entry.artifact_id) byArtifactId.set(entry.artifact_id, entry);
    byPath.set(entry.path, entry);
  }
  const survivors = index.artifacts.filter((existing) => {
    if (existing.artifact_id && byArtifactId.has(existing.artifact_id)) return false;
    if (byPath.has(existing.path)) return false;
    return true;
  });
  // Deduplicate the batch itself: an entry appearing later supersedes
  // an earlier one with the same key. We emit entries in their first
  // declared position so list ordering stays stable.
  const seenArtifactIds = new Set<string>();
  const seenPaths = new Set<string>();
  const dedupedBatch: ArtifactIndexEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.artifact_id && seenArtifactIds.has(entry.artifact_id)) continue;
    if (seenPaths.has(entry.path)) continue;
    if (entry.artifact_id) seenArtifactIds.add(entry.artifact_id);
    seenPaths.add(entry.path);
    dedupedBatch.unshift(entry);
  }
  return { ...index, artifacts: [...survivors, ...dedupedBatch] };
}

function defaultEmptyIndex(): ArtifactIndex {
  return {
    schema_version: "artifact_index.v1",
    artifacts: [],
  } as ArtifactIndex;
}
