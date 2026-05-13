// Perf + correctness regression for oracle-dpp: the batch API must
// land N entries via ONE atomic commit (one rename, one fsync cycle)
// instead of N — without sacrificing the lost-update / atomicity
// guarantees from oracle-xcb.

import fs from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  drainArtifactIndexLocksForTest,
  upsertArtifactIndexEntry,
} from "../../../src/oracle/v18/artifact_index_lock.js";
import {
  serializeArtifactIndexBatchUpdate,
  upsertArtifactIndexEntries,
} from "../../../src/oracle/v18/artifact_index_batch.js";
import { readArtifactIndex } from "../../../src/oracle/v18/evidence.js";
import type { ArtifactIndexEntry } from "../../../src/oracle/v18/contracts.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "oracle-dpp-"));
});

afterEach(async () => {
  await drainArtifactIndexLocksForTest();
  await rm(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function entry(id: string): ArtifactIndexEntry {
  const hex = id.padEnd(64, "1").slice(0, 64).replace(/[^0-9a-f]/g, "1");
  return {
    artifact_id: id,
    kind: "browser_evidence",
    path: `evidence/${id}.json`,
    sha256: `sha256:${hex}`,
  };
}

// ─── Correctness ────────────────────────────────────────────────────────────

describe("upsertArtifactIndexEntries — correctness", () => {
  testNonWindows("adds every entry from a fresh index", async () => {
    const indexFile = path.join(workDir, "fresh.json");
    const ids = ["ev-1", "ev-2", "ev-3", "ev-4", "ev-5"];
    await upsertArtifactIndexEntries(indexFile, ids.map(entry));
    const index = await readArtifactIndex(indexFile);
    expect(index?.artifacts).toHaveLength(5);
    const seen = new Set(index?.artifacts.map((a) => a.artifact_id));
    for (const id of ids) expect(seen.has(id)).toBe(true);
  });

  testNonWindows("dedupes within the batch (last wins on artifact_id collision)", async () => {
    const indexFile = path.join(workDir, "dedup.json");
    await upsertArtifactIndexEntries(indexFile, [
      entry("ev-dup"),
      { ...entry("ev-dup"), path: "evidence/ev-dup-renamed.json" },
    ]);
    const index = await readArtifactIndex(indexFile);
    expect(index?.artifacts).toHaveLength(1);
    expect(index?.artifacts[0].path).toBe("evidence/ev-dup-renamed.json");
  });

  testNonWindows("merges with existing entries; replaces by artifact_id", async () => {
    const indexFile = path.join(workDir, "merge.json");
    await upsertArtifactIndexEntries(indexFile, [entry("ev-existing")]);
    await upsertArtifactIndexEntries(indexFile, [
      entry("ev-new-1"),
      { ...entry("ev-existing"), path: "evidence/ev-existing-renamed.json" },
      entry("ev-new-2"),
    ]);
    const index = await readArtifactIndex(indexFile);
    expect(index?.artifacts).toHaveLength(3);
    const existing = index?.artifacts.find((a) => a.artifact_id === "ev-existing");
    expect(existing?.path).toBe("evidence/ev-existing-renamed.json");
  });

  testNonWindows("empty batch is a no-op (reads but does not write a file)", async () => {
    const indexFile = path.join(workDir, "empty.json");
    await upsertArtifactIndexEntries(indexFile, []);
    await expect(readFile(indexFile, "utf8")).rejects.toThrow(/ENOENT/);
  });

  testNonWindows("preserves prior entries not touched by the batch", async () => {
    const indexFile = path.join(workDir, "preserve.json");
    await upsertArtifactIndexEntry(indexFile, entry("ev-untouched"));
    await upsertArtifactIndexEntries(indexFile, [entry("ev-a"), entry("ev-b")]);
    const index = await readArtifactIndex(indexFile);
    expect(index?.artifacts).toHaveLength(3);
    expect(index?.artifacts.some((a) => a.artifact_id === "ev-untouched")).toBe(true);
  });

  testNonWindows("emits a sha256 receipt for the batched bytes when requested", async () => {
    const indexFile = path.join(workDir, "receipt.json");
    const result = await serializeArtifactIndexBatchUpdate(
      indexFile,
      () => ({
        schema_version: "artifact_index.v1",
        artifacts: [entry("ev-r-1"), entry("ev-r-2")],
      }),
      { emitReceipt: true },
    );
    expect(result.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ─── Perf: fsync count ──────────────────────────────────────────────────────

describe("upsertArtifactIndexEntries — perf (atomic commits)", () => {
  testNonWindows(
    "50 single upserts => 50 renames; one batch of 50 => exactly 1 rename",
    async () => {
      const singleFile = path.join(workDir, "single.json");
      const batchFile = path.join(workDir, "batch.json");
      const ids = Array.from({ length: 50 }, (_, i) => `ev-${String(i).padStart(3, "0")}`);

      // Spy on fs.promises.rename — the atomic commit point. Calls
      // happen in BOTH paths; we count them per file.
      const renameSpy = vi.spyOn(fs, "rename");

      // Single-entry path: 50 sequential renames against singleFile.
      for (const id of ids) {
        await upsertArtifactIndexEntry(singleFile, entry(id));
      }
      const singleRenames = renameSpy.mock.calls.filter(
        ([, dest]) => dest === singleFile,
      ).length;

      renameSpy.mockClear();

      // Batch path: ONE rename against batchFile.
      await upsertArtifactIndexEntries(batchFile, ids.map(entry));
      const batchRenames = renameSpy.mock.calls.filter(
        ([, dest]) => dest === batchFile,
      ).length;

      expect(singleRenames).toBe(50);
      expect(batchRenames).toBe(1);

      // Both paths produce identical final state.
      const singleIndex = await readArtifactIndex(singleFile);
      const batchIndex = await readArtifactIndex(batchFile);
      expect(singleIndex?.artifacts).toHaveLength(50);
      expect(batchIndex?.artifacts).toHaveLength(50);
      const sortIds = (xs: { artifact_id?: string }[]) =>
        xs.map((x) => x.artifact_id).sort();
      expect(sortIds(batchIndex!.artifacts)).toEqual(sortIds(singleIndex!.artifacts));
    },
  );

  testNonWindows(
    "batch read happens ONCE regardless of entry count",
    async () => {
      const indexFile = path.join(workDir, "one-read.json");
      const readSpy = vi.spyOn(fs, "readFile");
      await upsertArtifactIndexEntries(
        indexFile,
        Array.from({ length: 20 }, (_, i) => entry(`ev-r-${i}`)),
      );
      // Filter to just our target index file (other readFile calls
      // for unrelated test fixtures should not pollute the count).
      const indexReads = readSpy.mock.calls.filter(([f]) => f === indexFile).length;
      // One read because the file does not exist on first call —
      // readArtifactIndex catches the ENOENT and treats it as a fresh
      // index. Subsequent re-reads inside the batch path: zero.
      expect(indexReads).toBeLessThanOrEqual(1);
    },
  );

  testNonWindows("batch writes one canonical JSON blob (one writeFile/open)", async () => {
    // The lock helper writes via fs.open(...).writeFile(...) on a
    // tmpfile then renames. We count distinct tmpfile creation events
    // via spy on fs.open — exactly one per batch.
    const indexFile = path.join(workDir, "one-open.json");
    const openSpy = vi.spyOn(fs, "open");
    await upsertArtifactIndexEntries(
      indexFile,
      Array.from({ length: 30 }, (_, i) => entry(`ev-o-${i}`)),
    );
    // The open calls happen against `<indexFile>.tmp.*` paths; count
    // the ones whose first arg starts with the index file path.
    const tmpfileOpens = openSpy.mock.calls.filter(
      ([target]) => typeof target === "string" && target.startsWith(`${indexFile}.tmp.`),
    ).length;
    expect(tmpfileOpens).toBe(1);
  });
});

// ─── Lock isolation ─────────────────────────────────────────────────────────

describe("upsertArtifactIndexEntries — lock isolation", () => {
  testNonWindows("two concurrent batches on the same file serialize correctly", async () => {
    const indexFile = path.join(workDir, "concurrent.json");
    const batchA = Array.from({ length: 10 }, (_, i) => entry(`a-${i}`));
    const batchB = Array.from({ length: 10 }, (_, i) => entry(`b-${i}`));
    await Promise.all([
      upsertArtifactIndexEntries(indexFile, batchA),
      upsertArtifactIndexEntries(indexFile, batchB),
    ]);
    const index = await readArtifactIndex(indexFile);
    expect(index?.artifacts).toHaveLength(20);
    const ids = new Set(index?.artifacts.map((a) => a.artifact_id));
    for (let i = 0; i < 10; i += 1) {
      expect(ids.has(`a-${i}`)).toBe(true);
      expect(ids.has(`b-${i}`)).toBe(true);
    }
  });

  testNonWindows("batches on different files do not block each other", async () => {
    const a = path.join(workDir, "iso-a.json");
    const b = path.join(workDir, "iso-b.json");
    await Promise.all([
      upsertArtifactIndexEntries(
        a,
        Array.from({ length: 10 }, (_, i) => entry(`a-${i}`)),
      ),
      upsertArtifactIndexEntries(
        b,
        Array.from({ length: 10 }, (_, i) => entry(`b-${i}`)),
      ),
    ]);
    const indexA = await readArtifactIndex(a);
    const indexB = await readArtifactIndex(b);
    expect(indexA?.artifacts).toHaveLength(10);
    expect(indexB?.artifacts).toHaveLength(10);
  });
});
