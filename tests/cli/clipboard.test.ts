import { beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard } from "../../src/cli/clipboard.ts";

const clipboardWrite = vi.hoisted(() => vi.fn());

vi.mock("clipboardy", () => ({
  default: {
    write: clipboardWrite,
  },
}));

function overrideProcessValue(name: "arch" | "platform", value: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, {
    configurable: true,
    value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, name, descriptor);
    }
  };
}

describe("copyToClipboard", () => {
  beforeEach(() => {
    clipboardWrite.mockReset();
  });

  test("returns success when clipboardy.write resolves", async () => {
    clipboardWrite.mockResolvedValue(undefined);
    const result = await copyToClipboard("hello");
    expect(result).toEqual({ success: true, command: "clipboardy" });
    expect(clipboardWrite).toHaveBeenCalledWith("hello");
  });

  test("returns failure when clipboardy.write throws", async () => {
    const error = new Error("boom");
    clipboardWrite.mockRejectedValue(error);
    const result = await copyToClipboard("hi");
    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
  });

  test("coerces non-string input rejection from clipboardy", async () => {
    const typeError = new TypeError("Expected a string");
    clipboardWrite.mockRejectedValue(typeError);
    const result = await copyToClipboard(123 as unknown as string);
    expect(result.success).toBe(false);
    expect(result.error).toBe(typeError);
  });

  test("adds /usr/sbin before loading clipboardy on Intel macOS", async () => {
    const restorePlatform = overrideProcessValue("platform", "darwin");
    const restoreArch = overrideProcessValue("arch", "x64");
    vi.stubEnv("PATH", "/usr/bin:/bin");
    clipboardWrite.mockResolvedValue(undefined);

    try {
      const result = await copyToClipboard("hello");

      expect(result.success).toBe(true);
      expect(process.env.PATH?.split(":")[0]).toBe("/usr/sbin");
    } finally {
      restoreArch();
      restorePlatform();
      vi.unstubAllEnvs();
    }
  });
});
