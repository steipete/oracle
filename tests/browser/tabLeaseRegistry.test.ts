import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  test("runs cleanup exactly once when concurrent runs release their final lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const firstCleanup = vi.fn(async () => undefined);
      const secondCleanup = vi.fn(async () => undefined);

      await Promise.all([
        first.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await firstCleanup();
          },
        }),
        second.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await secondCleanup();
          },
        }),
      ]);

      expect(firstCleanup.mock.calls.length + secondCleanup.mock.calls.length).toBe(1);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks a new lease until final-lease cleanup completes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      let finishCleanup!: () => void;
      const cleanupStarted = new Promise<void>((resolveStarted) => {
        void current.release({
          onRelease: async ({ isLastLease }) => {
            expect(isLastLease).toBe(true);
            resolveStarted();
            await new Promise<void>((resolveCleanup) => {
              finishCleanup = resolveCleanup;
            });
          },
        });
      });
      await cleanupStarted;

      let acquired = false;
      const nextPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
      }).then((lease) => {
        acquired = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(acquired).toBe(false);

      finishCleanup();
      const next = await nextPromise;
      expect(acquired).toBe(true);
      await next.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tab-lease registry integrity", () => {
  // These three properties all protect the same thing: `isLastLease` and
  // `hasOtherActiveBrowserTabLeases` decide whether a run may close tabs and
  // terminate the Chrome that peers are using. Any path that turns "I don't know"
  // into "nobody is here" is a path to killing somebody else's run.
  test("a corrupt registry is an error, not an empty lease list", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const lease = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 3, timeoutMs: 500 });
      await writeFile(path.join(dir, "oracle-tab-leases.json"), "{ truncated", "utf8");
      await expect(hasOtherActiveBrowserTabLeases(dir, "some-other-lease")).rejects.toThrow(
        /unreadable/i,
      );
      await writeFile(
        path.join(dir, "oracle-tab-leases.json"),
        JSON.stringify({ version: 1, leases: [] }),
        "utf8",
      );
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing registry is simply nobody here", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      await expect(hasOtherActiveBrowserTabLeases(dir, "lease-a")).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the registry is replaced atomically and leaves no temp files behind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 3, timeoutMs: 500 });
      const second = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 3, timeoutMs: 500 });
      const raw = await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8");
      expect(JSON.parse(raw).leases).toHaveLength(2);
      await second.release();
      await first.release();
      const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp."));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two leases from this same process coexist and both stay live", async () => {
    // The multi-holder case a single-process server depends on: same pid, two
    // slots, neither pruned as stale by the other.
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const a = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 4, timeoutMs: 500 });
      const b = await acquireBrowserTabLease(dir, { maxConcurrentTabs: 4, timeoutMs: 500 });
      await expect(hasOtherActiveBrowserTabLeases(dir, a.id)).resolves.toBe(true);
      await expect(hasOtherActiveBrowserTabLeases(dir, b.id)).resolves.toBe(true);
      await b.release();
      await expect(hasOtherActiveBrowserTabLeases(dir, a.id)).resolves.toBe(false);
      await a.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
