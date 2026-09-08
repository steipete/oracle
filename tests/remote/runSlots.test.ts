import { expect, test, vi } from "vitest";
import { RunSlots, RunQueueFullError } from "../../src/remote/runSlots.js";

test("reserves queue capacity atomically at acquisition", async () => {
  const slots = new RunSlots(1, 1);
  const release = await slots.acquire();
  const queued = slots.acquire();
  const overflow = slots.acquire();
  await expect(overflow).rejects.toBeInstanceOf(RunQueueFullError);
  expect(slots.queuedCount).toBe(1);
  release();
  (await queued)();
  expect(slots.activeCount).toBe(0);
});

test("removes the queued abort listener when a waiter becomes active", async () => {
  const slots = new RunSlots(1, 1);
  const release = await slots.acquire();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = slots.acquire(controller.signal);
  release();
  const nextRelease = await pending;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  controller.abort();
  expect(slots.activeCount).toBe(1);
  nextRelease();
  expect(slots.activeCount).toBe(0);
});

test.each([
  [0, 1],
  [1.5, 1],
  [1, -1],
  [Number.NaN, 1],
])("rejects invalid capacity %j", (active, queued) => {
  expect(() => new RunSlots(active, queued)).toThrow(/capacity/);
});
