import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  canonicalProfileIdentityForTest,
  hasOtherActiveBrowserTabLeases,
  normalizeMaxConcurrentTabs,
  removeRegistryLockIfOwnedForTest,
  type BrowserTabLeaseReleaseContext,
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
      const now = Date.now();
      const stale = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 500,
          staleMs: 60_000,
          sessionId: "stale-session",
        },
        { pid: 123_456, isProcessAlive: () => true, now: () => now - 61_000 },
      );

      const fresh = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 500,
          staleMs: 60_000,
          sessionId: "fresh-session",
        },
        { isProcessAlive: (pid) => pid !== 123_456, now: () => now },
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
      await expect(stale.release()).rejects.toThrow(/already lost/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed instead of treating a corrupt registry as empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-corrupt-"));
    try {
      await writeFile(path.join(dir, "oracle-tab-leases.json"), '{"version":1,"leases":', "utf8");

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 3,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/Unable to read Oracle tab lease registry/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed instead of filtering invalid lease records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-invalid-"));
    try {
      await writeFile(
        path.join(dir, "oracle-tab-leases.json"),
        JSON.stringify({ version: 1, leases: [{ id: "partial" }] }),
        "utf8",
      );

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 3,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/invalid lease record/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a registry lock only when its recorded owner is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-dead-lock-"));
    try {
      const lockDir = path.join(dir, "oracle-tab-leases.lock");
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ id: "dead-owner", pid: 99_999_999, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );

      const [first, second] = await Promise.all([
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 3,
          timeoutMs: 1000,
        }),
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 3,
          timeoutMs: 1000,
        }),
      ]);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toHaveLength(2);
      await first.release();
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a lock whose pid was reused by a different process identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-reused-pid-"));
    try {
      const lockDir = path.join(dir, "oracle-tab-leases.lock");
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({
          id: "reused-pid-owner",
          pid: process.pid,
          processStartedAtMs: 0,
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );

      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 1000,
      });
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses legacy lock creation time to detect a reused live pid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-legacy-reused-pid-"));
    try {
      const lockDir = path.join(dir, "oracle-tab-leases.lock");
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({
          id: "legacy-reused-pid-owner",
          pid: process.pid,
          createdAt: "2000-01-01T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 1000,
      });
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers an old ownerless lock left by a previous Oracle version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-ownerless-"));
    try {
      const lockDir = path.join(dir, "oracle-tab-leases.lock");
      await mkdir(lockDir);
      const old = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(lockDir, old, old);

      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 1000,
      });
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === "win32")(
    "canonicalizes Windows profile aliases before deriving the recovery mutex",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-canonical-"));
      try {
        const canonical = await canonicalProfileIdentityForTest(dir);
        const differentlyCased = await canonicalProfileIdentityForTest(dir.toUpperCase());
        const extended = await canonicalProfileIdentityForTest(`\\\\?\\${dir}`);
        expect(differentlyCased).toBe(canonical);
        expect(extended).toBe(canonical);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("does not report a lease release after registry corruption", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-release-fail-"));
    try {
      const logger = vi.fn();
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        logger,
      });
      logger.mockClear();
      await writeFile(path.join(dir, "oracle-tab-leases.json"), "not-json", "utf8");

      await expect(lease.release()).rejects.toThrow(/Unable to read Oracle tab lease registry/i);
      expect(logger).not.toHaveBeenCalledWith(
        expect.stringContaining("Released ChatGPT browser slot"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates an unverifiable registry unlock instead of leaving a silent live lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-unlock-fail-"));
    try {
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });

      await expect(
        lease.release({
          onRelease: async () => {
            await writeFile(path.join(dir, "oracle-tab-leases.lock", "owner.json"), "not-json");
          },
        }),
      ).rejects.toThrow(/Unable to verify ownership while releasing/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries transient owner reads and Windows lock-directory removal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-unlock-retry-"));
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          id: "retry-owner",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      let readAttempts = 0;
      let removeAttempts = 0;

      await expect(
        removeRegistryLockIfOwnedForTest(lockDir, "retry-owner", {
          readFileImpl: async (filePath, encoding) => {
            readAttempts += 1;
            if (readAttempts < 3) {
              throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
            }
            return readFile(filePath, encoding);
          },
          removeImpl: async (target, options) => {
            removeAttempts += 1;
            if (removeAttempts < 3) {
              throw Object.assign(new Error("temporarily locked"), { code: "EBUSY" });
            }
            await rm(target, options);
          },
        }),
      ).resolves.toBe(true);
      expect(readAttempts).toBe(3);
      expect(removeAttempts).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates exhausted registry lock-directory removal retries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-unlock-exhausted-"));
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          id: "exhausted-owner",
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      let removeAttempts = 0;

      await expect(
        removeRegistryLockIfOwnedForTest(lockDir, "exhausted-owner", {
          removeImpl: async () => {
            removeAttempts += 1;
            throw Object.assign(new Error("still locked"), { code: "EACCES" });
          },
        }),
      ).rejects.toThrow(/still locked/i);
      expect(removeAttempts).toBe(6);
      await expect(readFile(path.join(lockDir, "owner.json"), "utf8")).resolves.toContain(
        "exhausted-owner",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects other active leases before releasing a shared Chrome owner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const logger = vi.fn();
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "first-session",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "second-session",
        logger,
      });

      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(true);

      let releaseContext: BrowserTabLeaseReleaseContext | undefined;
      await second.release({
        onRelease: async (context) => {
          releaseContext = context;
        },
      });
      expect(releaseContext).toMatchObject({
        isLastLease: false,
        releasedLease: { id: second.id, sessionId: "second-session" },
        remainingLeases: [{ id: first.id, sessionId: "first-session" }],
      });
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(/release decision: isLastLease=false; remaining=1/),
      );
      expect(logger).toHaveBeenCalledWith(expect.stringContaining("first-session"));
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

  test("never prunes another controller while deciding whether release is final", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-release-fail-closed-"));
    try {
      const staleOwnerPid = 99_999_991;
      const first = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 3, timeoutMs: 500, sessionId: "stale-looking-owner" },
        { pid: staleOwnerPid, isProcessAlive: () => true },
      );
      const second = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 3, timeoutMs: 500, sessionId: "live-releaser" },
        { isProcessAlive: () => true },
      );
      let observedLastLease: boolean | undefined;

      await second.release({
        onRelease: async ({ isLastLease }) => {
          observedLastLease = isLastLease;
        },
      });

      expect(observedLastLease).toBe(false);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; pid: number }> };
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]).toMatchObject({ id: first.id, pid: staleOwnerPid });

      // A single false-negative cannot reclaim a fresh foreign lease, even at capacity.
      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            pollMs: 25,
            timeoutMs: 100,
            staleMs: 60_000,
            sessionId: "blocked-by-fresh-foreign-lease",
          },
          { isProcessAlive: (pid) => pid !== staleOwnerPid },
        ),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/i);

      const agedRegistry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { version: 1; leases: Array<{ updatedAt: string }> };
      agedRegistry.leases[0]!.updatedAt = new Date(Date.now() - 61_000).toISOString();
      await writeFile(
        path.join(dir, "oracle-tab-leases.json"),
        `${JSON.stringify(agedRegistry, null, 2)}\n`,
        "utf8",
      );

      // A later acquisition owns stale reclamation only after heartbeat grace expires.
      const replacement = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 500,
          staleMs: 60_000,
          sessionId: "replacement",
        },
        { isProcessAlive: (pid) => pid !== staleOwnerPid },
      );
      await replacement.release();
      const lostOwnerCleanup = vi.fn();
      await expect(
        first.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) lostOwnerCleanup();
          },
        }),
      ).rejects.toThrow(/already lost/i);
      expect(lostOwnerCleanup).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects updates after a controller loses ownership", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-lost-owner-"));
    try {
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
      });
      await writeFile(
        path.join(dir, "oracle-tab-leases.json"),
        `${JSON.stringify({ version: 1, leases: [] }, null, 2)}\n`,
        "utf8",
      );

      await expect(lease.update({ tabUrl: "https://chatgpt.com/c/lost" })).rejects.toThrow(
        /no longer owned/i,
      );
      await expect(lease.release()).rejects.toThrow(/already lost/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims a stale lease when its pid has been reused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-pid-reuse-"));
    try {
      const reusedPid = 99_999_992;
      const original = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500 },
        {
          pid: reusedPid,
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 1_000,
        },
      );
      const registryPath = path.join(dir, "oracle-tab-leases.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
        version: 1;
        leases: Array<{ updatedAt: string; processStartedAtMs?: number }>;
      };
      expect(registry.leases[0]?.processStartedAtMs).toBe(1_000);
      registry.leases[0]!.updatedAt = new Date(Date.now() - 61_000).toISOString();
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

      const replacement = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, staleMs: 60_000, timeoutMs: 500 },
        {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 25_000,
        },
      );
      await replacement.release();
      await expect(original.release()).rejects.toThrow(/already lost/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a stale live pid when process identity cannot be verified", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-pid-unknown-"));
    try {
      const original = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500 },
        {
          pid: 99_999_993,
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 1_000,
        },
      );
      const registryPath = path.join(dir, "oracle-tab-leases.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
        version: 1;
        leases: Array<{ updatedAt: string }>;
      };
      registry.leases[0]!.updatedAt = new Date(Date.now() - 61_000).toISOString();
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            pollMs: 25,
            staleMs: 60_000,
            timeoutMs: 100,
          },
          {
            isProcessAlive: () => true,
            readProcessStartTimeMs: async () => null,
          },
        ),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/i);
      await original.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refreshes an active lease heartbeat until release", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-heartbeat-"));
    try {
      const lease = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "heartbeat-owner" },
        { heartbeatMs: 20 },
      );
      const registryPath = path.join(dir, "oracle-tab-leases.json");
      const before = JSON.parse(await readFile(registryPath, "utf8")) as {
        leases: Array<{ updatedAt: string }>;
      };
      let after = before;
      const heartbeatDeadline = Date.now() + 2000;
      while (
        Date.parse(after.leases[0]!.updatedAt) <= Date.parse(before.leases[0]!.updatedAt) &&
        Date.now() < heartbeatDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        after = JSON.parse(await readFile(registryPath, "utf8")) as {
          leases: Array<{ updatedAt: string }>;
        };
      }
      expect(Date.parse(after.leases[0]!.updatedAt)).toBeGreaterThan(
        Date.parse(before.leases[0]!.updatedAt),
      );
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drains an in-flight heartbeat before releasing its lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-heartbeat-drain-"));
    try {
      const heartbeatLease = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 2, timeoutMs: 500, sessionId: "heartbeat-owner" },
        { heartbeatMs: 10 },
      );
      const blockingLease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "lock-holder",
      });
      let unlockRegistry!: () => void;
      let markRegistryLocked!: () => void;
      const registryLocked = new Promise<void>((resolve) => {
        markRegistryLocked = resolve;
      });
      const blockingRelease = blockingLease.release({
        onRelease: async ({ isLastLease }) => {
          expect(isLastLease).toBe(false);
          markRegistryLocked();
          await new Promise<void>((resolve) => {
            unlockRegistry = resolve;
          });
        },
      });
      await registryLocked;

      // The lock holder prevents the heartbeat update from completing, making
      // the next release exercise the in-flight heartbeat drain path.
      await new Promise((resolve) => setTimeout(resolve, 35));
      let heartbeatReleaseSettled = false;
      const heartbeatRelease = heartbeatLease.release().then(() => {
        heartbeatReleaseSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heartbeatReleaseSettled).toBe(false);

      unlockRegistry();
      await Promise.all([blockingRelease, heartbeatRelease]);
      expect(heartbeatReleaseSettled).toBe(true);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
      expect(
        (await readdir(dir)).filter((name) => name.startsWith("oracle-tab-leases.lock")),
      ).toEqual([]);
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
