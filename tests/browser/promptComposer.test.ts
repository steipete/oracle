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

  const diagnosticPrefix = "ORACLE_PROMPT_COMMIT_DIAGNOSTIC ";
  const diagnosticProbeMarker = "__oraclePromptCommitDiagnosticProbe";

  function createPromptCommitFixture(
    outcome: "accepted" | "timeout",
    sendStatus: "point" | "clicked" | "missing" = "point",
    immediateProbeOutcome:
      | "expected"
      | "rejected"
      | "protocol_exception"
      | "unexpected_result" = "expected",
  ) {
    let commitProbeCalls = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("document.readyState")) {
        return { result: { value: { ready: true, composer: true, fileInput: false } } };
      }
      if (expression.includes("focused: true")) {
        return { result: { value: { focused: true } } };
      }
      if (expression.includes("const selectors =")) {
        return {
          result: {
            value:
              sendStatus === "point" ? { status: "point", x: 120, y: 48 } : { status: sendStatus },
          },
        };
      }
      if (expression.includes("editorText")) {
        return {
          result: {
            value: {
              editorText: "fixture prompt",
              fallbackValue: "",
              activeValue: "fixture prompt",
            },
          },
        };
      }
      if (expression.includes(diagnosticProbeMarker)) {
        if (immediateProbeOutcome === "rejected") throw new Error("probe rejection text");
        if (immediateProbeOutcome === "protocol_exception") {
          return {
            exceptionDetails: { text: "protocol exception details" },
            result: { value: { probe: true } },
          };
        }
        return { result: { value: { probe: immediateProbeOutcome === "expected" } } };
      }
      if (expression.includes("normalizedPrompt")) {
        commitProbeCalls += 1;
        const accepted = outcome === "accepted" && commitProbeCalls > 1;
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: accepted ? 1 : 0,
              userMatched: accepted,
              prefixMatched: accepted,
              lastMatched: accepted,
              hasNewTurn: accepted,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: accepted,
              inConversation: accepted,
              editorValue: `${diagnosticProbeMarker}-editor`,
              fallbackValue: `${diagnosticProbeMarker}-fallback`,
              lastTurn: `${diagnosticProbeMarker}-last-turn`,
              href: `${diagnosticProbeMarker}-href`,
            },
          },
        };
      }
      return { result: { value: { editorText: "", fallbackValue: "", activeValue: "" } } };
    });
    const input = {
      insertText: vi.fn().mockResolvedValue(undefined),
      dispatchKeyEvent: vi.fn(),
      dispatchMouseEvent: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });
    return {
      evaluate,
      input,
      logger,
      get commitProbeCalls() {
        return commitProbeCalls;
      },
    };
  }

  function assertPointClickFixtureSanity(
    fixture: ReturnType<typeof createPromptCommitFixture>,
    prompt: string,
  ) {
    expect(fixture.input.insertText).toHaveBeenCalledWith({ text: prompt });
    expect(fixture.input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(fixture.input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    expect(fixture.input.dispatchMouseEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(fixture.input.dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
      type: "mousePressed",
      x: 120,
      y: 48,
      button: "left",
      clickCount: 1,
    });
    expect(fixture.input.dispatchMouseEvent).toHaveBeenNthCalledWith(3, {
      type: "mouseReleased",
      x: 120,
      y: 48,
      button: "left",
      clickCount: 1,
    });
    expect(
      fixture.evaluate.mock.calls.filter(([args]) => args.expression.includes("const selectors =")),
    ).toHaveLength(1);
    expect(fixture.commitProbeCalls).toBeGreaterThanOrEqual(2);
  }

  function assertPromptCommitDiagnosticRed(
    fixture: ReturnType<typeof createPromptCommitFixture>,
    terminalPhase: "commit_accepted" | "commit_timeout",
    prompt: string,
  ) {
    const lines = fixture.logger.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith(diagnosticPrefix));
    const records = lines.map((line) => {
      const payload = line.slice(diagnosticPrefix.length);
      expect.soft(payload).not.toMatch(/^\s|\s$/);
      try {
        const record = JSON.parse(payload) as Record<string, unknown>;
        expect.soft(payload).toBe(JSON.stringify(record));
        return record;
      } catch {
        expect.soft(false).toBe(true);
        return {};
      }
    });
    const expectedPhases = [
      "candidate_selected",
      "trusted_click_dispatched",
      "immediate_post_click_probe",
      terminalPhase,
    ];
    expect.soft(records).toHaveLength(4);
    expect.soft(records.map((record) => record.phase)).toEqual(expectedPhases);
    for (const [index, record] of records.entries()) {
      expect
        .soft(Object.keys(record).sort())
        .toEqual(["actionKind", "phase", "sequence", "status"]);
      expect.soft(record.sequence).toBe(index);
      expect.soft(record.phase).toBe(expectedPhases[index]);
      expect.soft(record.status).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect.soft(record.actionKind).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect.soft(JSON.stringify(record)).not.toContain(prompt);
      expect
        .soft(JSON.stringify(record))
        .not.toMatch(/editor|fallback|last[-_]?turn|href|selector|profile|token/i);
    }

    const expressions = fixture.evaluate.mock.calls.map(([args]) => args.expression);
    const immediateProbeExpressions = expressions.filter((expression) =>
      expression.includes(diagnosticProbeMarker),
    );
    expect.soft(immediateProbeExpressions).toHaveLength(1);
    const immediateProbeExpression = immediateProbeExpressions[0];
    if (immediateProbeExpression) {
      expect.soft(immediateProbeExpression).not.toContain("dispatchMouseEvent");
      expect.soft(immediateProbeExpression).not.toContain("dispatchKeyEvent");
    }
    expect
      .soft(expressions.filter((expression) => expression.includes("normalizedPrompt")).length)
      .toBeGreaterThan(1);
    return records;
  }

  test.each([
    ["Runtime.evaluate rejects or throws", "rejected", "evaluate_rejected"],
    ["Runtime.evaluate resolves with exceptionDetails", "protocol_exception", "protocol_exception"],
    [
      "evaluation resolves without exceptionDetails but lacks exact result.value.probe === true",
      "unexpected_result",
      "unexpected_result",
    ],
  ] as const)("causal RED: %s", async (_name, immediateProbeOutcome, expectedStatus) => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const prompt = "fixture prompt";
      const fixture = createPromptCommitFixture("accepted", "point", immediateProbeOutcome);
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        prompt,
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      const records = assertPromptCommitDiagnosticRed(fixture, "commit_accepted", prompt);
      expect(records[2]?.status).toBe(expectedStatus);
      expect(fixture.logger.mock.calls.flat().join(" ")).not.toMatch(
        /exceptionDetails|protocol exception details|probe rejection text|probe:false|probe: false/i,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("causal RED: immediate-probe logger failure does not interfere", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const fixture = createPromptCommitFixture("accepted");
      const deliveredLines: string[] = [];
      fixture.logger.mockImplementation((line) => {
        const text = String(line);
        if (text.startsWith(diagnosticPrefix)) {
          const record = JSON.parse(text.slice(diagnosticPrefix.length)) as { phase?: string };
          if (record.phase === "immediate_post_click_probe") throw new Error("logger failure");
          deliveredLines.push(text);
        }
      });
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        "fixture prompt",
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      const records = deliveredLines.map(
        (line) => JSON.parse(line.slice(diagnosticPrefix.length)) as Record<string, unknown>,
      );
      expect(records.map((record) => record.phase)).toEqual([
        "candidate_selected",
        "trusted_click_dispatched",
        "commit_accepted",
      ]);
      expect(records.at(-1)?.status).toBe("accepted");
      expect(fixture.input.dispatchKeyEvent).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("causal RED: accepted point-click commit emits bounded diagnostics", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const prompt = "fixture prompt";
      const fixture = createPromptCommitFixture("accepted");
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        prompt,
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      assertPointClickFixtureSanity(fixture, prompt);
      assertPromptCommitDiagnosticRed(fixture, "commit_accepted", prompt);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("causal RED: timeout diagnostics redact the raw probe", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const prompt = "fixture prompt";
      const fixture = createPromptCommitFixture("timeout");
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        prompt,
        fixture.logger as never,
      );
      const rejection = expect(submission).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: { code: "prompt-commit-timeout" },
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(60_100);
      await rejection;

      assertPointClickFixtureSanity(fixture, prompt);
      expect.soft(fixture.logger.mock.calls.flat().join(" ")).not.toContain(diagnosticProbeMarker);
      assertPromptCommitDiagnosticRed(fixture, "commit_timeout", prompt);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("does not emit diagnostics for DOM-click fallback", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const fixture = createPromptCommitFixture("accepted", "clicked");
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        "fixture prompt",
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      expect(fixture.input.dispatchKeyEvent).not.toHaveBeenCalled();
      expect(
        fixture.evaluate.mock.calls.filter(([args]) =>
          args.expression.includes(diagnosticProbeMarker),
        ),
      ).toHaveLength(0);
      expect(
        fixture.logger.mock.calls
          .map(([line]) => String(line))
          .some((line) => line.startsWith(diagnosticPrefix)),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("does not emit diagnostics for missing-button Enter fallback", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ORACLE_PROMPT_COMMIT_DIAGNOSTICS", "1");
    try {
      const fixture = createPromptCommitFixture("accepted", "missing");
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        "fixture prompt",
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      expect(fixture.input.dispatchKeyEvent).toHaveBeenCalledTimes(2);
      expect(
        fixture.evaluate.mock.calls.filter(([args]) =>
          args.expression.includes(diagnosticProbeMarker),
        ),
      ).toHaveLength(0);
      expect(
        fixture.logger.mock.calls
          .map(([line]) => String(line))
          .some((line) => line.startsWith(diagnosticPrefix)),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  test("does not emit prefixed diagnostics when the env variable is unset", async () => {
    vi.useFakeTimers();
    const previous = process.env.ORACLE_PROMPT_COMMIT_DIAGNOSTICS;
    delete process.env.ORACLE_PROMPT_COMMIT_DIAGNOSTICS;
    try {
      const prompt = "fixture prompt";
      const fixture = createPromptCommitFixture("accepted");
      const submission = submitPrompt(
        { runtime: fixture as never, input: fixture.input as never, baselineTurns: 0 },
        prompt,
        fixture.logger as never,
      );

      await vi.advanceTimersByTimeAsync(499);
      expect(fixture.input.dispatchMouseEvent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(submission).resolves.toBe(1);

      assertPointClickFixtureSanity(fixture, prompt);
      expect(
        fixture.logger.mock.calls
          .map(([line]) => String(line))
          .some((line) => line.startsWith(diagnosticPrefix)),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ORACLE_PROMPT_COMMIT_DIAGNOSTICS;
      else process.env.ORACLE_PROMPT_COMMIT_DIAGNOSTICS = previous;
      vi.useRealTimers();
    }
  });
});
