import { describe, expect, it } from "vitest";
import { buildThinkingTimeExpressionForTest } from "../../src/browser/actions/thinkingTime.js";

describe("browser thinking-time selection expression", () => {
  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("supports ChatGPT's model-menu thinking effort control", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("MODEL_BUTTON_SELECTOR");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("aria-controls");
    expect(expression).toContain("LEVEL_TOKENS");
  });

  it("prefers the effort control attached to the requested model row", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain('const TARGET_MODEL = "gpt-5.5-pro"');
    expect(expression).toContain("const modelRowMatchesTarget = (row) =>");
    expect(expression).toContain("if (targetWantsPro && !text.includes('pro')) return false;");
    expect(expression).toContain("if (!targetWantsPro && text.includes('pro')) return false;");
    expect(expression).toContain("if (modelRowMatchesTarget(row)) return t;");
  });

  it("keeps regular GPT-5.5 thinking-time requests on the non-Pro row", () => {
    const expression = buildThinkingTimeExpressionForTest("heavy", "Thinking 5.5");
    expect(expression).toContain('const TARGET_MODEL = "Thinking 5.5"');
    expect(expression).toContain("const targetWantsPro = normalizedTargetModel.includes('pro');");
    expect(expression).toContain(
      "const targetWantsThinking = normalizedTargetModel.includes('thinking');",
    );
    expect(expression).toContain("if (!targetWantsPro && text.includes('pro')) return false;");
    expect(expression).toContain(
      "if (targetWantsThinking && !text.includes('thinking')) return false;",
    );
    expect(expression).toContain("if (modelRowMatchesTarget(row)) return t;");
  });

  it("activates the requested model row after changing its effort", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain('[class*="model-picker-thinking-effort-row"]');
    expect(expression).toContain('data-model-picker-thinking-effort-menu-item="true"');
    expect(expression).toContain("const targetModelRow = getModelRowForTrailing(trailing);");
    expect(expression).toContain("if (!effortAlreadySelected)");
    expect(expression).toContain("!optionIsSelected(targetModelRow)");
    expect(expression).toContain("dispatchClickSequence(targetModelRow);");
  });

  it("preserves Chinese thinking-effort labels while normalizing", () => {
    const expression = buildThinkingTimeExpressionForTest("heavy");
    expect(expression).toContain("\\u4e00-\\u9fa5");
    expect(expression).toContain("'重度'");
  });
});
