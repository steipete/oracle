import { describe, expect, test, vi } from "vitest";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";

describe("promptComposer", () => {
  test("reports dead composer during health check", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {
            value: {
              healthy: false,
              reason: "active-input-disabled",
              activeExists: true,
              activeVisible: true,
              activeDisabled: true,
              activeReadOnly: false,
              activeTagName: "textarea",
              activeRole: "textbox",
              href: "https://chatgpt.com/",
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.ensureComposerHealthy(runtime as never, (() => {}) as never),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "dead-composer" }),
    });
  });

  test("does not treat cleared composer + stop button as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: false,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("allows prompt match even if baseline turn count cannot be read", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read fails
        .mockRejectedValueOnce(new Error("turn read failed"))
        // First poll shows prompt match (baseline unknown)
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(1);
  });

  test("classifies commit timeout as dead composer when input stays inert", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 10 } })
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: false,
                assistantVisible: false,
                composerCleared: false,
                inConversation: false,
                href: "https://chatgpt.com/",
                activeInputExists: true,
                activeInputVisible: false,
                activeInputDisabled: true,
                activeInputReadOnly: false,
                activeInputValueLength: 0,
                activeInputTagName: "textarea",
                activeInputRole: "textbox",
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({
          code: "dead-composer",
          composerState: expect.objectContaining({
            activeInputDisabled: true,
            activeInputVisible: false,
          }),
        }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("treats large prompt commit timeout as prompt-too-large", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 10 } })
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: false,
                assistantVisible: false,
                composerCleared: false,
                inConversation: false,
                href: "https://chatgpt.com/",
                activeInputExists: true,
                activeInputVisible: true,
                activeInputDisabled: false,
                activeInputReadOnly: false,
                activeInputValueLength: 0,
                activeInputTagName: "textarea",
                activeInputRole: "textbox",
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "x".repeat(20_000), 150);
      const assertion = expect(promise).rejects.toMatchObject({
        details: expect.objectContaining({ code: "prompt-too-large" }),
      });
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
