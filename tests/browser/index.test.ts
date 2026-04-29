import { describe, expect, test } from "vitest";
import {
  shouldPreserveBrowserOnErrorForTest,
  shouldReattachForLikelyTruncatedAnswerForTest,
} from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("preserves the browser for headful assistant-timeout errors", () => {
    const error = new BrowserAutomationError("Assistant response may be truncated.", {
      stage: "assistant-timeout",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("preserves the browser for headful auth-required errors", () => {
    const error = new BrowserAutomationError("ChatGPT login required.", {
      stage: "auth-required",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
  });
});

describe("shouldReattachForLikelyTruncatedAnswerForTest", () => {
  test("flags suspiciously short answers from long pro runs", () => {
    expect(
      shouldReattachForLikelyTruncatedAnswerForTest({
        promptText:
          "Return exactly these sections: Executive answer, Detailed architecture, Implementation plan. " +
          "A".repeat(5000),
        answerText: "I'm grounding this in your actual setup before I answer.",
        tookMs: 20 * 60 * 1000,
        attachmentCount: 7,
        desiredModel: "GPT-5.4 Pro",
        thinkingTime: "extended",
      }),
    ).toBe(true);
  });

  test("does not flag intentionally short prompts", () => {
    expect(
      shouldReattachForLikelyTruncatedAnswerForTest({
        promptText: "Reply with only OK after reading these files. " + "A".repeat(5000),
        answerText: "OK",
        tookMs: 20 * 60 * 1000,
        attachmentCount: 7,
        desiredModel: "GPT-5.4 Pro",
        thinkingTime: "extended",
      }),
    ).toBe(false);
  });

  test("does not flag normal longer answers", () => {
    expect(
      shouldReattachForLikelyTruncatedAnswerForTest({
        promptText: "Return exactly these sections. " + "A".repeat(5000),
        answerText: "B".repeat(1200),
        tookMs: 20 * 60 * 1000,
        attachmentCount: 7,
        desiredModel: "GPT-5.4 Pro",
        thinkingTime: "extended",
      }),
    ).toBe(false);
  });
});
