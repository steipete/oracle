import { describe, expect, test, vi } from "vitest";
import {
  shouldPreserveBrowserOnErrorForTest,
  resolveBaselineTurnIndexForTest,
  recoverGeneratedImageAnswerAfterReloadForTest,
  resolveAssistantResponseTimeoutMsForTest,
  shouldSkipMarkdownCaptureForGeneratedImageForTest,
} from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
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

describe("resolveBaselineTurnIndexForTest", () => {
  test("returns the last existing turn index instead of the raw turn count", () => {
    expect(resolveBaselineTurnIndexForTest(0)).toBe(0);
    expect(resolveBaselineTurnIndexForTest(1)).toBe(0);
    expect(resolveBaselineTurnIndexForTest(2)).toBe(1);
    expect(resolveBaselineTurnIndexForTest(5)).toBe(4);
  });
});

describe("resolveAssistantResponseTimeoutMsForTest", () => {
  test("keeps the configured timeout for non-image browser runs", () => {
    expect(resolveAssistantResponseTimeoutMsForTest(1_200_000, false)).toBe(1_200_000);
  });

  test("caps image-mode assistant waits at 2 minutes by default", () => {
    expect(resolveAssistantResponseTimeoutMsForTest(1_200_000, true)).toBe(120_000);
    expect(resolveAssistantResponseTimeoutMsForTest(90_000, true)).toBe(90_000);
  });
});

describe("shouldSkipMarkdownCaptureForGeneratedImageForTest", () => {
  test("skips markdown capture when the assistant html already contains a downloadable generated image", () => {
    expect(
      shouldSkipMarkdownCaptureForGeneratedImageForTest({
        text: "Stopped thinking\nEdit",
        html: '<div><img src="https://chatgpt.com/backend-api/estuary/content?id=file_done"></div>',
      }),
    ).toBe(true);
  });

  test("does not skip markdown capture for normal text answers", () => {
    expect(
      shouldSkipMarkdownCaptureForGeneratedImageForTest({
        text: "Here is the answer",
        html: "<p>Here is the answer</p>",
      }),
    ).toBe(false);
  });
});

describe("recoverGeneratedImageAnswerAfterReloadForTest", () => {
  test("recovers a generated-image answer from the refreshed DOM", async () => {
    const runtime = {
      evaluate: vi.fn().mockImplementation(async ({ expression }: { expression: string }) => {
        if (expression.includes('/backend-api/estuary/content?id=file_')) {
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_done",
                  alt: "Generated image",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          };
        }
        if (expression.includes("extractAssistantTurn")) {
          return {
            result: {
              value: {
                text: "Stopped thinking\nEdit",
                html: "<div><img src=\"https://chatgpt.com/backend-api/estuary/content?id=file_done\"></div>",
                messageId: "mid-image",
                turnId: "tid-image",
                turnIndex: 1,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as any;

    const recovered = await recoverGeneratedImageAnswerAfterReloadForTest(runtime, 1);

    expect(recovered).toEqual({
      text: "Stopped thinking\nEdit",
      html: "<div><img src=\"https://chatgpt.com/backend-api/estuary/content?id=file_done\"></div>",
      meta: { messageId: "mid-image", turnId: "tid-image" },
    });
  });

  test("keeps polling after reload until the generated image appears", async () => {
    vi.useFakeTimers();
    try {
      let imagePolls = 0;
      const runtime = {
        evaluate: vi.fn().mockImplementation(async ({ expression }: { expression: string }) => {
          if (expression.includes('/backend-api/estuary/content?id=file_')) {
            imagePolls += 1;
            if (imagePolls < 3) {
              return { result: { value: [] } };
            }
            return {
              result: {
                value: [
                  {
                    url: "https://chatgpt.com/backend-api/estuary/content?id=file_done",
                    alt: "Generated image",
                    width: 1024,
                    height: 1024,
                  },
                ],
              },
            };
          }
          if (expression.includes("extractAssistantTurn")) {
            return {
              result: {
                value: {
                  text: "Stopped thinking\nEdit",
                  html: "<div><img src=\"https://chatgpt.com/backend-api/estuary/content?id=file_done\"></div>",
                  messageId: "mid-image",
                  turnId: "tid-image",
                  turnIndex: 1,
                },
              },
            };
          }
          return { result: { value: null } };
        }),
      } as any;

      const recoveredPromise = recoverGeneratedImageAnswerAfterReloadForTest(runtime, 1);
      await vi.advanceTimersByTimeAsync(1_200);
      const recovered = await recoveredPromise;

      expect(imagePolls).toBe(3);
      expect(recovered?.meta).toEqual({ messageId: "mid-image", turnId: "tid-image" });
    } finally {
      vi.useRealTimers();
    }
  });
});
