import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  readEvidenceLedger,
} from "../../src/oracle/evidence_ledger.js";
import { serializeEvidenceLedgerAppend } from "../../src/oracle/evidence_ledger_concurrency.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-concurrency-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("evidence ledger append concurrency", () => {
  testNonWindows("concurrent appends to one session produce one ordered hash chain", async () => {
    const sessionId = "session-concurrent-ledger";
    const appendCount = 64;

    const results = await Promise.all(
      Array.from({ length: appendCount }, (_, index) =>
        appendEvidenceLedgerEvent(
          sessionId,
          {
            type: "evidence_written",
            evidence_id: `ev-${index}`,
            timestamp: `2026-05-13T00:00:00.${String(index).padStart(3, "0")}Z`,
            metadata: { append_index: index },
          },
          { homeDir },
        ),
      ),
    );

    const read = await readEvidenceLedger(sessionId, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.chainFailure).toBeNull();
    expect(read.entries).toHaveLength(appendCount);
    expect(new Set(results.map((result) => result.entry.sequence)).size).toBe(
      appendCount,
    );

    for (let index = 0; index < read.entries.length; index += 1) {
      expect(read.entries[index].sequence).toBe(index);
      if (index > 0) {
        expect(read.entries[index].prev_hash).toBe(read.entries[index - 1].entry_hash);
      }
    }
  });

  testNonWindows("different session ledgers do not share the in-process queue", async () => {
    const firstPath = evidenceLedgerPath("session-concurrency-a", homeDir);
    const secondPath = evidenceLedgerPath("session-concurrency-b", homeDir);
    const events: string[] = [];
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();

    const first = serializeEvidenceLedgerAppend(firstPath, async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    await firstEntered.promise;

    const second = await serializeEvidenceLedgerAppend(secondPath, async () => {
      events.push("second");
      return "second";
    });

    expect(second).toBe("second");
    expect(events).toEqual(["first:start", "second"]);

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    expect(events).toEqual(["first:start", "second", "first:end"]);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
