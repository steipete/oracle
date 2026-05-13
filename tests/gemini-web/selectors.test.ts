import { describe, expect, it } from "vitest";
import { GEMINI_DEEP_THINK_MANIFEST, getManifestSelectors, getManifestSelectorLiteral } from "../../src/gemini-web/selectors/geminiDeepThinkManifest.js";

describe("Gemini Deep Think Selector Manifest", () => {
  it("has correct provider and purpose", () => {
    expect(GEMINI_DEEP_THINK_MANIFEST.provider).toBe("gemini-web");
    expect(GEMINI_DEEP_THINK_MANIFEST.purpose).toBe("deep-think-orchestration");
  });

  it("contains all required orchestration selectors", () => {
    const s = GEMINI_DEEP_THINK_MANIFEST.selectors;
    expect(s.input.primary).toBeDefined();
    expect(s.sendButton.primary).toBeDefined();
    expect(s.toolsButton.primary).toBeDefined();
    expect(s.toolsMenuItem.primary).toBeDefined();
    expect(s.deepThinkActive.primary).toBeDefined();
    expect(s.responseTurn.primary).toBeDefined();
    expect(s.responseText.primary).toBeDefined();
    expect(s.responseComplete.primary).toBeDefined();
    expect(s.thoughtsToggle.primary).toBeDefined();
    expect(s.thoughtsContent.primary).toBeDefined();
    expect(s.spinner.primary).toBeDefined();
  });

  it("produces valid selector strings", () => {
    const selectors = getManifestSelectors(GEMINI_DEEP_THINK_MANIFEST.selectors.input);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors[0]).toBe("rich-textarea .ql-editor");

    const literal = getManifestSelectorLiteral(GEMINI_DEEP_THINK_MANIFEST.selectors.input);
    expect(literal).toContain("rich-textarea .ql-editor");
  });

  it("includes thinking level control metadata", () => {
    expect(GEMINI_DEEP_THINK_MANIFEST.thinkingLevelControl).toBeDefined();
    expect(GEMINI_DEEP_THINK_MANIFEST.thinkingLevelControl?.options.high).toBe("high");
  });
});
