import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  buildStopButtonVisibilityExpressionForTest,
  matchesThinkingStatusLabelForTest,
  shouldConfirmAssistantCompletion,
} from "../../src/browser/actions/assistantResponse.js";
import { STOP_BUTTON_SELECTORS } from "../../src/browser/constants.js";

function evaluatePredicate(text: string, generating: boolean): boolean {
  const predicate = buildActiveThinkingStatusPredicateJsForTest("isActiveThinkingStatus");
  class FakeHtmlElement {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    }
  }
  const context = createContext({
    Array,
    Number,
    String,
    HTMLElement: FakeHtmlElement,
    document: {
      querySelectorAll: () => (generating ? [new FakeHtmlElement()] : []),
    },
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });
  return new Script(
    `${predicate}\nisActiveThinkingStatus({ text: ${JSON.stringify(text)} });`,
  ).runInContext(context) as boolean;
}

describe("assistant thinking-status capture", () => {
  const statusLabels = [
    "Pro thinking",
    "Finalizing answer",
    "Thinking",
    "Reading",
    "Thought for 12s",
    "Pro thinking - planning",
  ];

  test.each(statusLabels)("suppresses active status label %j", (label) => {
    expect(matchesThinkingStatusLabelForTest(label)).toBe(true);
    expect(evaluatePredicate(label, true)).toBe(true);
  });

  test.each(statusLabels)("preserves completed exact answer %j", (label) => {
    expect(evaluatePredicate(label, false)).toBe(false);
  });

  test("does not suppress normal text while generation is active", () => {
    expect(evaluatePredicate("Thinking about the design, use Postgres.", true)).toBe(false);
  });

  test("uses the active-status predicate in snapshot capture", () => {
    const expression = buildAssistantSnapshotExpressionForTest();
    expect(expression).toContain("isActiveThinkingStatus");
    expect(expression).toContain('data-testid=\\"stop-button\\"');
    expect(expression).toContain("const fallback = extractFallback();");
  });

  test("shares all stop-control selectors with completion capture", () => {
    let observedSelector = "";
    new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: class {},
        document: {
          querySelectorAll: (selector: string) => {
            observedSelector = selector;
            return [];
          },
        },
        window: { getComputedStyle: () => ({}) },
      }),
    );
    expect(observedSelector).toBe(STOP_BUTTON_SELECTORS.join(", "));
  });

  test.each([
    {
      width: 120,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: true,
    },
    {
      width: 0,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
    {
      width: 120,
      height: 40,
      display: "none",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
  ])("requires a visible stop control before blocking completion: %o", (fixture) => {
    class FakeHtmlElement {
      getBoundingClientRect() {
        return { width: fixture.width, height: fixture.height };
      }
    }
    const result = new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: FakeHtmlElement,
        document: { querySelectorAll: () => [new FakeHtmlElement()] },
        window: {
          getComputedStyle: () => ({
            display: fixture.display,
            visibility: fixture.visibility,
            opacity: fixture.opacity,
          }),
        },
      }),
    );
    expect(result).toBe(fixture.expected);
  });
});

describe("shouldConfirmAssistantCompletion", () => {
  test("confirms while the stop button is visible", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: true,
        completionVisible: false,
      }),
    ).toBe(true);
  });

  test("confirms while completion controls are visible", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: false,
        completionVisible: true,
      }),
    ).toBe(true);
  });

  test("confirms an implausibly short capture even when no controls are visible", () => {
    // The thinking-UI flapping case: stop button already gone, completion
    // controls not yet shown, a stub answer ("I") captured mid-stream.
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 1,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(true);
  });

  test("trusts a long capture once controls have cleared", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });

  test("does not force confirmation for an empty capture (handled elsewhere)", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 0,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });

  test("uses length 16 as the confidence boundary", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 15,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(true);
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 16,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });
});
