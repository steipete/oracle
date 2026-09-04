import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  buildAttachmentReadyExpressionForTest,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";

const evaluateAttachmentReady = (expectedName: string, visibleName: string): boolean => {
  class FakeElement {
    tagName = "DIV";
    parentElement: FakeElement | null = null;

    constructor(
      private readonly text = "",
      private readonly attributes: Record<string, string> = {},
    ) {}

    get innerText() {
      return this.text;
    }

    get textContent() {
      return this.text;
    }

    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }

    querySelectorAll(_selector: string): FakeElement[] {
      return [];
    }

    closest(_selector: string): FakeElement | null {
      return null;
    }
  }

  class FakeInputElement extends FakeElement {
    files: File[] = [];
  }

  const chip = new FakeElement(visibleName, {
    "aria-label": `Remove file 1: ${visibleName}`,
    "data-testid": "file-chip",
  });
  const root = new FakeElement();
  root.querySelectorAll = (selector: string) => {
    if (selector === 'input[type="file"]') return [];
    if (selector.includes('[data-testid*="chip"]')) return [chip];
    if (selector.includes('[aria-label*="Remove" i]')) return [chip];
    return [];
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    body: root,
  };
  const expression = buildAttachmentReadyExpressionForTest([expectedName]);
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "HTMLInputElement",
    `return ${expression};`,
  );
  return Boolean(evaluate(document, FakeElement, FakeInputElement));
};

