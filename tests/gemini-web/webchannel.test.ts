import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncQueue, runGeminiWebProcessSession } from "../../src/gemini-web/webchannel.js";

describe("WebChannel event queue", () => {
  afterEach(() => vi.useRealTimers());
  it("retains an event delivered after a timed-out read", async () => {
    vi.useFakeTimers();
    const queue = new AsyncQueue<string>();
    const timedOut = queue.next(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await timedOut).toBeUndefined();
    queue.push("late frame");
    expect(await queue.next(3000)).toBe("late frame");
  });
  it("propagates failure after queued partial data", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("partial");
    expect(await queue.next(3000)).toBe("partial");
    queue.fail(new Error("bad frame"));
    await expect(queue.next(3000)).rejects.toThrow("bad frame");
  });
});

describe("WebChannel transport cleanup", () => {
  afterEach(() => vi.restoreAllMocks());
  it("sanitizes a handshake network error containing sensitive request details", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://gemini.google.com/app")
        return new Response('{"d2zJAe":"AIzaTestKey"}');
      throw new Error("sensitive-token-and-cookie");
    });
    await expect(
      runGeminiWebProcessSession({
        prompt: "test",
        model: "gemini-4-argon-high",
        cookieMap: { SID: "fixture" },
      }),
    ).rejects.toThrow(/^Gemini processSession transport failed\.$/);
  });
  it("rejects attachments before contacting the service", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      runGeminiWebProcessSession({
        prompt: "test",
        model: "gemini-4-argon-high",
        cookieMap: {},
        files: ["fixture.txt"],
      }),
    ).rejects.toThrow("text-only");
    expect(fetch).not.toHaveBeenCalled();
  });
});
