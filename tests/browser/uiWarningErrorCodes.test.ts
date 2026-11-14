import { describe, expect, test, vi } from "vitest";
import { FakeDocument, FakeElement } from "./domFixture.js";
import {
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  throwChatGptUiWarningIfPresent,
} from "../../src/browser/uiWarnings.js";
import type { ChromeClient } from "../../src/browser/types.js";

// Sanitized shape observed on 2026-10-23 in the Chat/Work layout: after the user turn, ChatGPT
// showed <aside role="alert">cloudflare_challenge <button>Retry</button></aside> and no reply.
const alertWithRetry = (text: string) =>
  new FakeElement(
    "aside",
    { role: "alert", class: "relative isolate flex w-full" },
    [new FakeElement("button", {}, [], "Retry")],
    `${text} `,
  );

function pageRuntime(children: FakeElement[]): ChromeClient["Runtime"] {
  const document = new FakeDocument(children);
  const window = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  return {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", "HTMLElement", "window", `return ${expression}`)(
          document,
          FakeElement,
          window,
        ),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
}

describe("ChatGPT UI warning error codes", () => {
  test.each([
    "No response from ChatGPT. Check your connection.",
    "No response from ChatGPT.",
    "Check your connection.",
  ])("classifies connection failures: %s", (text) => {
    expect(classifyChatGptUiWarningText(text)).toBe("temporary_unavailable");
  });

  test("fails immediately on a rendered connection alert without an assistant turn", async () => {
    const Runtime = pageRuntime([
      alertWithRetry("No response from ChatGPT. Check your connection."),
    ]);
    await expect(
      throwChatGptUiWarningIfPresent({
        Runtime,
        logger: vi.fn() as never,
        runtime: {},
        stage: "assistant-wait",
        waitTarget: "the assistant",
      }),
    ).rejects.toMatchObject({
      details: {
        stage: "assistant-wait",
        code: "chatgpt-ui-warning",
        uiWarning: { type: "temporary_unavailable" },
      },
    });
  });

  test("does not scan ordinary conversation prose for connection warnings", async () => {
    const answer = new FakeElement(
      "article",
      { "data-turn": "assistant" },
      [],
      'The banner says "No response from ChatGPT. Check your connection."',
    );
    await expect(collectChatGptUiWarnings(pageRuntime([answer]))).resolves.toEqual([]);
  });

  test("classifies separator-joined error codes like their spaced wording", () => {
    expect(classifyChatGptUiWarningText("cloudflare_challenge")).toBe("auth_or_challenge");
    expect(classifyChatGptUiWarningText("cloudflare_challenge Retry")).toBe("auth_or_challenge");
    expect(classifyChatGptUiWarningText("rate_limit_exceeded")).toBe("rate_limit");
    expect(classifyChatGptUiWarningText("too-many-requests")).toBe("rate_limit");
    expect(classifyChatGptUiWarningText("Sign-in required")).toBe("auth_or_challenge");
  });

  test("leaves ordinary identifiers and prose unclassified", () => {
    for (const text of [
      "Rename user_id to account_id and keep request_body unchanged.",
      "The assign_in helper and design-input notes are ready.",
      "Signing_in happens after the page loads.",
      "Retry",
    ]) {
      expect(classifyChatGptUiWarningText(text)).toBeNull();
    }
  });

  test("collects an inline alert that shows only an error code", async () => {
    const thread = new FakeElement("div", {}, [
      new FakeElement("div", { "data-turn": "user" }, [], "Review the attached bundle."),
      alertWithRetry("rate_limit_exceeded"),
    ]);

    await expect(collectChatGptUiWarnings(pageRuntime([thread]))).resolves.toEqual([
      expect.objectContaining({ type: "rate_limit", message: "rate_limit_exceeded Retry" }),
    ]);
  });

  test("names an inline cloudflare_challenge alert when the reply times out", async () => {
    const thread = new FakeElement("div", {}, [
      new FakeElement("div", { "data-turn": "user" }, [], "Review the attached bundle."),
      alertWithRetry("cloudflare_challenge"),
    ]);
    const logger = vi.fn<(message: string) => void>();

    const error = await createAssistantTimeoutError({
      Runtime: pageRuntime([thread]),
      logger: logger as never,
      runtime: { chromePort: 9222 },
      cause: new Error("timeout"),
    });

    expect(error.message).toContain("authentication/challenge warning");
    expect(error.message).toContain("cloudflare_challenge");
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      code: "chatgpt-ui-warning",
      uiWarning: { type: "auth_or_challenge", message: "cloudflare_challenge Retry" },
    });
  });
});
