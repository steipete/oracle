import { describe, expect, test, vi } from "vitest";
import {
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../../src/browser/conversationTurns.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

function evaluate(expression: string, responses: Map<string, unknown[]>): unknown {
  const document = {
    querySelectorAll: vi.fn((selector: string) => responses.get(selector) ?? []),
  };
  return Function("document", `return ${expression};`)(document);
}

describe("conversation turn expressions", () => {
  test("counts the current ChatGPT user turn after an attachment send", () => {
    const userTurn = new FakeElement(
      "div",
      { "data-content-search-unit-key": "fallback-turn-0:0:user" },
      [new FakeElement("div", { "data-user-message-bubble": "true" }, [], "Sent prompt")],
    );
    const document = new FakeDocument([userTurn]);
    expect(
      Function("document", `return ${buildConversationTurnCountExpression()};`)(document),
    ).toBe(1);
  });

  test("counts outer and nested keyed markers as one turn each", () => {
    const user = new FakeElement("article", { "data-testid": "conversation-turn-0" }, [
      new FakeElement("div", { "data-content-search-unit-key": "fallback-turn-0:0:user" }),
    ]);
    const assistant = new FakeElement("article", { "data-testid": "conversation-turn-1" }, [
      new FakeElement("div", { "data-content-search-unit-key": "fallback-turn-0:1:assistant" }),
    ]);
    const document = new FakeDocument([user, assistant]);
    expect(
      Function("document", `return ${buildConversationTurnListExpression()};`)(document),
    ).toEqual([user, assistant]);
    expect(
      Function("document", `return ${buildConversationTurnCountExpression()};`)(document),
    ).toBe(2);
  });

  test("prefers top-level turn containers over nested broad-selector matches", () => {
    const containers = [{ id: "user" }, { id: "assistant" }];
    const nestedMatches = [...containers, { id: "nested-assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, containers],
      [CONVERSATION_TURN_SELECTOR, nestedMatches],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(containers);
    expect(evaluate(buildConversationTurnCountExpression(), responses)).toBe(2);
  });

  test("falls back to the broad selector for older conversation markup", () => {
    const legacyTurns = [{ id: "user" }, { id: "assistant" }];
    const responses = new Map([
      [CONVERSATION_TURN_CONTAINER_SELECTOR, []],
      [CONVERSATION_TURN_SELECTOR, legacyTurns],
    ]);

    expect(evaluate(buildConversationTurnListExpression(), responses)).toEqual(legacyTurns);
  });
});
