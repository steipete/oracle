import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

describe("prompt composer attachment expressions", () => {
  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("document.querySelector('[data-testid*=\"composer\"]')");
    expect(expression).toContain("attachmentRoots");
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain('[aria-label*="Remove file"]');
    // Composer-internal nodes (the editable prompt itself) must not be treated as chips,
    // otherwise prompt text containing the filename would falsely satisfy the check.
    expect(expression).toContain("closest('textarea,[contenteditable=\"true\"]')");
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });

  test("attachment ready check tolerates ChatGPT chip DOM that omits filename in attributes", () => {
    const expression = buildAttachmentReadyExpressionForTest(["paper1_plan_v3.md"]);
    // Walks into ancestor and descendant text so filenames buried in nested spans are still found.
    expect(expression).toContain("collectLabelHaystack");
    expect(expression).toContain("parentElement");
    // Count-based fallback: when ChatGPT hides the filename entirely, accept that we
    // see at least as many chip-shaped nodes (each with a Remove affordance) as we
    // uploaded.
    expect(expression).toContain("countReady");
    expect(expression).toContain("removeAffordanceCount");
  });
});
