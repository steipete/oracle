import { describe, expect, it } from "vitest";
import {
  buildThrottleProbeExpression,
  detectChatGptThrottleNotice,
  matchesThrottleNotice,
} from "../../src/browser/chatgptThrottle.js";
import { ensureModelSelection } from "../../src/browser/actions/modelSelection.js";

// The exact notice observed live, transcribed from the dialog ChatGPT showed
// after six conversations were opened at once.
const LIVE_NOTICE = [
  "Too many requests",
  "You're making requests too quickly. We've temporarily limited access to your conversations to protect your data.",
  "Please wait a few minutes before trying again.",
  "Got it",
].join("\n");

describe("ChatGPT throttle notice", () => {
  it("recognises the notice as shown", () => {
    expect(matchesThrottleNotice(LIVE_NOTICE)).toBe(true);
  });

  it("recognises each phrase independently, so a reworded notice still matches", () => {
    expect(matchesThrottleNotice("Too many requests")).toBe(true);
    expect(matchesThrottleNotice("You're making requests too quickly.")).toBe(true);
    expect(matchesThrottleNotice("We've temporarily limited access to your conversations")).toBe(
      true,
    );
  });

  it("does not fire on ordinary page text", () => {
    expect(matchesThrottleNotice("GPT-5.6 Sol")).toBe(false);
    expect(matchesThrottleNotice("Got it")).toBe(false);
    expect(matchesThrottleNotice("")).toBe(false);
    expect(matchesThrottleNotice(undefined)).toBe(false);
  });

  it("probes dialogs before falling back to the page body", () => {
    const expression = buildThrottleProbeExpression();
    expect(expression).toContain('role="dialog"');
    expect(expression).toContain('role="alertdialog"');
    expect(expression).toContain("document.body");
  });

  it("returns nothing rather than throwing when the probe itself fails", async () => {
    // This runs on paths that are already reporting a different failure; a broken
    // probe must not replace the caller's diagnosis with its own.
    const notice = await detectChatGptThrottleNotice({
      evaluate: async () => {
        throw new Error("target closed");
      },
    } as never);
    expect(notice).toBeNull();
  });
});

describe("model selection under a throttle", () => {
  it("reports the rate limit instead of a missing model", async () => {
    // Before this, a throttled run failed with:
    //   Unable to find model option matching "Thinking 5.5". Available: Got it
    // which reads as a model-naming bug and sends the reader nowhere useful.
    const runtime = {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("temporarily limited access")) {
          return { result: { value: { message: LIVE_NOTICE } } };
        }
        return {
          result: {
            value: {
              status: "option-not-found",
              hint: { availableOptions: ["Got it"], temporaryChat: false },
            },
          },
        };
      },
    };

    await expect(
      ensureModelSelection(runtime as never, "gpt-5.5", (() => {}) as never, "select"),
    ).rejects.toThrow(/rate limiting this session/i);
  });

  it("still blames the model when there is no throttle notice", async () => {
    const runtime = {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("temporarily limited access")) {
          return { result: { value: null } };
        }
        return {
          result: {
            value: {
              status: "option-not-found",
              hint: { availableOptions: ["GPT-5.6 Sol", "GPT-5.5"], temporaryChat: false },
            },
          },
        };
      },
    };

    await expect(
      ensureModelSelection(runtime as never, "gpt-4o", (() => {}) as never, "select"),
    ).rejects.toThrow(/Unable to find model option matching "gpt-4o"/);
  });

  it("marks the throttle retryable so a caller can wait rather than give up", async () => {
    const runtime = {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("temporarily limited access")) {
          return { result: { value: { message: LIVE_NOTICE } } };
        }
        return { result: { value: { status: "option-not-found", hint: {} } } };
      },
    };

    await ensureModelSelection(runtime as never, "gpt-5.5", (() => {}) as never, "select").then(
      () => {
        throw new Error("expected a throttle error");
      },
      (error: { details?: { stage?: string; details?: Record<string, unknown> } }) => {
        expect(error.details?.stage).toBe("chatgpt-throttled");
        expect(error.details?.details?.retryable).toBe(true);
        expect(error.details?.details?.origin).toBe("model-selection");
      },
    );
  });
});
