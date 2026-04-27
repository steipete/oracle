import { describe, expect, test } from "vitest";
import { buildComposerSendReadinessExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

describe("prompt composer attachment expressions", () => {
  test("composer readiness check scopes attachment evidence to the composer", () => {
    const expression = buildComposerSendReadinessExpressionForTest();
    expect(expression).toContain("locateComposerRoot");
    expect(expression).toContain("composerScope.querySelectorAll");
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain("attachmentUiCount");
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });
});
