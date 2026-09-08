import { describe, expect, test } from "vitest";
import { buildWebSearchVerificationExpression } from "../../src/browser/actions/webSearch.js";
import { FakeDocument, FakeElement } from "./domFixture.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { buildConsultBrowserConfig } from "../../src/mcp/tools/consult.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

class Element extends FakeElement {
  nodeType = 1;
  constructor(
    tag: string,
    readonly attrs: Record<string, string> = {},
    children: Element[] = [],
    readonly text = "",
  ) {
    super(tag, attrs, children, text);
  }
  get nodeName() {
    return this.tagName;
  }
  get childNodes(): Array<Element | { nodeType: number; textContent: string }> {
    return [
      ...(this.text ? [{ nodeType: 3, textContent: this.text }] : []),
      ...(this.children as Element[]),
    ];
  }
  cloneNode(): Element {
    return new Element(
      this.tagName,
      { ...this.attrs },
      (this.children as Element[]).map((child) => child.cloneNode()),
      this.text,
    );
  }
}

describe("Web Search inline selection", () => {
  test.each(["search", "github"])("requires the exact search hint, not %s", (id) => {
    const chip = new Element(
      "span",
      { "data-inline-selection-pill": "", "data-id": id, "data-system-hint-type": id },
      [],
      "Web search",
    );
    const editor = new Element("div", { id: "prompt-textarea", contenteditable: "true" }, [
      new Element("p", {}, [chip], "First line"),
      new Element("p", {}, [], "Second line"),
    ]);
    const document = new FakeDocument([editor]);
    const evaluate = (prompt: string) =>
      new Function(
        "document",
        "HTMLElement",
        `return ${buildWebSearchVerificationExpression(prompt)}`,
      )(document, FakeElement);
    expect(evaluate("First line\nSecond line")).toEqual({
      selected: id === "search",
      promptMatches: true,
    });
    expect(evaluate("Lost or replaced prompt").promptMatches).toBe(false);
  });
  test("keeps CLI, saved configuration, and MCP modes consistent", async () => {
    expect(
      (await buildBrowserConfig({ model: "gpt-5.5-pro", browserResearch: "search" })).researchMode,
    ).toBe("search");
    expect(resolveBrowserConfig({ researchMode: "search" }).researchMode).toBe("search");
    expect(
      buildConsultBrowserConfig({
        userConfig: {},
        env: {},
        runModel: "gpt-5.5-pro",
        browserResearchMode: "search",
      }).researchMode,
    ).toBe("search");
    expect(resolveBrowserConfig({}).researchMode).toBe("off");
  });
  test("refuses remote hosts before connecting instead of silently losing the requested tool", async () => {
    const execute = createRemoteBrowserExecutor({ host: "127.0.0.1:1" });
    await expect(execute({ prompt: "search", config: { researchMode: "search" } })).rejects.toThrow(
      "does not negotiate this capability",
    );
  });
});
