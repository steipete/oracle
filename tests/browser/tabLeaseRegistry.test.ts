import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  normalizeMaxConcurrentTabs,
} from "../../src/browser/tabLeaseRegistry.js";

describe("tabLeaseRegistry", () => {
  test("normalizes the concurrent tab limit", () => {
    expect(normalizeMaxConcurrentTabs(undefined)).toBe(3);
    expect(normalizeMaxConcurrentTabs("4")).toBe(4);
    expect(normalizeMaxConcurrentTabs(0)).toBe(3);
    expect(normalizeMaxConcurrentTabs("nope")).toBe(3);
  });

  test("upgrades a version 1 registry without dropping active leases", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    const existingLease = {
      id: "existing-v1-lease",
      pid: process.pid,
      sessionId: "existing-session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeFile(
        path.join(dir, "oracle-tab-leases.json"),
        `${JSON.stringify({ version: 1, leases: [existingLease] }, null, 2)}\n`,
        "utf8",
      );

      const acquired = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "new-session",
      });
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as {
        version: number;
        leases: Array<{ id: string; sessionId?: string }>;
        waiters: unknown[];
      };

      expect(registry.version).toBe(2);
      expect(registry.leases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "existing-v1-lease", sessionId: "existing-session" }),
          expect.objectContaining({ id: acquired.id, sessionId: "new-session" }),
        ]),
      );
      expect(registry.waiters).toEqual([]);
      await acquired.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("holds a serialized slot until the active run releases it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        timeoutMs: 500,
        sessionId: "streaming-session",
      });
      let secondAcquired = false;
      const secondPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        timeoutMs: 1000,
        sessionId: "queued-session",
      }).then((lease) => {
        secondAcquired = true;
        return lease;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondAcquired).toBe(false);

      await first.release();
      const second = await secondPromise;
      expect(secondAcquired).toBe(true);
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const logger = vi.fn();
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const third = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      let resolved = false;
      const fourthPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
        logger,
      }).then((lease) => {
        resolved = true;
        return lease;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(resolved).toBe(false);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Waiting for ChatGPT browser slot"),
      );

      await first.release();
      const fourth = await fourthPromise;
      expect(resolved).toBe(true);

      await second.release();
      await third.release();
      await fourth.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves four independent clients in FIFO order without starving an older waiter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    const waitForQueuedSession = async (sessionId: string) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const registry = JSON.parse(
          await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
        ) as { waiters?: Array<{ sessionId?: string }> };
        if (registry.waiters?.some((waiter) => waiter.sessionId === sessionId)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${sessionId} to enter the queue`);
    };

    try {
      const acquired: string[] = [];
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        sessionId: "client-b",
      });
      acquired.push("client-b");

      const startQueuedClient = (sessionId: string) =>
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 25,
          sessionId,
        }).then((lease) => {
          acquired.push(sessionId);
          return lease;
        });

      const clientA = startQueuedClient("client-a");
      await waitForQueuedSession("client-a");
      const clientC = startQueuedClient("client-c");
      await waitForQueuedSession("client-c");
      const clientD = startQueuedClient("client-d");
      await waitForQueuedSession("client-d");

      await first.release();
      const leaseA = await clientA;
      expect(acquired).toEqual(["client-b", "client-a"]);
      await leaseA.release();

      const leaseC = await clientC;
      expect(acquired).toEqual(["client-b", "client-a", "client-c"]);
      await leaseC.release();

      const leaseD = await clientD;
      expect(acquired).toEqual(["client-b", "client-a", "client-c", "client-d"]);
      await leaseD.release();

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[]; waiters: unknown[] };
      expect(registry.leases).toEqual([]);
      expect(registry.waiters).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes a waiter after its independent queue budget expires", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const active = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        sessionId: "active",
      });
      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          timeoutMs: 75,
          pollMs: 25,
          sessionId: "expiring-waiter",
        }),
      ).rejects.toThrow(/timed out waiting/i);

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { waiters: Array<{ sessionId?: string }> };
      expect(registry.waiters).toEqual([]);
      await active.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops stale leases owned by dead pids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const stale = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "stale-session" },
        { pid: 123_456, isProcessAlive: () => true },
      );
      await stale.update({ chromeTargetId: "target-stale" });

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "fresh-session" },
        { isProcessAlive: (pid) => pid !== 123_456 },
      );
      await fresh.update({ chromeTargetId: "target-fresh", tabUrl: "https://chatgpt.com/c/1" });

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string; chromeTargetId?: string; tabUrl?: string }> };
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]).toMatchObject({
        sessionId: "fresh-session",
        chromeTargetId: "target-fresh",
        tabUrl: "https://chatgpt.com/c/1",
      });

      await fresh.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects other active leases before releasing a shared Chrome owner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "first-session",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "second-session",
      });

      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(true);

      await second.release();
      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(false);

      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps shared Chrome alive while a queued client is waiting for handoff", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const active = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        sessionId: "active-session",
      });
      const queuedPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        sessionId: "queued-session",
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const registry = JSON.parse(
          await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
        ) as { waiters?: Array<{ sessionId?: string }> };
        if (registry.waiters?.some((waiter) => waiter.sessionId === "queued-session")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(await hasOtherActiveBrowserTabLeases(dir, active.id)).toBe(true);
      await active.release();
      const queued = await queuedPromise;
      await queued.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