describe("promptComposer", () => {
  test.each([
    ["mcp.md", "mcp(7).md", true],
    ["mcp.md", "remove file 1: mcp(7).md", true],
    ["mcp.md", "mcp(7).jpg", false],
    ["mcp.md", "xmcp(7).md", false],
  ])("matches ready attachment %s against %s as %s", (expected, visible, matches) => {
    expect(evaluateAttachmentReady(expected, visible)).toBe(matches);
  });

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

  test.each([5, 50_001])(
    "commit timeout at %i chars stays ambiguous, never too-large",
    async (length) => {
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

        const promise = promptComposer.verifyPromptCommitted(
          runtime as never,
          "x".repeat(length),
          150,
        );
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
    },
  );

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
        undefined,
        undefined,
        "https://chatgpt.com/",
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

  test("fails before staging an attachment prompt when the pre-upload page identity is missing", async () => {
    const runtime = { evaluate: vi.fn() };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          attachmentNames: ["signed-in-image.png"],
        },
        "do not stage this prompt",
        Object.assign(vi.fn(), { verbose: false }) as never,
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({
        code: "attachment-navigation-identity-unavailable",
        stage: "submit-prompt",
      }),
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(input.insertText).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("dismisses the attachment menu before keyboard-activating the exact send button", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("const uploadEvidence")) {
            return { result: { value: true } };
          }
          if (
            expression.includes("composer-plus-btn") &&
            expression.includes("button.focus({ preventScroll: true })")
          ) {
            return { result: { value: { status: "open", focused: true } } };
          }
          if (expression.includes("return !selectors.some")) {
            return { result: { value: true } };
          }
          if (expression.includes('button[data-testid="send-button"]')) {
            events.push("focusSendButton");
            return { result: { value: { status: "focused" } } };
          }
          if (expression.includes("currentUrl: location.href")) {
            events.push("navigationGuard");
            return {
              result: {
                value: { currentUrl: "https://chatgpt.com/", workSelected: false },
              },
            };
          }
          if (expression.includes("dispatchClickSequence")) {
            events.push("measurePoint");
            return { result: { value: { status: "point", x: 30, y: 40 } } };
          }
          throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
        }),
      };
      const input = {
        dispatchKeyEvent: vi.fn(async ({ type, key }: { type: string; key: string }) => {
          events.push(`${type}:${key}`);
        }),
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          events.push(type);
        }),
      };
      const page = {
        bringToFront: vi.fn(async () => {
          events.push("bringToFront");
        }),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        logger as never,
        ["signed-in-image.png"],
        5_000,
        page as never,
        "https://chatgpt.com/",
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(events).toEqual([
        "bringToFront",
        "keyDown:Escape",
        "keyUp:Escape",
        "focusSendButton",
        "navigationGuard",
        "keyDown:Enter",
        "keyUp:Enter",
      ]);
      expect(logger).toHaveBeenCalledWith("Closed attachment menu before send");
      expect(logger).toHaveBeenCalledWith("Activated exact attachment send button via keyboard");
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects delayed Work navigation at the final attachment dispatch boundary", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("const uploadEvidence")) {
            return { result: { value: true } };
          }
          if (expression.includes("composer-plus-btn")) {
            return { result: { value: { status: "closed" } } };
          }
          if (expression.includes('button[data-testid="send-button"]')) {
            return { result: { value: { status: "focused" } } };
          }
          if (expression.includes("currentUrl: location.href")) {
            return {
              result: {
                value: {
                  currentUrl: "https://chatgpt.com/c/WEB:delayed-work",
                  workSelected: false,
                },
              },
            };
          }
          if (expression.includes("dispatchClickSequence")) {
            throw new Error("attachment flow must not reach coordinate fallback");
          }
          throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
        }),
      };
      const input = {
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(),
      };

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        ["signed-in-image.png"],
        1_000,
        undefined,
        "https://chatgpt.com/",
      );
      const assertion = expect(result).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: expect.objectContaining({
          code: "attachment-control-unexpected-navigation",
          stage: "upload-attachment",
        }),
      });
      await vi.advanceTimersByTimeAsync(500);

      await assertion;
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a delayed switch between non-conversation landing contexts", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("const uploadEvidence")) {
            return { result: { value: true } };
          }
          if (expression.includes("composer-plus-btn")) {
            return { result: { value: { status: "closed" } } };
          }
          if (expression.includes('button[data-testid="send-button"]')) {
            return { result: { value: { status: "focused" } } };
          }
          if (expression.includes("currentUrl: location.href")) {
            return {
              result: {
                value: {
                  currentUrl: "https://chatgpt.com/g/g-project-b/project",
                  workSelected: false,
                },
              },
            };
          }
          if (expression.includes("dispatchClickSequence")) {
            throw new Error("attachment flow must not reach coordinate fallback");
          }
          throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
        }),
      };
      const input = {
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(),
      };

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        ["signed-in-image.png"],
        1_000,
        undefined,
        "https://chatgpt.com/g/g-project-a/project",
      );
      const assertion = expect(result).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: expect.objectContaining({
          code: "attachment-control-unexpected-navigation",
          stage: "upload-attachment",
          startUrl: "https://chatgpt.com/g/g-project-a/project",
          currentUrl: "https://chatgpt.com/g/g-project-b/project",
        }),
      });
      await vi.advanceTimersByTimeAsync(500);

      await assertion;
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("never falls back to broad selectors or coordinates when the exact attachment send button is absent", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("const uploadEvidence")) {
            return { result: { value: true } };
          }
          if (expression.includes("composer-plus-btn")) {
            return { result: { value: { status: "closed" } } };
          }
          if (expression.includes('button[data-testid="send-button"]')) {
            return { result: { value: { status: "absent" } } };
          }
          if (expression.includes("dispatchClickSequence")) {
            throw new Error("attachment flow must not reach coordinate fallback");
          }
          throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
        }),
      };
      const input = {
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(),
      };

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        ["signed-in-image.png"],
        500,
        undefined,
        "https://chatgpt.com/",
      );
      const assertion = expect(result).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: expect.objectContaining({
          code: "attachment-send-not-ready",
          stage: "submit-prompt",
        }),
      });
      await vi.runAllTimersAsync();

      await assertion;
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails closed when an open attachment menu cannot receive trusted keys", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "open", focused: true } },
      }),
    };

    await expect(
      promptComposer.dismissOpenComposerPlusMenu(runtime as never, {} as never),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({
        code: "attachment-menu-dismiss-unavailable",
        stage: "submit-prompt",
      }),
    });
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
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("does not send Enter while a trusted click commits after the old fallback deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let clickedAt: number | null = null;
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
            return { result: { value: { status: "point", x: 10, y: 20 } } };
          }
          if (expression.includes("oracle-post-click-composer-probe")) {
            const elapsed = clickedAt === null ? 0 : Date.now() - clickedAt;
            return { result: { value: elapsed < 2_500 } };
          }
          const committed = clickedAt !== null && Date.now() - clickedAt >= 2_500;
          return {
            result: {
              value: {
                baseline: 0,
                turnsCount: committed ? 1 : 0,
                userMatched: committed,
                prefixMatched: false,
                lastMatched: committed,
                hasNewTurn: committed,
                stopVisible: committed,
                assistantVisible: false,
                composerCleared: committed,
                inConversation: true,
              },
            },
          };
        }),
      };
      const input = {
        insertText: vi.fn(),
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") clickedAt = Date.now();
        }),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(3_500);

      await expect(result).resolves.toBe(1);
      expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: "mousePressed", button: "left" }),
      );
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ type: "mouseReleased", button: "left" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses one Enter key sequence only when no send-button click was issued", async () => {
    vi.useFakeTimers();
    try {
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
            return { result: { value: { status: "missing" } } };
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
      const input = {
        insertText: vi.fn(),
        dispatchKeyEvent: vi.fn(),
        dispatchMouseEvent: vi.fn(),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const result = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
        },
        "hello",
        logger as never,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(1);
      expect(input.dispatchKeyEvent).toHaveBeenCalledTimes(2);
      expect(input.dispatchKeyEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: "keyDown", key: "Enter" }),
      );
      expect(input.dispatchKeyEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ type: "keyUp", key: "Enter" }),
      );
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(1_250);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("activates the target before measuring fresh trusted-click coordinates", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let activated = false;
      const runtime = {
        evaluate: vi.fn(async () => {
          events.push("measurePoint");
          return {
            result: {
              value: activated
                ? { status: "point", x: 30, y: 40 }
                : { status: "point", x: 10, y: 20 },
            },
          };
        }),
      };
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          events.push(type);
        }),
      };
      const page = {
        bringToFront: vi.fn(async () => {
          activated = true;
          events.push("bringToFront");
        }),
      };

      const result = promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        page as never,
      );
      await vi.advanceTimersByTimeAsync(350);

      await expect(result).resolves.toBe(true);
      expect(events).toEqual([
        "bringToFront",
        "measurePoint",
        "measurePoint",
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ]);
      expect(page.bringToFront).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
        type: "mouseMoved",
        x: 30,
        y: 40,
      });
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits through scrolling and a layout snap before issuing its only click", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: { status: "settling" } } })
          .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
          .mockResolvedValue({ result: { value: { status: "point", x: 30, y: 40 } } }),
      };
      const input = { dispatchMouseEvent: vi.fn() };
      const result = promptComposer.attemptSendButton(runtime as never, input as never);
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(true);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
      expect(input.dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
        type: "mousePressed",
        x: 30,
        y: 40,
        button: "left",
        clickCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
