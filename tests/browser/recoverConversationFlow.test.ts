import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";

const meta = {
  id: "sess-recover",
  mode: "browser",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      tabUrl: "https://chatgpt.com/c/saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const readyHarvest = {
  authenticated: true,
  assistantCount: 1,
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  stopExists: false,
  lastAssistantText: "Recovered answer",
  lastAssistantMarkdown: "Recovered answer",
  lastAssistantSnippet: "Recovered answer",
  state: "completed",
};
const logger = (_message: string) => {};

describe("recoverConversationTab flow", () => {
  let otherLeasesRemain = false;
  const terminateRecorded = vi.fn(async () => false);
  beforeEach(() => {
    otherLeasesRemain = false;
    terminateRecorded.mockReset().mockResolvedValue(false);
    vi.doMock("../../src/browser/recoveryChromeLifecycle.js", () => ({
      recordRecoveryChromeOwnership: vi.fn(async () => {}),
      preserveRecoveryChrome: vi.fn(async () => {}),
      terminateRecoveryChrome: terminateRecorded,
    }));
    vi.doMock("../../src/browser/tabLeaseRegistry.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/browser/tabLeaseRegistry.js")>()),
      acquireBrowserTabLease: vi.fn(async () => ({
        update: vi.fn(),
        release: async ({
          onRelease,
        }: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> } = {}) =>
          onRelease?.({ isLastLease: !otherLeasesRemain }),
      })),
    }));
    vi.resetModules();
    // These one-millisecond budgets exercise branches, not scheduler performance.
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens the saved URL in an existing Chrome endpoint before launching another profile", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualLoginChromeForRun = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(openChatGptTarget).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      url: "https://chatgpt.com/c/saved-conversation",
    });
    expect(harvestChatGptTab).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      ref: "target-1",
    });
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
    expect(recovered.ref).toBe("target-1");
    expect(recovered.chrome).toBeNull();
    await recovered.release();
    expect(terminateRecorded).toHaveBeenCalledOnce();
  });

  test.each([
    { keepBrowser: false, reused: false, others: false, recorded: true, kills: 0 },
    { keepBrowser: true, reused: false, others: false, recorded: false, kills: 0 },
    { keepBrowser: false, reused: true, others: false, recorded: false, kills: 0 },
    { keepBrowser: false, reused: true, others: false, recorded: true, kills: 0 },
    { keepBrowser: false, reused: false, others: true, recorded: false, kills: 0 },
  ])(
    "releases recovery Chrome with ownership policy %j",
    async ({ keepBrowser, reused, others, recorded, kills }) => {
      otherLeasesRemain = others;
      terminateRecorded.mockResolvedValue(recorded);
      const openChatGptTarget = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce("target-2");
      const harvestChatGptTab = vi.fn(async () => readyHarvest);
      const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
      const acquireManualLoginChromeForRun = vi.fn(async () => ({
        chrome,
        reusedChrome: reused ? chrome : null,
      }));

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        extractConversationIdFromUrl: (url: string) =>
          url.includes("/c/") ? url.split("/c/")[1] : null,
        openChatGptTarget,
        harvestChatGptTab,
      }));
      vi.doMock("../../src/browser/index.js", () => ({
        acquireManualLoginChromeForRun,
        isImageOnlyUiChromeText: () => false,
      }));

      const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
      const recovered = await recoverConversationTab(
        { ...meta, browser: { ...meta.browser, config: { ...meta.browser?.config, keepBrowser } } },
        logger,
        {
          existingEndpoint: { host: "127.0.0.1", port: 9222 },
          readyTimeoutMs: 1,
        },
      );

      expect(acquireManualLoginChromeForRun).toHaveBeenCalledWith(
        "/tmp/recover-profile",
        expect.objectContaining({ manualLogin: true }),
        logger,
        "sess-recover",
        {},
      );
      expect(harvestChatGptTab).toHaveBeenLastCalledWith({
        host: "127.0.0.1",
        port: 53999,
        ref: "target-2",
      });
      expect(recovered.ref).toBe("target-2");
      expect(recovered.chrome).toBe(chrome);
      await recovered.release();
      expect(chrome.kill).toHaveBeenCalledTimes(kills);
      expect(terminateRecorded).toHaveBeenCalledTimes(!keepBrowser && !others ? 1 : 0);
    },
  );

  test("does not require a local profile when reopening through a recorded endpoint", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const acquireManualLoginChromeForRun = vi.fn();
    const remoteMeta = {
      ...meta,
      browser: {
        config: {},
        runtime: {
          tabUrl: "https://chatgpt.com/c/saved-conversation",
          chromeHost: "127.0.0.1",
          chromePort: 9222,
        },
      },
    } as unknown as SessionMetadata;

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(remoteMeta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(recovered.chrome).toBeNull();
    expect(acquireManualLoginChromeForRun).not.toHaveBeenCalled();
  });

  test("kills launched Chrome when recovered content never becomes ready", async () => {
    const openChatGptTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce("target-2");
    const harvestChatGptTab = vi.fn();
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const acquireManualLoginChromeForRun = vi.fn(async () => ({ chrome }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: { host: "127.0.0.1", port: 9222 },
        readyTimeoutMs: 0,
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(terminateRecorded).toHaveBeenCalledOnce();
    expect(chrome.kill).not.toHaveBeenCalled();
  });

  test("kills launched Chrome when opening the recovery target fails", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("CDP.New failed");
    });
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const acquireManualLoginChromeForRun = vi.fn(async () => ({ chrome }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      openChatGptTarget,
      harvestChatGptTab: vi.fn(),
    }));
    vi.doMock("../../src/browser/index.js", () => ({
      acquireManualLoginChromeForRun,
      isImageOnlyUiChromeText: () => false,
    }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/CDP.New failed/);

    expect(terminateRecorded).toHaveBeenCalledOnce();
    expect(chrome.kill).not.toHaveBeenCalled();
  });
});
