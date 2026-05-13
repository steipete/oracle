// Regression test for oracle-xcb: concurrent artifact-index writers
// must not lose entries.
//
// Bug: src/oracle/v18/evidence.ts writeEvidence does
// read(index) → upsert → write(index) without serialisation. Two
// concurrent calls for distinct evidence_ids can both read the same
// prior index and the second write clobbers the first.
//
// Fix: use serializeArtifactIndexUpdate / upsertArtifactIndexEntry
// from src/oracle/v18/artifact_index_lock.ts. The helpers wrap every
// read-modify-write in a per-path async mutex AND write atomically
// via temp-file + rename. Migration: switch existing call sites to
// the helpers (bead description scope).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  drainArtifactIndexLocksForTest,
  serializeArtifactIndexUpdate,
  upsertArtifactIndexEntry,
} from "../../../src/oracle/v18/artifact_index_lock.js";
import { readArtifactIndex } from "../../../src/oracle/v18/evidence.js";
import type { ArtifactIndex, ArtifactIndexEntry } from "../../../src/oracle/v18/contracts.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "oracle-artifact-index-lock-"));
});

afterEach(async () => {
  await drainArtifactIndexLocksForTest();
  await rm(workDir, { recursive: true, force: true });
});

function realHash(seed: string): `sha256:${string}` {
  // Non-placeholder digest so the v18 hash guard would accept it.
  const hex = seed.padEnd(64, "1").slice(0, 64).replace(/[^0-9a-f]/g, "1");
  return `sha256:${hex}`;
}

function entry(id: string): ArtifactIndexEntry {
  return {
    artifact_id: id,
    kind: "browser_evidence",
    path: `evidence/${id}.json`,
    sha256: realHash(id),
  };
}

// ─── Serialised single-writer correctness ───────────────────────────────────

describe("serializeArtifactIndexUpdate — single writer", () => {
  testNonWindows("creates a fresh index when the file does not exist", async () => {
    const indexFile = path.join(workDir, "index.json");
    const { index } = await serializeArtifactIndexUpdate(indexFile, () => ({
      schema_version: "artifact_index.v1",
      artifacts: [entry("ev-1")],
    }));
    expect(index.artifacts).toHaveLength(1);
    const onDisk = await readArtifactIndex(indexFile);
    expect(onDisk?.artifacts).toEqual(index.artifacts);
  });

  testNonWindows("emits a sha256 receipt when requested", async () => {
    const indexFile = path.join(workDir, "index.json");
    const { sha256 } = await serializeArtifactIndexUpdate(
      indexFile,
      () => ({ schema_version: "artifact_index.v1", artifacts: [entry("ev-r")] }),
      { emitReceipt: true },
    );
    expect(sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  testNonWindows("returning null skips the write (no file created)", async () => {
    const indexFile = path.join(workDir, "no-write.json");
    await serializeArtifactIndexUpdate(indexFile, () => null);
    await expect(readFile(indexFile, "utf8")).rejects.toThrow(/ENOENT/);
  });

  testNonWindows("uses temp-file + rename (no partial state visible)", async () => {
    const indexFile = path.join(workDir, "atomic.json");
    await serializeArtifactIndexUpdate(indexFile, () => ({
      schema_version: "artifact_index.v1",
      artifacts: [entry("ev-a")],
    }));
    const raw = await readFile(indexFile, "utf8");
    // The file ends with a newline and parses as a complete index.
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as ArtifactIndex;
    expect(parsed.schema_version).toBe("artifact_index.v1");
    expect(parsed.artifacts).toHaveLength(1);
  });
});

// ─── Concurrent writers regression ──────────────────────────────────────────

describe("upsertArtifactIndexEntry — concurrent writers", () => {
  testNonWindows("50 concurrent upserts to the same index lose ZERO entries", async () => {
    const indexFile = path.join(workDir, "concurrent.json");
    const ids = Array.from({ length: 50 }, (_, i) => `ev-${String(i).padStart(3, "0")}`);

    // Fire every upsert in parallel — this is the bug repro shape:
    // each call independently reads the prior index, mutates it, and
    // writes it back. Without the lock, last-write-wins drops entries.
    await Promise.all(ids.map((id) => upsertArtifactIndexEntry(indexFile, entry(id))));

    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(50);
    const finalIds = new Set(final?.artifacts.map((a) => a.artifact_id));
    for (const id of ids) {
      expect(finalIds.has(id), `entry ${id} missing from concurrent index`).toBe(true);
    }
  });

  testNonWindows("concurrent upserts produce a single valid index file", async () => {
    const indexFile = path.join(workDir, "single-valid.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => upsertArtifactIndexEntry(indexFile, entry(`ev-c-${i}`))),
    );
    // File is parseable and matches the schema.
    const final = await readArtifactIndex(indexFile);
    expect(final).not.toBeNull();
    expect(final!.schema_version).toBe("artifact_index.v1");
    expect(final!.artifacts).toHaveLength(20);
  });

  testNonWindows("upsert replaces a prior entry with the same artifact_id (no duplicate)", async () => {
    const indexFile = path.join(workDir, "dedup.json");
    await upsertArtifactIndexEntry(indexFile, entry("ev-dup"));
    await upsertArtifactIndexEntry(indexFile, {
      ...entry("ev-dup"),
      path: "evidence/ev-dup-renamed.json",
    });
    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(1);
    expect(final?.artifacts[0].path).toBe("evidence/ev-dup-renamed.json");
  });

  testNonWindows("concurrent upserts on DIFFERENT files do not block each other", async () => {
    // Two distinct index files have their own locks. We submit twenty
    // upserts to each in parallel and confirm both files end up
    // complete. (No timing assertion — just correctness.)
    const a = path.join(workDir, "session-a.json");
    const b = path.join(workDir, "session-b.json");
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => upsertArtifactIndexEntry(a, entry(`a-${i}`))),
      ...Array.from({ length: 20 }, (_, i) => upsertArtifactIndexEntry(b, entry(`b-${i}`))),
    ]);
    const indexA = await readArtifactIndex(a);
    const indexB = await readArtifactIndex(b);
    expect(indexA?.artifacts).toHaveLength(20);
    expect(indexB?.artifacts).toHaveLength(20);
  });
});

