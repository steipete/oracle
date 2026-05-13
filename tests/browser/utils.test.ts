import { describe, expect, test, vi } from "vitest";
import {
  parseDuration,
  estimateTokenCount,
  delay,
  withRetries,
  normalizeChatgptUrl,
} from "../../src/browser/utils.js";

describe("parseDuration", () => {
  test.each([
    ["500ms", 1234, 500],
    ["5s", 100, 5000],
    ["2m", 100, 120000],
    ["1h", 0, 3_600_000],
    ["3m10s", 0, 190_000],
    ["1h2m1s", 0, 3_721_000],
    ["1m250ms", 0, 60_250],
    [" 1H ", 0, 3_600_000],
    ["42", 0, 42],
    ["0m0s", 999, 0],
    ["0s0ms", 999, 0],
  ])("parses %s with fallback %d", (input, fallback, expected) => {
    expect(parseDuration(input, fallback)).toBe(expected);
  });

  test("falls back for invalid input", () => {
    expect(parseDuration("oops", 987)).toBe(987);
  });

  test.each(["1mgarbage2s", "prefix1s", "1s suffix", "1m-2s"])(
    "falls back when invalid text appears between duration parts: %s",
    (input) => {
      expect(parseDuration(input, 987)).toBe(987);
    },
  );
});

describe("estimateTokenCount", () => {
  test("handles empty text", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  test("estimates based on words and chars", () => {
    const short = "one two three four";
    expect(estimateTokenCount(short)).toBeGreaterThan(0);
    const long = "a".repeat(400);
    expect(estimateTokenCount(long)).toBeGreaterThan(estimateTokenCount(short));
  });
});

describe("delay", () => {
  test("resolves after requested time", async () => {
    vi.useFakeTimers();
    const pending = delay(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("withRetries", () => {
  test("retries failing tasks before succeeding", async () => {
    let attempt = 0;
    const result = await withRetries(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error("nope");
        }
        return "done";
      },
      { retries: 3, delayMs: 1 },
    );
    expect(result).toBe("done");
    expect(attempt).toBe(3);
  });
});

describe("normalizeChatgptUrl", () => {
  test("normalizes supported ChatGPT hosts", () => {
    expect(normalizeChatgptUrl("chatgpt.com/g/g-p-foo/project", "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/g/g-p-foo/project",
    );
    expect(normalizeChatgptUrl("https://chat.openai.com/c/abc", "https://chatgpt.com/")).toBe(
      "https://chat.openai.com/c/abc",
    );
  });

  test.each([
    "http://chatgpt.com/",
    "https://example.com/",
    "https://chatgpt.com.evil.test/",
    "https://chatgpt.com@evil.test/",
    "https://user:pass@chatgpt.com/",
    "https://chatgpt.com:444/",
    "https://chatgpt.com/path\nInjected: value",
  ])("rejects unsafe ChatGPT URL: %s", (input) => {
    expect(() => normalizeChatgptUrl(input, "https://chatgpt.com/")).toThrow(
      /ChatGPT URL|host|protocol/i,
    );
  });
});
