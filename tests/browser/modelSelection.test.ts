import { describe, expect, it } from "vitest";
import {
  buildComposerSignalMatchersForTest,
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
} from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

describe("browser model selection matchers", () => {
  it("includes pro + 5.5 tokens for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens).toContain("pro extended");
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.5-pro") || t.includes("gpt-5-5-pro"))).toBe(
      true,
    );
  });

  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
  });

  it("includes rich tokens for gpt-5.1", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.1");
    expectContains(labelTokens, "gpt-5.1");
    expectContains(labelTokens, "gpt-5-1");
    expectContains(labelTokens, "gpt51");
    expectContains(labelTokens, "chatgpt 5.1");
    expectContains(testIdTokens, "gpt-5-1");
    expect(
      testIdTokens.some(
        (t) => t.includes("gpt-5.1") || t.includes("gpt-5-1") || t.includes("gpt51"),
      ),
    ).toBe(true);
  });

  it("includes pro/research tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro") || t.includes("research"))).toBe(true);
    expectContains(testIdTokens, "gpt-5.2-pro");
    expect(testIdTokens.some((t) => t.includes("model-switcher-gpt-5.2-pro"))).toBe(true);
  });

  it("includes pro + 5.2 tokens for gpt-5.2-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.2-pro") || t.includes("gpt-5-2-pro"))).toBe(
      true,
    );
  });

  it("includes thinking tokens for gpt-5.2-thinking", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-thinking");
    expect(labelTokens.some((t) => t.includes("thinking"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-thinking");
    expect(testIdTokens).toContain("gpt-5.2-thinking");
  });

  it("includes instant tokens for gpt-5.2-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.2-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.2") || t.includes("5-2"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-2-instant");
    expect(testIdTokens).toContain("gpt-5.2-instant");
  });

  it("closes the menu after a successful selection path", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4");
    expect(expression).toContain("const closeMenu = () =>");
    expect(expression).toContain("key: 'Escape'");
    expect(expression).toContain("closeMenu();");
  });

  it("recognizes current GPT-5.5 visible aliases in the picker expression", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("isTargetGpt55VisibleAlias");
    expect(expression).toContain("label.includes('pro') && label.includes('extended')");
    expect(expression).toContain("desiredVersion === '5-5'");
  });

  it("builds composer footer matchers for generic ChatGPT header states", () => {
    expect(buildComposerSignalMatchersForTest("GPT-5.5 Pro")).toEqual({
      includesAny: ["pro"],
      excludesAny: ["thinking"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("Thinking 5.5")).toEqual({
      includesAny: ["thinking"],
      excludesAny: ["pro"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("GPT-5.2 Instant")).toEqual({
      includesAny: [],
      excludesAny: ["thinking", "pro"],
      allowBlank: true,
    });
  });

  it("waits for composer footer state when the header button stays generic", () => {
    const expression = buildModelSelectionExpressionForTest("GPT-5.5 Pro");
    expect(expression).toContain("const readComposerModelSignal = () =>");
    expect(expression).toContain("const activeSelectionMatchesTarget = () =>");
    expect(expression).toContain(
      "const waitForTargetSelection = (previousButtonLabel, previousComposerSignal) =>",
    );
  });

  it("accepts a post-click state change even when the footer text is localized", () => {
    const expression = buildModelSelectionExpressionForTest("Thinking 5.5");
    expect(expression).toContain(
      "const selectionStateChanged = (previousButtonLabel, previousComposerSignal) =>",
    );
    expect(expression).toContain("const previousComposerSignal = readComposerModelSignal();");
    expect(expression).toContain("const previousButtonLabel = normalizeText(getButtonLabel());");
    expect(expression).toContain(".trailing svg");
  });

  it("finds the rewritten ChatGPT composer pill model button", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain('data-testid="model-switcher-dropdown-button"');
    expect(expression).toContain("button.__composer-pill[aria-haspopup=");
  });
});
