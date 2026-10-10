import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  readChromePid: vi.fn(),
  readProcessStartTimeMs: vi.fn(),
  terminateRecordedChromeForProfile: vi.fn(),
}));
vi.mock("../../src/browser/profileState.js", () => state);
import {
  preserveRecoveryChrome,
  recordRecoveryChromeOwnership,
  terminateRecoveryChrome,
} from "../../src/browser/recoveryChromeLifecycle.js";
const dirs: string[] = [];
const logger = (_message: string) => {};
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe("recovery Chrome ownership", () => {
  test("transfers cleanup to the last recovery but never claims a borrowed browser", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-owner-"));
    dirs.push(dir);
    state.readChromePid.mockResolvedValue(123);
    state.readProcessStartTimeMs.mockResolvedValue(456);
    state.terminateRecordedChromeForProfile.mockResolvedValue(true);
    expect(await terminateRecoveryChrome(dir, logger)).toBe(false);
    expect(state.terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    await recordRecoveryChromeOwnership(dir, 123, 0);
    expect(await terminateRecoveryChrome(dir, logger)).toBe(true);
    expect(state.terminateRecordedChromeForProfile).toHaveBeenCalledOnce();
    await expect(readFile(path.join(dir, "oracle-recovery-chrome.json"))).rejects.toThrow();
  });
  test("a keep-browser participant preserves the shared process for later recoveries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-owner-"));
    dirs.push(dir);
    state.readChromePid.mockResolvedValue(123);
    state.readProcessStartTimeMs.mockResolvedValue(456);
    await recordRecoveryChromeOwnership(dir, 123);
    await preserveRecoveryChrome(dir);
    expect(await terminateRecoveryChrome(dir, logger)).toBe(false);
    expect(state.terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
  test("keeps a browser when preservation precedes delayed ownership publication", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-owner-"));
    dirs.push(dir);
    let finish!: (value: number) => void;
    state.readProcessStartTimeMs.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    state.readChromePid.mockResolvedValue(123);
    const recording = recordRecoveryChromeOwnership(dir, 123);
    await preserveRecoveryChrome(dir);
    finish(456);
    await recording;
    state.readProcessStartTimeMs.mockResolvedValue(456);
    expect(await terminateRecoveryChrome(dir, logger)).toBe(false);
    expect(state.terminateRecordedChromeForProfile).not.toHaveBeenCalled();
  });
  test.each(["pid", "startedAt", "malformed"])(
    "preserves a replacement browser with mismatched %s",
    async (changed) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-owner-"));
      dirs.push(dir);
      state.readChromePid.mockResolvedValue(123);
      state.readProcessStartTimeMs.mockResolvedValue(456);
      await recordRecoveryChromeOwnership(dir, 123);
      if (changed === "pid") state.readChromePid.mockResolvedValue(124);
      if (changed === "startedAt") state.readProcessStartTimeMs.mockResolvedValue(457);
      if (changed === "malformed")
        await writeFile(path.join(dir, "oracle-recovery-chrome.json"), "null");
      expect(await terminateRecoveryChrome(dir, logger)).toBe(false);
      expect(state.terminateRecordedChromeForProfile).not.toHaveBeenCalled();
    },
  );
});
