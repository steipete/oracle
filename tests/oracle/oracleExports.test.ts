import { describe, expect, test } from "vitest";
import * as oracle from "../../src/oracle.js";

describe("oracle entrypoint exports", () => {
  test("exposes core helpers", () => {
    expect(oracle.DEFAULT_MODEL).toBeDefined();
    expect(typeof oracle.createDefaultClientFactory).toBe("function");
    expect(typeof oracle.runOracle).toBe("function");
    expect(typeof oracle.formatFileSection).toBe("function");
    expect(typeof oracle.formatFileSections).toBe("function");
    expect(oracle.PRO_MODELS instanceof Set).toBe(true);
  });

  test("preserves raw exported file-section formatting by default", () => {
    const rawDefault = oracle.formatFileSection("a.txt", "hello");
    expect(rawDefault).not.toContain("Lines:");
    expect(rawDefault).toContain("```\nhello\n```");

    const numbered = oracle.formatFileSection("a.txt", "hello", { lineNumbers: true });
    expect(numbered).toContain("Lines: 1-1");
    expect(numbered).toContain("1 | hello");
  });

  test("exposes generated file-section list formatting", () => {
    const out = oracle.formatFileSections([
      { displayPath: "a.txt", content: "hello" },
      { displayPath: "b.txt", content: "world" },
    ]);
    expect(out).toContain("### File: a.txt");
    expect(out).toContain("1 | hello");
    expect(out).toContain("\n\n### File: b.txt");
    expect(out).toContain("1 | world");
  });

  test("asks models to use line-specific file citations", () => {
    expect(oracle.DEFAULT_SYSTEM_PROMPT).toContain("path:line");
    expect(oracle.DEFAULT_SYSTEM_PROMPT).toContain("path:line-line");
  });
});
