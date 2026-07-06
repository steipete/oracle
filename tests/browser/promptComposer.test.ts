import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";

describe("promptComposer", () => {
  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
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

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "new prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commit timeout throws a structured error with probe diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 10,
        turnsCount: 10,
        userMatched: false,
        prefixMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: true,
        inConversation: false,
        editorValue: "",
        lastTurn: "previous turn text",
      };
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls + final diagnostic probe
          .mockResolvedValue({ result: { value: probe } }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as {
        name?: string;
        details?: Record<string, unknown>;
        message?: string;
      };
      expect(error.message).toMatch(/prompt did not appear/i);
      expect(error.name).toBe("BrowserAutomationError");
      expect(error.details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-commit-timeout",
        commitProbe: expect.objectContaining({
          hasNewTurn: false,
          composerCleared: true,
          turnsCount: 10,
          lastTurnLength: "previous turn text".length,
        }),
      });
      // Free text must not leak into the structured details.
      const commitProbe = error.details?.commitProbe as Record<string, unknown>;
      expect(commitProbe).not.toHaveProperty("lastTurn");
      expect(commitProbe).not.toHaveProperty("editorValue");
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

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
      );
      const assertion = expect(promise).rejects.toThrow(/after 45s/i);
      await vi.advanceTimersByTimeAsync(46_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(45_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("marks prompt submitted before commit verification finishes", async () => {
    const onPromptSubmitted = vi.fn();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: true,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptSubmitted,
      },
      "hello",
      logger as never,
    );

    expect(onPromptSubmitted).toHaveBeenCalledTimes(1);
  });
});
