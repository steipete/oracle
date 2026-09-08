import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

test("an interrupted owner write never publishes partial ownership and permits retry", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-init-"));
  const lock = path.join(profile, "oracle-tab-leases.lock");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (destination) => {
    await actual.writeFile(destination, "{partial");
    await expect(readFile(path.join(lock, "owner.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    throw Object.assign(new Error("interrupted owner write"), { code: "EIO" });
  });
  try {
    await expect(acquireBrowserTabLease(profile, {})).rejects.toThrow("interrupted owner write");
    expect(await readdir(profile)).toEqual([]);
    const lease = await acquireBrowserTabLease(profile, {});
    await lease.release();
  } finally {
    vi.mocked(writeFile).mockImplementation(actual.writeFile);
    await rm(profile, { recursive: true, force: true });
  }
});

test("recovers an aged ownerless lock after a crash during its temporary owner write", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "oracle-lock-crash-"));
  const lock = path.join(profile, "oracle-tab-leases.lock");
  try {
    await mkdir(lock);
    await writeFile(path.join(lock, "crashed-owner.tmp"), "{partial");
    await utimes(lock, new Date(0), new Date(0));
    const lease = await acquireBrowserTabLease(profile, {});
    await lease.release();
    expect(await readdir(profile)).toEqual(["oracle-tab-leases.json"]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
