import { describe, expect, test } from "vitest";
import { FakeDocument, FakeElement } from "./domFixture.js";
import { buildConversationTurnCountExpression } from "../../src/browser/conversationTurns.js";
import {
  browserPromptFingerprint,
  readSubmittedPromptFingerprint,
  readUserMessageIds,
} from "../../src/browser/promptFingerprint.js";
import {
  buildCompletionVisibilityExpressionForTest,
  captureAssistantMarkdown,
  readAssistantSnapshot,
} from "../../src/browser/actions/assistantResponse.js";
import { buildChatModeProbeExpressionForTest } from "../../src/browser/actions/navigation.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { __test__ as fileExpressions } from "../../src/browser/chatgptFiles.js";

// Semantic markers observed in the signed-in Chat/Work layout described by #517.
// These are source-expression regressions, not a substitute for signed-in live runs.
const node = (
  tag: string,
  attrs: Record<string, string> = {},
  children: FakeElement[] = [],
  text = "",
) => new FakeElement(tag, attrs, children, text);
function fixture(file = false) {
  const bubble = node("div", { "data-user-message-bubble": "true" }, [], "new prompt");
  const user = node("div", { "data-content-search-unit-key": "hydrating:0:user" }, [
    bubble,
    node("span", {}, [], "upload status"),
  ]);
  const markdown = node(
    "div",
    { "data-markdown-text-style": "assistant-message" },
    [],
    file ? "" : "new answer",
  );
  const children = [node("h4", {}, [], "ChatGPT said:"), markdown];
  if (file)
    children.push(
      node("button", { "aria-label": "Open preview of result.txt", "aria-busy": "false" }),
      node("button", { "aria-label": "Download file" }),
    );
  const assistant = node(
    "div",
    {
      "data-content-search-unit-key": "hydrating:2:assistant",
      "data-chatgpt-search-message-ids": "assistant-uuid assistant-uuid",
    },
    children,
  );
  const turn = node("div", { "data-turn-key": "stable-turn" }, [user, assistant]);
  const document = new FakeDocument([node("main", {}, [turn])]);
  return { document, user, turn, assistant, markdown };
}
function evaluate(expression: string, document: FakeDocument): unknown {
  return new Function("document", "HTMLElement", "window", "location", `return ${expression}`)(
    document,
    FakeElement,
    { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
    { pathname: "/", origin: "https://chatgpt.com" },
  );
}
function runtime(document: FakeDocument): ChromeClient["Runtime"] {
  return {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression, document) },
    }),
  } as unknown as ChromeClient["Runtime"];
}

