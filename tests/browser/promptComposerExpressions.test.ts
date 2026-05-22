import { describe, expect, test } from "vitest";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.ts";

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[];
  readonly tagName: string;

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: FakeElement[] = [],
    private readonly ownText = "",
  ) {
    this.tagName = tagName.toUpperCase();
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  get innerText(): string {
    return this.textContent;
  }

  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return flattenElements(this.children).filter((element) => matchesSelector(element, selector));
  }
}

class FakeInputElement extends FakeElement {
  constructor(readonly files: Array<{ name: string }>) {
    super("input", { type: "file" });
  }
}

class FakeDocument {
  readonly body: FakeElement;

  constructor(children: FakeElement[]) {
    this.body = new FakeElement("body", {}, children);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
}

function flattenElements(elements: FakeElement[]): FakeElement[] {
  return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  const normalized = selector.replace(/:not\([^)]*\)/g, "");
  const tag = normalized.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  const id = normalized.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && element.getAttribute("id") !== id) return false;

  const attrPattern = /\[([^\]\s~|^$*!=]+)(\*?=)?(?:"([^"]*)"|'([^']*)')?\s*i?\]/g;
  for (const match of normalized.matchAll(attrPattern)) {
    const [, name, operator, doubleQuotedValue, singleQuotedValue] = match;
    const expected = doubleQuotedValue ?? singleQuotedValue ?? "";
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !actual.toLowerCase().includes(expected.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function evaluateAttachmentReadyExpression(
  attachmentNames: string[],
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
    // ChatGPT can rename duplicate uploads as e.g. README(1).md; matching on the
    // expected basename stem keeps the send check aligned with the upload check.
    expect(expression).toContain("item.stem");
    expect(expression).toContain("text.includes(item.stem + '(')");
    // Count-based fallback: when ChatGPT hides the filename entirely, accept that we
    // see at least as many chip-shaped nodes (each with a Remove affordance) as we
    // uploaded.
    expect(expression).toContain("countReady");
    expect(expression).toContain("removeAffordances");
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

  test("attachment ready count fallback counts remove affordances inside one wrapper", () => {
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

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback accepts generic remove controls under chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback allows mixed visible and hidden chip labels", () => {
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

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback ignores prompt text extensions", () => {
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

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback ignores decimal size text", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "1.2 MB"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
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
