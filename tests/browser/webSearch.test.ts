import { describe, expect, test, vi } from "vitest";
import {
  buildWebSearchSelectionExpression,
  buildWebSearchVerificationExpression,
  matchesWebSearchMenuLabel,
} from "../../src/browser/actions/webSearch.js";
import { FakeDocument, FakeElement } from "./domFixture.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { buildConsultBrowserConfig } from "../../src/mcp/tools/consult.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";

function toolsMenu(button: FakeElement): FakeElement {
  return new FakeElement("div", { "data-composer-overlay-floating-ui": "true" }, [
    new FakeElement("div", { "data-mention-section-id": "chatgpt-primary" }, [
      new FakeElement("div", { "data-mention-section-items": "true" }, [button]),
    ]),
  ]);
}

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
  test.each([
    "Search",
    "SearchFind on the web",
    "Web search",
    "Web searchFind real-time news and info",
    "网页搜索",
    "网页搜索查找实时新闻和信息",
  ])("recognizes the exact documented or observed menu label %s", (label) => {
    expect(matchesWebSearchMenuLabel(label)).toBe(true);
    expect(matchesWebSearchMenuLabel(`GitHub ${label}`)).toBe(false);
    expect(matchesWebSearchMenuLabel(`${label} settings`)).toBe(false);
  });
  test("verifies the semantic search pill without the legacy data-id", () => {
    const chip = new Element(
      "span",
      {
        "data-inline-selection-pill": "",
        "data-system-hint-type": "search",
        "data-prompt-link-href": "chatgpt-system-hint://search",
      },
      [],
      "Web search",
    );
    const editor = new Element("div", { contenteditable: "true", role: "textbox" }, [
      new Element("p", {}, [chip], "Find official sources"),
    ]);
    const document = new FakeDocument([editor]);
    const evaluate = (prompt: string) =>
      new Function(
        "document",
        "HTMLElement",
        `return ${buildWebSearchVerificationExpression(prompt)}`,
      )(document, FakeElement);
    expect(evaluate("Find official sources")).toEqual({ selected: true, promptMatches: true });
    expect(evaluate("A different prompt").promptMatches).toBe(false);
    chip.setAttribute("data-system-hint-type", "deep_research");
    expect(evaluate("Find official sources").selected).toBe(false);
  });

  test.each([
    {
      label: "Web searchFind real-time news and info",
      disabled: false,
      inMenu: true,
      expected: "clicked",
    },
    { label: "网页搜索查找实时新闻和信息", disabled: false, inMenu: true, expected: "clicked" },
    {
      label: "Web searchFind real-time news and info",
      disabled: true,
      inMenu: true,
      expected: "missing",
    },
    {
      label: "Web searchFind real-time news and info",
      disabled: false,
      inMenu: false,
      expected: "missing",
    },
    {
      label: "GitHub Web searchFind real-time news and info",
      disabled: false,
      inMenu: true,
      expected: "missing",
    },
  ])(
    "selects only an exact enabled search row in the tools menu: %j",
    ({ label, disabled, inMenu, expected }) => {
      const button = new FakeElement(
        "button",
        {
          "data-list-navigation-item": "true",
          ...(disabled ? { disabled: "" } : {}),
        },
        [],
        label,
      );
      const dispatchEvent = vi.fn();
      Object.assign(button, { dispatchEvent });
      const document = new FakeDocument(inMenu ? [toolsMenu(button)] : [button]);
      const window = {
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      };
      const result = new Function(
        "document",
        "HTMLElement",
        "window",
        "location",
        "URL",
        "EventTarget",
        "MouseEvent",
        `return ${buildWebSearchSelectionExpression("https://chatgpt.com/")}`,
      )(document, FakeElement, window, new URL("https://chatgpt.com/"), URL, FakeElement, class {});
      expect(result).toBe(expected);
      expect(dispatchEvent).toHaveBeenCalledTimes(expected === "clicked" ? 5 : 0);
    },
  );
  test("ignores an unrelated mention list before the composer tools menu", () => {
    const unrelated = new FakeElement(
      "button",
      { "data-list-navigation-item": "true" },
      [],
      "Web search",
    );
    const search = new FakeElement(
      "button",
      { "data-list-navigation-item": "true" },
      [],
      "Web search",
    );
    const unrelatedDispatch = vi.fn();
    const searchDispatch = vi.fn();
    Object.assign(unrelated, { dispatchEvent: unrelatedDispatch });
    Object.assign(search, { dispatchEvent: searchDispatch });
    const document = new FakeDocument([
      new FakeElement("div", { role: "listbox" }, [
        new FakeElement("div", { "data-mention-section-items": "true" }, [unrelated]),
      ]),
      toolsMenu(search),
    ]);
    const result = new Function(
      "document",
      "HTMLElement",
      "window",
      "location",
      "URL",
      "EventTarget",
      "MouseEvent",
      `return ${buildWebSearchSelectionExpression("https://chatgpt.com/")}`,
    )(
      document,
      FakeElement,
      { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      new URL("https://chatgpt.com/"),
      URL,
      FakeElement,
      class {},
    );
    expect(result).toBe("clicked");
    expect(unrelatedDispatch).not.toHaveBeenCalled();
    expect(searchDispatch).toHaveBeenCalledTimes(5);
  });
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
