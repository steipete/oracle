import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  alignPromptEchoPair,
  buildPromptEchoMatcher,
  waitForPromptPreview,
} from "../../src/browser/reattachHelpers.ts";

describe("prompt comparison", () => {
  test.each(["Review\n\tthe   code", "Review\r\nthe code", "Review\u00a0the code"])(
    "normalizes prompt whitespace in %j",
    (prompt) => {
      expect(buildPromptEchoMatcher(prompt)?.isEcho("Review the code")).toBe(true);
      expect(buildPromptEchoMatcher("Review the code")?.isEcho(prompt)).toBe(true);
    },
  );

  test("preserves literal backslashes when comparing prompt echoes", () => {
    const prompt = String.raw`Explain \sum now`;
    const matcher = buildPromptEchoMatcher(prompt);
    expect(matcher?.isEcho(prompt)).toBe(true);
    expect(matcher?.isEcho("Explain  um now")).toBe(false);
  });

  test.each([
    ["Review migration 1234", "Review migration"],
    ["Review\nmigration 1234", "Review \n\tmigration"],
  ])("finds hydrated prompt %j without its trailing counter", async (prompt, rendered) => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: runInNewContext(expression, {
              document: {
                querySelector: () => ({
                  querySelectorAll: () => [{ innerText: rendered }],
                }),
              },
            }),
          },
        })),
      };
      const found = waitForPromptPreview(runtime as never, prompt, 1000);
      await vi.runAllTimersAsync();
      expect(await found).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("alignPromptEchoPair", () => {
  test("aligns answer text when text is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Real answer", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("aligns answer markdown when markdown is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Real answer", "Echo prompt", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("keeps echo flag when both text and markdown are prompt echoes", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Echo prompt", matcher);
    expect(result.isEcho).toBe(true);
  });
});
