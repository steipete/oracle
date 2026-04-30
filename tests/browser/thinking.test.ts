import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatThinkingLog,
  formatThinkingWaitingLog,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "../../src/browser/index.js";
import type { ChromeClient } from "../../src/browser/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatThinkingLog", () => {
  test("renders thinking heartbeat without emoji", () => {
    const line = formatThinkingLog(0, 300_000, "planning", "");
    expect(line).toBe("[browser] ChatGPT thinking - 5m 0s elapsed; status=active; source=inline");
    expect(line).not.toMatch(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u);
  });

  test("renders sidecar progress and unchanged duration", () => {
    const line = formatThinkingLog(
      0,
      1_200_000,
      { message: "thinking sidecar active", source: "sidecar", progressPercent: 42.4 },
      "",
      61_000,
    );
    expect(line).toBe(
      "[browser] ChatGPT thinking - 42% UI progress, 20m 0s elapsed; status=thinking sidecar active; last change 1m 1s ago; source=sidecar",
    );
  });

  test("caps UI progress at 100%", () => {
    const line = formatThinkingLog(
      0,
      1_200_000,
      { message: "finishing", source: "sidecar", progressPercent: 124 },
      "",
    );
    expect(line).toContain("100% UI progress");
  });

  test("adds a stale hint when UI progress does not change for a long time", () => {
    const line = formatThinkingLog(
      0,
      900_000,
      { message: "active", source: "sidecar", progressPercent: 42 },
      "",
      10 * 60_000,
    );
    expect(line).toContain("stale-hint=no UI progress change");
  });

  test("renders waiting heartbeat when no status is visible", () => {
    const line = formatThinkingWaitingLog(0, 30_000);
    expect(line).toBe(
      "[browser] Waiting for ChatGPT response - 30s elapsed; no thinking status detected yet.",
    );
  });

  test("redacts long thinking text to avoid logging reasoning content", () => {
    expect(
      sanitizeThinkingText(
        "Pro thinking: I will first inspect the entire codebase, then reason through every possible selector failure mode before producing a patch.",
      ),
    ).toBe("active");
    expect(sanitizeThinkingText("Pro thinking - planning")).toBe("active");
    expect(sanitizeThinkingText("Thinking: check auth before tests")).toBe("active");
  });

  test("normalizes sidecar progress snapshots from the browser", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            message: "thinking sidecar active",
            source: "sidecar",
            progressPercent: 42.4,
            panelVisible: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readThinkingStatusForTest(runtime)).resolves.toEqual({
      message: "thinking sidecar active",
      source: "sidecar",
      progressPercent: 42.4,
      panelOpened: false,
      panelVisible: true,
    });
  });

  test("redacts short browser status snapshots before logging", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: "Thinking: check auth before tests" },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readThinkingStatusForTest(runtime)).resolves.toEqual({
      message: "active",
      source: "inline",
    });
  });

  test("skips heartbeat logging when runtime evaluation fails", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockRejectedValue(new Error("target closed")),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 1000,
      now: () => 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(logger).not.toHaveBeenCalled();

    stop();
  });

  test("does not log an in-flight heartbeat after stop", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    let resolveEvaluate: (value: { result: { value: string } }) => void = () => {};
    const runtime = {
      evaluate: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveEvaluate = resolve;
          }),
      ),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 1000,
      now: () => 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    resolveEvaluate({ result: { value: "active" } });
    await vi.runOnlyPendingTimersAsync();

    expect(logger).not.toHaveBeenCalled();
  });

  test("uses the configured heartbeat interval", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const logger = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "planning" } }),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 5000,
      now: () => nowMs,
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(logger).not.toHaveBeenCalled();

    nowMs = 5000;
    await vi.advanceTimersByTimeAsync(1);
    expect(logger).toHaveBeenCalledTimes(1);

    stop();
  });
});
