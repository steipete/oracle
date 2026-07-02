import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearChatGptConversationCookies,
  syncCookies,
  ChromeCookieSyncError,
} from "../../src/browser/cookies.js";
import type { ChromeClient } from "../../src/browser/types.js";

const getCookies = vi.hoisted(() => vi.fn());
vi.mock("@steipete/sweet-cookie", () => ({ getCookies }));

const logger = vi.fn();

beforeEach(() => {
  getCookies.mockReset();
  logger.mockReset();
});

describe("clearChatGptConversationCookies", () => {
  test("deletes only ChatGPT conv cookies", async () => {
    const deleteCookies = vi.fn().mockResolvedValue(undefined);
    const Network = {
      getAllCookies: vi.fn().mockResolvedValue({
        cookies: [
          { name: "conv_key_123", domain: "chatgpt.com", path: "/" },
          { name: "conv_key_456", domain: ".chat.openai.com", path: "/" },
          { name: "__Secure-next-auth.session-token", domain: "chatgpt.com", path: "/" },
          { name: "Conversion", domain: "www.googleadservices.com", path: "/" },
          { name: "conv_tracking", domain: "example.com", path: "/" },
        ],
      }),
      deleteCookies,
    } as unknown as ChromeClient["Network"];

    const deleted = await clearChatGptConversationCookies(Network, logger);

    expect(deleted).toBe(2);
    expect(deleteCookies).toHaveBeenCalledTimes(2);
    expect(deleteCookies).toHaveBeenCalledWith({
      name: "conv_key_123",
      domain: "chatgpt.com",
      path: "/",
    });
    expect(deleteCookies).toHaveBeenCalledWith({
      name: "conv_key_456",
      domain: ".chat.openai.com",
      path: "/",
    });
    expect(logger).toHaveBeenCalledWith("[cookies] Cleared 2 stale ChatGPT conversation cookies.");
  });

  test("continues when individual stale cookie deletion fails", async () => {
    const deleteCookies = vi
      .fn()
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValueOnce(undefined);
    const Network = {
      getAllCookies: vi.fn().mockResolvedValue({
        cookies: [
          { name: "conv_key_failed", domain: "chatgpt.com", path: "/" },
          { name: "conv_key_ok", domain: "chatgpt.com", path: "/" },
        ],
      }),
      deleteCookies,
    } as unknown as ChromeClient["Network"];

    const deleted = await clearChatGptConversationCookies(Network, logger);

    expect(deleted).toBe(1);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to clear stale ChatGPT conversation cookie conv_key_failed"),
    );
    expect(logger).toHaveBeenCalledWith("[cookies] Cleared 1 stale ChatGPT conversation cookie.");
  });

  test("does not fail browser runs when cookies cannot be inspected", async () => {
    const Network = {
      getAllCookies: vi.fn().mockRejectedValue(new Error("devtools unavailable")),
      deleteCookies: vi.fn(),
    } as unknown as ChromeClient["Network"];

    const deleted = await clearChatGptConversationCookies(Network, logger);

    expect(deleted).toBe(0);
    expect(logger).toHaveBeenCalledWith(
      "[cookies] Failed to inspect ChatGPT conversation cookies: devtools unavailable",
    );
  });
});

describe("syncCookies", () => {
  test("replays cookies via DevTools Network.setCookie", async () => {
    getCookies.mockResolvedValue({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
        {
          name: "csrftoken",
          value: "xyz",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });
    const applied = await syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
    );
    expect(applied).toBe(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  test("throws when cookie load fails", async () => {
    getCookies.mockRejectedValue(new Error("boom"));
    await expect(
      syncCookies(
        { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
        "https://chatgpt.com",
        null,
        logger,
      ),
    ).rejects.toBeInstanceOf(ChromeCookieSyncError);
  });

  test("can opt into continuing on cookie failures", async () => {
    getCookies.mockRejectedValue(new Error("boom"));
    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { allowErrors: true },
    );
    expect(applied).toBe(0);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Cookie sync failed (continuing with override)"),
    );
  });

  test("retries once after a cookie read failure when wait is set", async () => {
    vi.useFakeTimers();
    getCookies.mockRejectedValueOnce(new Error("keychain locked")).mockResolvedValueOnce({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });

    const promise = syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { waitMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(1000);
    const applied = await promise;

    expect(applied).toBe(1);
    expect(getCookies).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Cookie read failed"));
    vi.useRealTimers();
  });

  test("retries once after an empty cookie read when wait is set", async () => {
    vi.useFakeTimers();
    getCookies.mockResolvedValueOnce({ cookies: [], warnings: [] }).mockResolvedValueOnce({
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });

    const promise = syncCookies(
      { setCookie } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { waitMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);
    const applied = await promise;

    expect(applied).toBe(1);
    expect(getCookies).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("No cookies found"));
    vi.useRealTimers();
  });
});
