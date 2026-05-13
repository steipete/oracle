import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BrowserLeaseStateError,
  createBrowserLease,
  readBrowserLease,
  releaseBrowserLease,
  type BrowserLeaseStoreOptions,
} from "../../src/browser/leases.js";
import type { StoredBrowserLeaseRecord } from "../../src/oracle/v18/browser_lease.js";

const PROFILE = `sha256:${"e".repeat(64)}`;

type LeaseRaceOutcome =
  | {
      ok: true;
      index: number;
      lease: StoredBrowserLeaseRecord;
    }
  | {
      ok: false;
      index: number;
      error: unknown;
    };

async function withLeaseDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-lease-atomic-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("browser lease atomic acquisition", () => {
  test("stress: same-process contenders for a missing provider produce one persisted winner", async () => {
    for (let round = 0; round < 10; round += 1) {
      await withLeaseDir(async (leaseDir) => {
        const outcomes = await raceFirstAcquire(leaseDir, {
          count: 64,
          leaseIdPrefix: `missing-${round}`,
        });

        await assertSinglePersistedWinner(leaseDir, outcomes, 64);
      });
    }
  });

  test("released provider contention also re-acquires atomically", async () => {
    await withLeaseDir(async (leaseDir) => {
      const storeOptions = atomicStoreOptions(leaseDir, "released-holder");
      const released = await createBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE,
          holder: "holder-released",
          commandSummary: "initial released holder",
        },
        storeOptions,
      );
      await releaseBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE,
          leaseId: released.lease_id,
        },
        storeOptions,
      );

      const outcomes = await raceFirstAcquire(leaseDir, {
        count: 32,
        leaseIdPrefix: "released",
        provider: "gemini",
      });

      await assertSinglePersistedWinner(leaseDir, outcomes, 32, "gemini");
    });
  });
});

async function raceFirstAcquire(
  leaseDir: string,
  input: {
    count: number;
    leaseIdPrefix: string;
    provider?: "chatgpt" | "gemini";
  },
): Promise<LeaseRaceOutcome[]> {
  const provider = input.provider ?? "chatgpt";
  return Promise.all(
    Array.from({ length: input.count }, async (_, index): Promise<LeaseRaceOutcome> => {
      const leaseId = `${input.leaseIdPrefix}-${index}`;
      try {
        const lease = await createBrowserLease(
          {
            provider,
            profileIdHash: PROFILE,
            holder: `holder-${leaseId}`,
            commandSummary: `atomic acquire ${leaseId}`,
          },
          atomicStoreOptions(leaseDir, leaseId, index),
        );
        return { ok: true, index, lease };
      } catch (error) {
        return { ok: false, index, error };
      }
    }),
  );
}

async function assertSinglePersistedWinner(
  leaseDir: string,
  outcomes: LeaseRaceOutcome[],
  count: number,
  provider: "chatgpt" | "gemini" = "chatgpt",
): Promise<void> {
  const successes = outcomes.flatMap((outcome) => (outcome.ok ? [outcome] : []));
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome]));
  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(count - 1);
  const winner = successes[0]!.lease;

  const current = await readBrowserLease(provider, {
    ...atomicStoreOptions(leaseDir, "read"),
    expectedProfileIdHash: PROFILE,
  });
  expect(current.state).toBe("active");
  if (current.state === "active") {
    expect(current.record.lease_id).toBe(winner.lease_id);
  }

  for (const outcome of failures) {
    expect(outcome.error).toBeInstanceOf(BrowserLeaseStateError);
    const result = (outcome.error as BrowserLeaseStateError).result;
    expect(result.state).toBe("active");
    if (result.state === "active") {
      expect(result.record.lease_id).toBe(winner.lease_id);
    }
  }
}

function atomicStoreOptions(
  leaseDir: string,
  leaseId: string,
  index = 0,
): BrowserLeaseStoreOptions {
  return {
    leaseDir,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => leaseId,
    pid: 10_000 + index,
    isProcessAlive: () => true,
    mutationLockPollMs: 1,
    mutationLockTimeoutMs: 5_000,
  };
}
