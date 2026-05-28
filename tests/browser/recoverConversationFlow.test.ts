import { beforeEach, describe, expect, test, vi } from "vitest";
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
  stopExists: false,
  state: "completed",
};
const logger = (_message: string) => {};

describe("recoverConversationTab flow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("opens the saved URL in an existing Chrome endpoint before launching another profile", async () => {
    const openChatGptTarget = vi.fn(async () => "target-1");
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const launch = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("chrome-launcher", () => ({ launch }));

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
      ref: "https://chatgpt.com/c/saved-conversation",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(recovered.chrome).toBeNull();
  });

  test("launches the stored manual-login profile when the existing endpoint is gone", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const harvestChatGptTab = vi.fn(async () => readyHarvest);
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const launch = vi.fn(async () => chrome);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("chrome-launcher", () => ({ launch }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    const recovered = await recoverConversationTab(meta, logger, {
      existingEndpoint: { host: "127.0.0.1", port: 9222 },
      readyTimeoutMs: 1,
    });

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataDir: "/tmp/recover-profile",
      }),
    );
    expect(harvestChatGptTab).toHaveBeenLastCalledWith({
      host: "127.0.0.1",
      port: 53999,
      ref: "https://chatgpt.com/c/saved-conversation",
    });
    expect(recovered.chrome).toBe(chrome);
  });

  test("kills launched Chrome when recovered content never becomes ready", async () => {
    const openChatGptTarget = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const harvestChatGptTab = vi.fn();
    const chrome = { port: 53999, kill: vi.fn(), process: { unref: vi.fn() } };
    const launch = vi.fn(async () => chrome);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      openChatGptTarget,
      harvestChatGptTab,
    }));
    vi.doMock("chrome-launcher", () => ({ launch }));

    const { recoverConversationTab } = await import("../../src/browser/recoverConversation.js");
    await expect(
      recoverConversationTab(meta, logger, {
        existingEndpoint: { host: "127.0.0.1", port: 9222 },
        readyTimeoutMs: 0,
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });
});
