import { beforeEach, expect, test, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: query }),
}));

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
});

test("retries a failed self-identity probe and caches only the successful result", async () => {
  query.mockRejectedValueOnce(new Error("PowerShell timed out"));
  query.mockResolvedValue({ stdout: "2026-09-11T12:00:00.000Z" });
  const { readProcessStartTimeMs } = await import("../../src/browser/profileState.js");

  await expect(readProcessStartTimeMs(process.pid)).resolves.toBeNull();
  const expected = Date.parse("2026-09-11T12:00:00.000Z");
  await expect(readProcessStartTimeMs(process.pid)).resolves.toBe(expected);
  await expect(readProcessStartTimeMs(process.pid)).resolves.toBe(expected);
  expect(query).toHaveBeenCalledTimes(2);
});

test("shares an in-flight self probe, then retries an unparseable result", async () => {
  let complete!: (value: { stdout: string }) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const { readProcessStartTimeMs } = await import("../../src/browser/profileState.js");
  const first = readProcessStartTimeMs(process.pid);
  const second = readProcessStartTimeMs(process.pid);
  expect(query).toHaveBeenCalledTimes(1);
  complete({ stdout: "" });
  await expect(Promise.all([first, second])).resolves.toEqual([null, null]);

  query.mockResolvedValue({ stdout: "2026-09-11T12:00:00.000Z" });
  await expect(readProcessStartTimeMs(process.pid)).resolves.toBe(
    Date.parse("2026-09-11T12:00:00.000Z"),
  );
  expect(query).toHaveBeenCalledTimes(2);
});

test("never caches a peer identity because its PID may be reused", async () => {
  query.mockResolvedValueOnce({ stdout: "2026-09-11T12:00:00.000Z" });
  query.mockResolvedValueOnce({ stdout: "2026-09-11T13:00:00.000Z" });
  const { readProcessStartTimeMs } = await import("../../src/browser/profileState.js");
  await expect(readProcessStartTimeMs(process.pid + 1)).resolves.toBe(
    Date.parse("2026-09-11T12:00:00.000Z"),
  );
  await expect(readProcessStartTimeMs(process.pid + 1)).resolves.toBe(
    Date.parse("2026-09-11T13:00:00.000Z"),
  );
  expect(query).toHaveBeenCalledTimes(2);
});
