import { expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrowserCancellation, withoutBrowserCancellation } from "../../src/browser/cancellation.js";
import { delay } from "../../src/browser/utils.js";
import { acquireBrowserTabLease } from "../../src/browser/tabLeaseRegistry.js";
import { acquireProfileRunLock } from "../../src/browser/profileState.js";
import { runBrowserMode, __test__ } from "../../src/browser/index.js";

test("an already aborted browser call does not attempt direct CDP setup", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runBrowserMode({
      prompt: "synthetic",
      signal: controller.signal,
      config: { remoteChrome: { host: "127.0.0.1", port: 1 } },
    }),
  ).rejects.toMatchObject({ name: "BrowserRunCancelledError" });
});

test("cleans a late resource without cancelling its cleanup", async () => {
  const controller = new AbortController();
  const scope = new BrowserCancellation(controller.signal);
  let finish!: (value: string) => void;
  const cleanup = vi.fn(async () => {
    await delay(1);
  });
  const pending = scope.run(() =>
    scope.acquire(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      cleanup,
    ),
  );
  const rejected = expect(pending).rejects.toMatchObject({ name: "BrowserRunCancelledError" });
  controller.abort();
  await rejected;
  finish("late-owned-resource");
  await vi.waitFor(() => expect(cleanup).toHaveResolved());
  expect(cleanup).toHaveBeenCalledExactlyOnceWith("late-owned-resource");
  scope.dispose();
});

test("cancellation reaches polling without affecting another run or cleanup", async () => {
  const controller = new AbortController();
  const scope = new BrowserCancellation(controller.signal);
  const evaluate = vi.fn(async () => undefined);
  const client = scope.client({ Runtime: { evaluate }, close: async () => {} } as never);
  const polling = scope.run(async () => {
    await client.Runtime.evaluate({ expression: "1" }).catch(() => undefined);
    await delay(10000);
  });
  const rejected = expect(polling).rejects.toBeDefined();
  controller.abort();
  await rejected;
  await withoutBrowserCancellation(() => delay(1));
  await expect(client.Runtime.evaluate({ expression: "2" })).rejects.toMatchObject({
    name: "BrowserRunCancelledError",
  });
  expect(evaluate).toHaveBeenCalledOnce();
  await client.close();
  scope.dispose();
});

test("cancelled owned targets close even when the browser is kept; borrowed targets survive", () => {
  expect(
    __test__.shouldCloseOwnedRunTargetAfterRun({
      runStatus: "cancelled",
      ownsTarget: true,
      keepBrowser: true,
    }),
  ).toBe(false);
  expect(
    __test__.shouldCloseOwnedRunTargetAfterRun({
      runStatus: "cancelled",
      ownsTarget: true,
      keepBrowser: true,
      closeOwnedTabOnCancel: true,
    }),
  ).toBe(true);
  expect(
    __test__.shouldCloseOwnedRunTargetAfterRun({
      runStatus: "cancelled",
      ownsTarget: false,
      keepBrowser: false,
    }),
  ).toBe(false);
});

test("cancelled tab and profile waiters never steal their owners' locks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-cancel-locks-"));
  const owner = await acquireBrowserTabLease(root, { maxConcurrentTabs: 1 });
  const profile = await acquireProfileRunLock(root, { timeoutMs: 1000 });
  const controller = new AbortController();
  const tab = acquireBrowserTabLease(root, { maxConcurrentTabs: 1, signal: controller.signal });
  const lock = acquireProfileRunLock(root, { timeoutMs: 10000, signal: controller.signal });
  const assertions = [expect(tab).rejects.toBeDefined(), expect(lock).rejects.toBeDefined()];
  controller.abort();
  await Promise.all(assertions);
  try {
    const registry = JSON.parse(
      await fs.readFile(path.join(root, "oracle-tab-leases.json"), "utf8"),
    );
    expect(registry.leases.map((entry: { id: string }) => entry.id)).toEqual([owner.id]);
    expect(JSON.parse(await fs.readFile(profile!.path, "utf8")).lockId).toBe(profile?.lockId);
  } finally {
    await owner.release();
    await profile?.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cleanup CDP calls survive abort while ordinary calls remain cancelled", async () => {
  const controller = new AbortController();
  const scope = new BrowserCancellation(controller.signal);
  const evaluate = vi.fn(async () => ({ result: { value: true } }));
  const client = scope.client({ Runtime: { evaluate } } as never);
  controller.abort();
  try {
    await expect(
      withoutBrowserCancellation(() => client.Runtime.evaluate({ expression: "cleanup" })),
    ).resolves.toMatchObject({ result: { value: true } });
    await expect(client.Runtime.evaluate({ expression: "ordinary" })).rejects.toMatchObject({
      name: "BrowserRunCancelledError",
    });
    expect(evaluate).toHaveBeenCalledExactlyOnceWith({ expression: "cleanup" });
  } finally {
    scope.dispose();
  }
});