// ─── Mutator semantics ──────────────────────────────────────────────────────

describe("serializeArtifactIndexUpdate — mutator semantics", () => {
  testNonWindows("mutator sees the current on-disk index, not a stale snapshot", async () => {
    const indexFile = path.join(workDir, "stale.json");
    await upsertArtifactIndexEntry(indexFile, entry("ev-first"));

    let observedCount = -1;
    await serializeArtifactIndexUpdate(indexFile, (current) => {
      observedCount = current?.artifacts.length ?? 0;
      return { ...current!, artifacts: [...(current?.artifacts ?? []), entry("ev-second")] };
    });
    expect(observedCount).toBe(1);
    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(2);
  });

  testNonWindows("mutator can be async", async () => {
    const indexFile = path.join(workDir, "async.json");
    await serializeArtifactIndexUpdate(indexFile, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { schema_version: "artifact_index.v1", artifacts: [entry("ev-async")] };
    });
    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(1);
  });

  testNonWindows("mutator throwing releases the lock (next caller proceeds)", async () => {
    const indexFile = path.join(workDir, "throwy.json");
    await expect(
      serializeArtifactIndexUpdate(indexFile, () => {
        throw new Error("planned failure");
      }),
    ).rejects.toThrow(/planned failure/);
    // Subsequent call must succeed (no deadlock from the prior throw).
    await upsertArtifactIndexEntry(indexFile, entry("ev-after-throw"));
    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(1);
  });
});

// ─── Mutex serialisation invariant ──────────────────────────────────────────

describe("serializeArtifactIndexUpdate — serialisation invariant", () => {
  testNonWindows("mutators on the same path run strictly one at a time", async () => {
    // We instrument the mutator to record entry/exit. With proper
    // serialisation, no two mutator invocations on the same file
    // overlap in time. We assert that the observed entry/exit timeline
    // has no nested intervals.
    const indexFile = path.join(workDir, "serialised.json");
    let inFlight = 0;
    let maxConcurrent = 0;
    const tasks = Array.from({ length: 10 }, (_, i) =>
      serializeArtifactIndexUpdate(indexFile, async (current) => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        // Yield twice so a buggy implementation would interleave.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const base = current ?? { schema_version: "artifact_index.v1", artifacts: [] };
        const next = { ...base, artifacts: [...base.artifacts, entry(`ev-ser-${i}`)] };
        inFlight -= 1;
        return next;
      }),
    );
    await Promise.all(tasks);
    expect(maxConcurrent).toBe(1);
    const final = await readArtifactIndex(indexFile);
    expect(final?.artifacts).toHaveLength(10);
  });
});
