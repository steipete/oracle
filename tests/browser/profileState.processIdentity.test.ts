import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: query }),
}));

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

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

test.runIf(process.platform !== "win32")(
  "normalizes localized ps output at the subprocess boundary",
  async () => {
    vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
    vi.stubEnv("LANG", "zh_CN.UTF-8");
    query.mockImplementation(
      async (_executable: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => ({
        stdout:
          options.env?.LC_ALL === "C" ? "Wed Sep 16 22:56:52 2026" : "三 9月/16 22:56:52 2026",
      }),
    );
    const { readProcessStartTimeMs } = await import("../../src/browser/profileState.js");
    await expect(readProcessStartTimeMs(process.pid)).resolves.toBe(
      Date.parse("Wed Sep 16 22:56:52 2026"),
    );
    expect(query).toHaveBeenCalledWith(
      "ps",
      ["-p", String(process.pid), "-o", "lstart="],
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: "C", LANG: "zh_CN.UTF-8" }),
      }),
    );
    expect(process.env.LC_ALL).toBe("zh_CN.UTF-8");
  },
);
