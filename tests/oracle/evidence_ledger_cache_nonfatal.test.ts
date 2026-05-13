import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  readEvidenceLedger,
} from "../../src/oracle/evidence_ledger.js";
import {
  DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL,
  clearEvidenceLedgerHeadCache,
  evidenceLedgerHeadCachePath,
  getEvidenceLedgerHeadCacheStats,
  resetEvidenceLedgerHeadCacheStats,
} from "../../src/oracle/evidence_ledger_cache.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-cache-nonfatal-"));
  clearEvidenceLedgerHeadCache();
  resetEvidenceLedgerHeadCacheStats();
});

afterEach(async () => {
  clearEvidenceLedgerHeadCache();
  resetEvidenceLedgerHeadCacheStats();
  await rm(homeDir, { recursive: true, force: true });
});

describe("evidence ledger head-cache nonfatal updates", () => {
  testNonWindows("flush failure after disk append does not reject or corrupt the chain", async () => {
    const sessionId = "session-cache-flush-fails";
    const filePath = evidenceLedgerPath(sessionId, homeDir);

    for (let index = 0; index < DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL - 1; index += 1) {
      await appendEvidenceLedgerEvent(
        sessionId,
        {
          type: "evidence_written",
          evidence_id: `ev-${index}`,
          timestamp: `2026-05-13T00:00:${String(index).padStart(2, "0")}.000Z`,
        },
        { homeDir },
      );
    }

    const cachePath = evidenceLedgerHeadCachePath(filePath);
    await mkdir(cachePath, { recursive: true });

    const appended = await appendEvidenceLedgerEvent(
      sessionId,
      {
        type: "run_completed",
        timestamp: "2026-05-13T00:01:00.000Z",
      },
      { homeDir },
    );

    expect(appended.entry.sequence).toBe(
      DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL - 1,
    );
    expect(getEvidenceLedgerHeadCacheStats().nonFatalUpdateFailures).toBe(1);

    const afterFailedFlush = await readEvidenceLedger(sessionId, { homeDir });
    expect(afterFailedFlush.chainValid).toBe(true);
    expect(afterFailedFlush.entries).toHaveLength(DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL);

    await rm(cachePath, { recursive: true, force: true });
    resetEvidenceLedgerHeadCacheStats();

    const reconciled = await appendEvidenceLedgerEvent(
      sessionId,
      {
        type: "browser_attached",
        mode: "remote",
        timestamp: "2026-05-13T00:01:01.000Z",
      },
      { homeDir },
    );

    const finalLedger = await readEvidenceLedger(sessionId, { homeDir });
    const prior = finalLedger.entries[finalLedger.entries.length - 2];

    expect(reconciled.entry.sequence).toBe(DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL);
    expect(reconciled.entry.prev_hash).toBe(prior.entry_hash);
    expect(getEvidenceLedgerHeadCacheStats().tailReads).toBe(1);
    expect(finalLedger.chainValid).toBe(true);
    expect(finalLedger.entries).toHaveLength(DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL + 1);
  });
});
