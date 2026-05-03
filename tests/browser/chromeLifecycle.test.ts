import { beforeEach, describe, expect, test, vi } from "vitest";

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpCreateTargetMock = vi.fn();
const cdpClientCloseMock = vi.fn();
const cdpListMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe("registerTerminationHooks", () => {
  test("clears stale DevToolsActivePort hints when preserving userDataDir", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);

    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const logger = vi.fn();
    const userDataDir = "/tmp/oracle-manual-login-profile";

    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      logger,
      {
        isInFlight: () => false,
        preserveUserDataDir: true,
      },
    );

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));

    removeHooks();

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, { lockRemovalMode: "never" });
  });
});

describe("connectWithNewTab", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpCreateTargetMock.mockReset();
    cdpClientCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  test("falls back to default target when new tab cannot be opened", async () => {
    cdpMock.mockResolvedValueOnce({
      Target: { createTarget: cdpCreateTargetMock.mockRejectedValue(new Error("boom")) },
      close: cdpClientCloseMock,
    });
    cdpNewMock.mockRejectedValue(new Error("boom"));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpCreateTargetMock).toHaveBeenCalledWith({
      url: "about:blank",
      background: false,
      focus: false,
    });
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222 });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open isolated browser tab"),
    );
  });

  test("closes unused tab when attach fails", async () => {
    cdpMock
      .mockResolvedValueOnce({
        Target: { createTarget: cdpCreateTargetMock.mockResolvedValue({ targetId: "target-1" }) },
        close: cdpClientCloseMock,
      })
      .mockRejectedValueOnce(new Error("attach fail"))
      .mockResolvedValueOnce({});
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, id: "target-1" });
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to attach to isolated browser tab"),
    );
  });

  test("throws when strict mode disallows fallback", async () => {
    cdpMock.mockResolvedValueOnce({
      Target: { createTarget: cdpCreateTargetMock.mockRejectedValue(new Error("boom")) },
      close: cdpClientCloseMock,
    });
    cdpNewMock.mockRejectedValue(new Error("boom"));

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await expect(
      connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false }),
    ).rejects.toThrow(/isolated browser tab/i);
    expect(cdpMock).toHaveBeenCalledTimes(1);
  });

  test("returns isolated target when attach succeeds", async () => {
    cdpMock
      .mockResolvedValueOnce({
        Target: { createTarget: cdpCreateTargetMock.mockResolvedValue({ targetId: "target-2" }) },
        close: cdpClientCloseMock,
      })
      .mockResolvedValueOnce({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("target-2");
    expect(cdpCreateTargetMock).toHaveBeenCalledWith({
      url: "about:blank",
      background: false,
      focus: false,
    });
    expect(cdpNewMock).not.toHaveBeenCalled();
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-2" });
  });

  test("closes launch-created blank tab after isolated target attaches", async () => {
    cdpMock
      .mockResolvedValueOnce({
        Target: { createTarget: cdpCreateTargetMock.mockResolvedValue({ targetId: "target-2" }) },
        close: cdpClientCloseMock,
      })
      .mockResolvedValueOnce({});
    cdpListMock.mockResolvedValue([
      { id: "target-1", type: "page", url: "about:blank" },
      { id: "target-2", type: "page", url: "about:blank" },
      { id: "target-3", type: "page", url: "https://chatgpt.com/" },
    ]);
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("target-2");
    expect(cdpListMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222 });
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, id: "target-1" });
    expect(cdpCloseMock).not.toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "target-3",
    });
  });
});
