import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function heldLock(kind: "empty" | "live" | "malformed") {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-lease-safety-"));
  const lock = path.join(profile, "oracle-tab-leases.lock");
  await fs.mkdir(lock);
  if (kind === "live")
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({
        id: "original-owner",
        pid: process.pid,
        createdAt: new Date().toISOString(),
        processStartedAtMs: Date.now() - process.uptime() * 1000,
      }),
    );
  if (kind === "malformed") {
    await fs.writeFile(path.join(lock, "owner.json"), "{broken");
    await fs.utimes(lock, new Date(0), new Date(0));
  }
  return { profile, lock };
}

test.each(["empty", "malformed"] as const)(
  "preserves a held %s lock instead of replacing/reaping it",
  async (kind) => {
    const { profile, lock } = await heldLock(kind);
    const identity = await fs.stat(lock);
    let acquired = false;
    const pending = acquireBrowserTabLease(profile, { maxConcurrentTabs: 2 }).then((lease) => {
      acquired = true;
      return lease;
    });
    try {
      await pause(300);
      expect(acquired).toBe(false);
      const current = await fs.stat(lock);
      expect(current.ino).toBe(identity.ino);
      if (kind === "malformed")
        expect(await fs.readFile(path.join(lock, "owner.json"), "utf8")).toBe("{broken");
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
      await (await pending).release();
      await fs.rm(profile, { recursive: true, force: true });
    }
  },
);

test("does not steal a live owner after two false native PID probes", async () => {
  const { profile, lock } = await heldLock("live");
  const kill = process.kill.bind(process);
  let falseProbes = 2;
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === process.pid && signal === 0 && falseProbes-- > 0)
      throw Object.assign(new Error("transient missing process"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  let acquired = false;
  const pending = acquireBrowserTabLease(profile, { maxConcurrentTabs: 2 }).then((lease) => {
    acquired = true;
    return lease;
  });
  try {
    await pause(300);
    expect(acquired).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")).id).toBe(
      "original-owner",
    );
  } finally {
    spy.mockRestore();
    await fs.rm(lock, { recursive: true, force: true });
    await (await pending).release();
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "retains a stale lease when independent liveness evidence survives (identity=%s)",
  async (identityAvailable) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-lease-safety-"));
    const registry = path.join(profile, "oracle-tab-leases.json");
    const foreign = {
      id: "foreign",
      pid: 32145,
      processStartedAtMs: 1000,
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(1000).toISOString(),
    };
    await fs.writeFile(registry, JSON.stringify({ version: 1, leases: [foreign] }));
    const probe = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const lease = await acquireBrowserTabLease(
      profile,
      { maxConcurrentTabs: 2 },
      {
        pid: 32146,
        now: () => 1_000_000,
        isProcessAlive: probe,
        readProcessStartTimeMs: async () => (identityAvailable ? 1000 : null),
      },
    );
    try {
      expect(
        JSON.parse(await fs.readFile(registry, "utf8")).leases.map(
          (entry: { id: string }) => entry.id,
        ),
      ).toContain("foreign");
    } finally {
      await lease.release();
      await fs.rm(profile, { recursive: true, force: true });
    }
  },
);

test.each([0, -1, 1.5])(
  "rejects invalid lease PID %s without pruning the registry",
  async (pid) => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-lease-safety-"));
    const registry = path.join(profile, "oracle-tab-leases.json");
    const original = JSON.stringify({
      version: 1,
      leases: [
        {
          id: "invalid-pid",
          pid,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    });
    await fs.writeFile(registry, original);
    try {
      await expect(acquireBrowserTabLease(profile, { maxConcurrentTabs: 2 })).rejects.toThrow(
        "invalid lease record",
      );
      expect(await fs.readFile(registry, "utf8")).toBe(original);
    } finally {
      await fs.rm(profile, { recursive: true, force: true });
    }
  },
);