describe("ChatGPT Chat/Work semantic layout", () => {
  test("counts a wrapper once and binds only the new user bubble to its durable key", async () => {
    const { document } = fixture();
    const r = runtime(document);
    expect(evaluate(buildConversationTurnCountExpression(), document)).toBe(1);
    expect(await readUserMessageIds(r)).toEqual(["stable-turn"]);
    expect(await readSubmittedPromptFingerprint(r, [])).toBe(
      browserPromptFingerprint("new prompt", "stable-turn"),
    );
    expect(await readSubmittedPromptFingerprint(r, ["stable-turn"])).toBeUndefined();
  });
  test("ignores nested legacy wrappers inside the canonical new wrapper", () => {
    const { document, turn } = fixture();
    turn.append(node("div", { "data-testid": "conversation-turn-1" }));
    expect(evaluate(buildConversationTurnCountExpression(), document)).toBe(1);
  });
  test("extracts only assistant content and its native message identity", async () => {
    const { document } = fixture();
    const snapshot = await readAssistantSnapshot(runtime(document));
    expect(snapshot?.text).toBe("new answer");
    expect(snapshot?.messageId).toBe("assistant-uuid");
    expect(snapshot?.turnId).toBe("stable-turn");
  });
  test("prefers final answer content over earlier progress and later status roots", async () => {
    const { document, assistant } = fixture();
    const progress = node(
      "div",
      { "data-markdown-text-style": "assistant-message" },
      [],
      "I will investigate.",
    );
    progress.parentElement = assistant;
    assistant.children.unshift(progress);
    assistant.append(
      node(
        "div",
        { "data-markdown-text-style": "assistant-message", "data-markdown-text-tone": "tertiary" },
        [],
        "Searched 51 websites",
      ),
    );
    expect((await readAssistantSnapshot(runtime(document)))?.text).toBe("new answer");
  });
  test("uses the latest assistant message inside a shared exchange", async () => {
    const { document, turn } = fixture();
    const progress = node("div", { "data-content-search-unit-key": "hydrating:1:assistant" }, [
      node("div", { "data-markdown-text-style": "assistant-message" }, [], "I will investigate."),
    ]);
    progress.parentElement = turn;
    turn.children.unshift(progress);
    expect(await readAssistantSnapshot(runtime(document))).toMatchObject({
      text: "new answer",
      messageId: "assistant-uuid",
    });
  });
  test("correlates sibling completion controls and rejects the wrong message", () => {
    const { document, turn } = fixture();
    turn.append(
      node("div", { class: "turn-action-controls" }, [node("button", { "aria-label": "Copy" })]),
    );
    expect(
      evaluate(
        buildCompletionVisibilityExpressionForTest({ messageId: "assistant-uuid" }, 0),
        document,
      ),
    ).toBe(true);
    expect(
      evaluate(buildCompletionVisibilityExpressionForTest({ messageId: "wrong" }, 0), document),
    ).toBe(false);
  });
  test("does not accept a streaming turn without scoped finished controls", () => {
    const { document } = fixture();
    document.body.append(node("form", {}, [node("button", { "data-testid": "stop-button" })]));
    expect(
      evaluate(buildCompletionVisibilityExpressionForTest({ turnId: "stable-turn" }, 0), document),
    ).toBe(false);
  });
  test("uses a ready file card outside the empty analysis Markdown", async () => {
    const { document } = fixture(true);
    const snapshot = await readAssistantSnapshot(runtime(document));
    expect(snapshot?.text).toBe("result.txt");
    expect(
      evaluate(
        buildCompletionVisibilityExpressionForTest({ messageId: "assistant-uuid" }, 0),
        document,
      ),
    ).toBe(true);
  });
  test.each(["completion", "download"])(
    "uses the final assistant unit for file-card %s",
    async (probe) => {
      const { document, turn } = fixture(true);
      const progress = node("div", { "data-content-search-unit-key": "hydrating:1:assistant" }, [
        node("div", { "data-markdown-text-style": "assistant-message" }, [], "Preparing a file."),
      ]);
      progress.parentElement = turn;
      turn.children.unshift(progress);
      expect((await readAssistantSnapshot(runtime(document)))?.text).toBe("result.txt");
      expect(
        evaluate(
          probe === "completion"
            ? buildCompletionVisibilityExpressionForTest({ messageId: "assistant-uuid" }, 0)
            : fileExpressions.buildAssistantFileCardTurnIndexExpression(),
          document,
        ),
      ).toBe(probe === "completion" ? true : 0);
    },
  );
  test("earlier assistant action bars cannot complete a later message in the same exchange", () => {
    const { document, turn } = fixture();
    const actions = node("div", { class: "turn-action-controls" }, [
      node("button", { "aria-label": "Copy" }),
    ]);
    actions.parentElement = turn;
    turn.children.unshift(actions);
    expect(
      evaluate(
        buildCompletionVisibilityExpressionForTest({ messageId: "assistant-uuid" }, 0),
        document,
      ),
    ).toBe(false);
  });
  test("starts the file-button fallback only for a ready card in the latest turn", () => {
    const expression = fileExpressions.buildAssistantFileCardTurnIndexExpression();
    const ready = fixture(true);
    expect(evaluate(expression, ready.document)).toBe(0);
    expect(evaluate(expression, fixture().document)).toBe(-1);
    ready.document.body
      .querySelector("main")!
      .append(
        node("div", { "data-turn-key": "pending" }, [
          node("div", { "data-content-search-unit-key": "pending:0:user" }, [], "pending prompt"),
        ]),
      );
    expect(evaluate(expression, ready.document)).toBe(-1);
  });
  test("does not poll disabled or still-generating file cards", () => {
    const expression = fileExpressions.buildAssistantFileCardTurnIndexExpression();
    for (const state of ["disabled", "busy"] as const) {
      const { document, assistant } = fixture();
      assistant.append(
        node("button", {
          "aria-label": "Download file",
          ...(state === "disabled" ? { disabled: "" } : {}),
        }),
      );
      assistant.append(
        node("button", {
          "aria-label": "Open preview of result.txt",
          "aria-busy": state === "busy" ? "true" : "false",
        }),
      );
      expect(evaluate(expression, document)).toBe(-1);
    }
  });
  test.each(["Chat", "Work"])("reads %s from the pressed Composer mode group", (selected) => {
    const buttons = ["Chat", "Work"].map((label) =>
      node("button", { "aria-pressed": String(label === selected) }, [], label),
    );
    const document = new FakeDocument([
      node("div", { role: "group", "aria-label": "Composer mode" }, buttons),
    ]);
    expect(evaluate(buildChatModeProbeExpressionForTest(), document)).toMatchObject({
      status: selected === "Chat" ? "chat-selected" : "work-selected",
    });
  });
  test.each([true, false])(
    "normalizes content references only for file cards (%s)",
    async (fileCard) => {
      const markdown =
        ':chatgpt-content-reference{index="0"}[Download result.txt](sandbox:/mnt/data/result.txt)';
      const r = {
        evaluate: async () => ({ result: { value: { success: true, markdown, fileCard } } }),
      } as unknown as ChromeClient["Runtime"];
      expect(await captureAssistantMarkdown(r, {}, () => {})).toBe(
        fileCard ? "[Download result.txt](sandbox:/mnt/data/result.txt)" : markdown,
      );
    },
  );
});
