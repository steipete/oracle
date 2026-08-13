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

function submissionStateExpression(node: object) {
  class FakeTextArea {}
  class FakeInput {}
  let currentNode = node;
  const document = {
    querySelector: () => currentNode,
  };
  const setNode = (nextNode: object) => {
    currentNode = nextNode;
  };
  const evaluate = (expression: string) =>
    Function(
      "document",
      "HTMLTextAreaElement",
      "HTMLInputElement",
      `return ${expression};`,
    )(document, FakeTextArea, FakeInput) as {
      submissionValue?: string;
      submissionStateKnown?: boolean;
    };
  return { evaluate, FakeTextArea, FakeInput, setNode };
}

function submissionRuntime(node: object, probe = submissionStateExpression(node)) {
  const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
    if (expression.includes("document.readyState")) {
      return { result: { value: { ready: true, composer: true, fileInput: false } } };
    }
    if (expression.includes("focused: true")) {
      return { result: { value: { focused: true } } };
    }
    if (expression.includes("editorText")) {
      return { result: { value: probe.evaluate(expression) } };
    }
    if (expression.includes("button.scrollIntoView")) {
      return { result: { value: { status: "clicked" } } };
    }
    if (expression.includes("normalizedPrompt")) {
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
    }
    return { result: { value: {} } };
  });
  return { runtime: { evaluate }, probe };
}

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

  test("does not treat historical assistant content as committed without a new turn", async () => {
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
                assistantVisible: true,
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

  test("marks prompt submitted after commit verification succeeds", async () => {
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
            result: {
              value: {
                editorText: "hello",
                fallbackValue: "",
                activeValue: "hello",
                submissionValue: "hello",
                submissionStateKnown: true,
              },
            },
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

  test("does not mark prompt submitted if commit verification fails", async () => {
    vi.useFakeTimers();
    try {
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
              result: {
                value: {
                  editorText: "hello",
                  fallbackValue: "",
                  activeValue: "hello",
                  submissionValue: "hello",
                  submissionStateKnown: true,
                },
              },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "clicked" } } };
          }
          if (expression.includes("normalizedPrompt")) {
            return {
              result: {
                value: {
                  baseline: 0,
                  turnsCount: 0,
                  userMatched: false,
                  prefixMatched: false,
                  lastMatched: false,
                  hasNewTurn: false,
                  stopVisible: false,
                  assistantVisible: false,
                  composerCleared: false,
                  inConversation: false,
                },
              },
            };
          }
          return { result: { value: {} } };
        }),
      };
      const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const promise = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
          onPromptSubmitted,
        },
        "hello",
        logger as never,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
      expect(onPromptSubmitted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  test("reads submission state from a composer exposing only pmViewDesc.node", async () => {
    vi.useFakeTimers();
    try {
      // Regression for the live failure: the composer div's only own key is pmViewDesc,
      // pmViewDesc.view is absent, and React keys live on the parent carrying no text.
      // Reading through view or __reactProps$ therefore reported no framework state at all
      // and rejected every submission pre-submit.
      const prompt = "alpha line one.\n\nbeta line two.";
      const blocks = ["alpha line one.", "", "beta line two."];
      const pmDoc = {
        type: { name: "doc" },
        content: { size: prompt.length },
        textBetween: vi.fn((_from: number, _to: number, separator: string) =>
          blocks.join(separator),
        ),
      };
      const composer = {
        innerText: prompt,
        textContent: prompt,
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
        pmViewDesc: {
          parent: {},
          children: [],
          dom: {},
          contentDOM: {},
          dirty: 0,
          node: pmDoc,
          outerDeco: [],
          innerDeco: {},
          nodeDOM: {},
        },
      };
      const { runtime } = submissionRuntime(composer);
      const promise = submitPrompt(
        { runtime: runtime as never, input: { insertText: vi.fn() } as never, baselineTurns: 0 },
        prompt,
        Object.assign(vi.fn(), { verbose: false }) as never,
      );

      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe(1);
      expect(pmDoc.textBetween).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("verifies a Markdown prompt whose syntax the composer consumes into nodes and marks", async () => {
    vi.useFakeTimers();
    try {
      // Measured live: ChatGPT applies Markdown input rules, so '## H' becomes a heading
      // block holding 'H', '- x' a list item holding 'x', '**b**' a paragraph carrying a
      // strong mark, and backticks a code mark. Pasting text/plain is parsed identically,
      // so no insertion path preserves the literal source. Only the projection can match.
      const prompt = [
        "## Heading here",
        "",
        "- bullet one",
        "1. numbered one",
        "**bold** text and code `x` here",
      ].join("\n");
      const readBack = [
        "Heading here",
        "",
        "bullet one",
        "numbered one",
        "bold text and code x here",
      ].join("\n");
      const pmDoc = {
        content: { size: readBack.length },
        textBetween: vi.fn(() => readBack),
      };
      const composer = {
        innerText: readBack,
        textContent: readBack,
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
        pmViewDesc: { node: pmDoc },
      };
      const { runtime } = submissionRuntime(composer);
      const promise = submitPrompt(
        { runtime: runtime as never, input: { insertText: vi.fn() } as never, baselineTurns: 0 },
        prompt,
        Object.assign(vi.fn(), { verbose: false }) as never,
      );

      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
