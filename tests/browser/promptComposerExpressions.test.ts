import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

import { FakeElement, FakeInputElement, FakeDocument } from "./domFixture.js";

function evaluateAttachmentReadyExpression(
  attachmentNames: Array<string | { name: string; generatedBundle?: boolean }>,
  document: FakeDocument,
): boolean {
  const expression = buildAttachmentReadyExpressionForTest(attachmentNames);
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "HTMLInputElement",
    `return ${expression};`,
  ) as (
    document: FakeDocument,
    HTMLElement: typeof FakeElement,
    HTMLInputElement: typeof FakeInputElement,
  ) => boolean;
  return evaluate(document, FakeElement, FakeInputElement);
}

describe("prompt composer attachment expressions", () => {
  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("closestComposerRoot(sendButton)");
    expect(expression).toContain("firstComposerRoot()");
    expect(expression).not.toContain("document.querySelector('[data-testid*=\"composer\"]') ||");
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
    expect(expression).toContain("__oracleAttachmentEvidence");
    expect(expression).not.toContain("countReady");
  });

  test("attachment ready check stays scoped to the active composer", () => {
    const expression = buildAttachmentReadyExpressionForTest(["paper1_plan_v3.md"]);

    expect(expression).toContain("const attachmentRoots = Array.from(new Set([composer]))");
    expect(expression).not.toContain("new Set([composer, document])");
  });

  test("attachment ready check ignores a composer-plus button before the real form", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [
        new FakeElement("button", { "data-testid": "composer-plus-btn" }),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          "Diagnostic attachment send readiness repro. Reply exactly OK.",
        ),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check prefers composer roots over unrelated forms", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [], "Search chats"),
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check uses send button composer wrapper before its form", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("form", {}, [
          new FakeElement("button", {
            "aria-label": "Send prompt",
            "data-testid": "send-button",
          }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check skips footer action wrappers around send button", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("div", { "data-testid": "composer-footer-actions" }, [
          new FakeElement("button", {
            "aria-label": "Send prompt",
            "data-testid": "send-button",
          }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check tolerates duplicate-renamed chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(true);
  });

  test.each([
    ["01.jpg", "01(5).jpg"],
    ["document.md", "document(20260818-145702).md"],
    ["document.md", "document.md"],
    ["a+b.jpg", "a+b(2).jpg"],
    ["가01.jpg", "가01(5).jpg"],
    ["é01.jpg", "é01(5).jpg"],
    ["𐐀01.jpg", "𐐀01(5).jpg"],
    ["01.jpg", "01 (5).jpg"],
  ])("attachment ready check matches %s to %s", (expectedName, actualName) => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], actualName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${actualName}` }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([expectedName], document)).toBe(true);
  });

  test.each([
    "010.jpg",
    "02(5).jpg",
    "가01(5).jpg",
    "é01(5).jpg",
    "01(5).jpgé",
    "\u030101(5).jpg",
    "𐐀01(5).jpg",
  ])("attachment ready check does not match 01.jpg to %s", (actualName) => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], actualName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${actualName}` }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["01.jpg"], document)).toBe(false);
  });

  test.each(["가README(5).md", "éREADME(5).md", "README(5).mdé", "README(5).md.bak"])(
    "attachment ready check does not match README.md to %s",
    (actualName) => {
      const document = new FakeDocument([
        new FakeElement("div", { "data-testid": "unified-composer" }, [
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("span", {}, [], actualName),
            new FakeElement("button", { "aria-label": `Remove file 1: ${actualName}` }),
          ]),
        ]),
      ]);
      expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
    },
  );

  test("attachment ready check accepts generated bundle chips that expose only the bundle stem", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { role: "group", "aria-label": "attachments-bundle" }, [
          new FakeElement("span", {}, [], "Document"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check keeps stem-only fallback off for user bundle-named files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { role: "group", "aria-label": "attachments-bundle" }, [
          new FakeElement("span", {}, [], "Document"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["attachments-bundle.txt"], document)).toBe(false);
  });

  test("attachment ready check accepts duplicate-renamed generated bundle chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle(13).txt"),
          new FakeElement("button", { "aria-label": "Remove file 1: attachments-bundle(13).txt" }),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check rejects duplicate-renamed generated bundle chips with the wrong extension", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle(13).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: attachments-bundle(13).md" }),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check accepts generated zip bundle chips that expose only the bundle stem", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.zip", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check does not use stem-only fallback for non-bundle files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README"),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready check does not match generated bundle stem inside another filename", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "not-attachments-bundle.txt"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check does not match generated bundle stem with a different extension", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle.md"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check does not let one duplicate-renamed chip satisfy same-stem files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md", "README.txt"], document)).toBe(false);
  });

  test("attachment ready check does not match extension prefixes in duplicate-renamed chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).mdx"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).mdx" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready check does not match extension prefixes in visible chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README.mdx"),
          new FakeElement("button", { "aria-label": "Remove file 1: README.mdx" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready rejects unnamed controls without per-file upload evidence", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-list" }, [
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("button", { "aria-label": "Remove file 1" }),
          ]),
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("button", { "aria-label": "Remove file 2" }),
          ]),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(false);
  });

  test("attachment ready rejects generic remove controls without upload evidence", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(false);
  });

  test("attachment ready requires evidence for the hidden file in a mixed set", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "one.txt"),
          new FakeElement("button", { "aria-label": "Remove file 1: one.txt" }),
        ]),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove file 2" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(false);
  });

  test("attachment ready cannot use prompt text to identify an unnamed attachment", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          "Please compare this with notes.md",
        ),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(false);
  });

  test("attachment ready cannot use a size label to identify an unnamed attachment", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "1.2 MB"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(false);
  });

  test("attachment ready count fallback ignores unrelated remove controls", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("button", { "aria-label": "Remove item" }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(false);
  });

  test("attachment ready check tolerates ellipsized chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…v3"),
          new FakeElement("button", { "aria-label": "Remove file 1: paper1…v3" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check tolerates ellipsized chip names with extensions", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…v3.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: paper1…v3.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check tolerates ellipsized chip names with spaced prefixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "my paper…v3.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: my paper…v3.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["my paper_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check rejects ambiguous ellipsis placeholders", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "...md"),
          new FakeElement("button", { "aria-label": "Remove file 1: ...md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper.md"], document)).toBe(false);
  });

  test("attachment ready check rejects unrelated ellipsized chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "ape…md"),
          new FakeElement("button", { "aria-label": "Remove file 1: ape…md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["scrapegoat.md"], document)).toBe(false);
  });

  test("attachment ready check rejects ambiguous short ellipsized prefixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "a…md"),
          new FakeElement("button", { "aria-label": "Remove file 1: a…md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["anything.md"], document)).toBe(false);
  });

  test("attachment ready check accepts short ellipsized prefixes with strong suffixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "qa…v1.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: qa…v1.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["qa-quarterly-report-v1.md"], document)).toBe(true);
  });

  test("attachment ready requires upload evidence for a prefix-only truncated label", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(false);
  });

  test("attachment ready check still rejects prompt-only filename matches", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [
        new FakeElement("button", { "data-testid": "composer-plus-btn" }),
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          `Please mention ${fileName} without uploading it.`,
        ),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(false);
  });
});
