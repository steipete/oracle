import { describe, expect, test, vi } from "vitest";
import { createConversationUrlMonitor } from "../../src/browser/conversationUrlMonitor.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("createConversationUrlMonitor", () => {
  test("persists a conversation URL that appears after prompt submission", async () => {
    const readUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://chatgpt.com/")
      .mockResolvedValue("https://chatgpt.com/c/issue-284");
    const persistUrl = vi.fn(async () => {});
    const logger = vi.fn() as BrowserLogger;
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl,
      logger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.schedule("post-submit", 1_000)).resolves.toBe(true);

    expect(persistUrl).toHaveBeenCalledWith("https://chatgpt.com/c/issue-284");
    expect(logger).toHaveBeenCalledWith(
      "[browser] conversation url (post-submit) = https://chatgpt.com/c/issue-284",
    );
  });

  test("keeps polling through read errors until the URL appears", async () => {
    let reads = 0;
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: async () => {
        reads += 1;
        if (reads < 3) {
          throw new Error("evaluate failed");
        }
        return "https://chatgpt.com/c/recovered";
      },
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {},
      now: () => reads * 250,
    });

    await expect(monitor.update("assistant-wait", 5_000)).resolves.toBe(true);

    expect(reads).toBe(3);
    expect(persistUrl).toHaveBeenCalledWith("https://chatgpt.com/c/recovered");
  });

  test("shares one in-flight poll between background callers", async () => {
    let resolveRead: ((url: string) => void) | undefined;
    const readUrl = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl: async () => {},
      logger: vi.fn() as BrowserLogger,
    });

    const first = monitor.schedule("post-submit", 1_000);
    const second = monitor.schedule("assistant-wait", 1_000);
    expect(monitor.isInFlight()).toBe(true);
    expect(readUrl).toHaveBeenCalledTimes(1);

    resolveRead?.("https://chatgpt.com/c/shared");
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(monitor.isInFlight()).toBe(false);
  });

  test("stops a background poll when its browser run ends", async () => {
    const readUrl = vi.fn(async () => "https://chatgpt.com/");
    let monitor: ReturnType<typeof createConversationUrlMonitor>;
    monitor = createConversationUrlMonitor({
      readUrl,
      persistUrl: async () => {},
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        await monitor.stop();
      },
    });

    await expect(monitor.schedule("post-submit", 120_000)).resolves.toBe(false);
    expect(readUrl).toHaveBeenCalledTimes(1);
  });

  test("does not persist a URL read after the monitor stops", async () => {
    let resolveRead: ((url: string) => void) | undefined;
    const persistUrl = vi.fn(async () => {});
    const monitor = createConversationUrlMonitor({
      readUrl: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
      persistUrl,
      logger: vi.fn() as BrowserLogger,
    });

    const scheduled = monitor.schedule("post-submit", 1_000);
    await monitor.stop();
    resolveRead?.("https://chatgpt.com/c/late");

    await expect(scheduled).resolves.toBe(false);
    expect(persistUrl).not.toHaveBeenCalled();
  });

  test("waits for persistence already underway when stopping", async () => {
    let resolvePersist: (() => void) | undefined;
    const persistUrl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/c/persisting",
      persistUrl,
      logger: vi.fn() as BrowserLogger,
    });

    const scheduled = monitor.schedule("post-submit", 1_000);
    await vi.waitFor(() => expect(persistUrl).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePersist?.();
    await stopping;
    await expect(scheduled).resolves.toBe(true);
  });

  test("does not treat the ChatGPT root URL as a conversation", async () => {
    const persistUrl = vi.fn(async () => {});
    let now = 0;
    const monitor = createConversationUrlMonitor({
      readUrl: async () => "https://chatgpt.com/",
      persistUrl,
      logger: vi.fn() as BrowserLogger,
      wait: async () => {
        now += 250;
      },
      now: () => now,
    });

    await expect(monitor.update("assistant-timeout", 500)).resolves.toBe(false);

    expect(persistUrl).not.toHaveBeenCalled();
  });
});
