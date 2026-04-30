import { performance } from "node:perf_hooks";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
} from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

class FakeElement extends EventTarget {
  private readonly attrs = new Map<string, string>();

  constructor(
    public textContent = "",
    attrs: Record<string, string> = {},
    private readonly children: FakeElement[] = [],
    private readonly onClick?: () => void,
  ) {
    super();
    for (const [key, value] of Object.entries(attrs)) {
      this.attrs.set(key, value);
    }
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getBoundingClientRect() {
    return { height: 32, width: 160 };
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return this.children;
  }

  dispatchEvent(event: Event) {
    if (event.type === "click") {
      this.onClick?.();
    }
    return super.dispatchEvent(event);
  }
}

class FakeDocument extends EventTarget {
  readonly body = { innerText: "" };
  readonly title = "";

  constructor(
    private readonly modelCandidates: FakeElement[] = [],
    private readonly menus: FakeElement[] = [],
  ) {
    super();
  }

  querySelector(selector: string) {
    if (selector.includes('[role="menu"]') || selector.includes("data-radix-collection-root")) {
      return this.menus[0] ?? null;
    }
    return null;
  }

  querySelectorAll(selector: string) {
    if (
      selector.includes('data-testid="model-switcher-dropdown-button"') ||
      selector.includes("__composer-pill")
    ) {
      return this.modelCandidates;
    }
    if (selector.includes('[role="menu"]') || selector.includes("data-radix-collection-root")) {
      return this.menus;
    }
    return [];
  }
}

const runModelSelectionExpression = async (
  targetModel: string,
  document: FakeDocument,
  options: { fastTimeout?: boolean } = {},
) => {
  const expression = buildModelSelectionExpressionForTest(targetModel);
  let now = 0;
  const context = createContext({
    document,
    EventTarget,
    HTMLElement: FakeElement,
    KeyboardEvent: Event,
    MouseEvent: Event,
    performance: options.fastTimeout
      ? {
          now: () => {
            now += 25_000;
            return now;
          },
        }
      : performance,
    setTimeout: options.fastTimeout
      ? (callback: () => void) => {
          callback();
          return 0;
        }
      : setTimeout,
    URL,
    window: { location: { href: "https://chatgpt.com/" } },
  });
  return await new Script(expression).runInContext(context);
};

describe("browser model selection matchers", () => {
  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
  });

  it("requires a 5.5 label match for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.5-pro") || t.includes("gpt-5-5-pro"))).toBe(
      true,
    );

    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("normalizedTarget.includes('5 5')");
    expect(expression).toContain("desiredVersion === '5-5'");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("score += 1000");
    expect(expression).toContain("const isEffortOnly = label === 'pro' || label === 'thinking'");
    expect(expression).toContain("isTargetGpt55VisibleAlias");
    expect(expression).toContain("best.score >= 100");
    expect(expression).toContain("return { status: 'button-missing' }");
    expect(expression).toContain("candidateTextVersion && candidateTextVersion !== desiredVersion");
    expect(expression).toContain(
      "candidateTestIdVersion && candidateTestIdVersion !== desiredVersion",
    );
    expect(expression).toContain("!candidateGpt55VisibleAlias");
  });

  it("does not accept a generic Pro pill as gpt-5.5-pro under select strategy", async () => {
    const proChip = new FakeElement("Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const result = await runModelSelectionExpression("gpt-5.5-pro", new FakeDocument([proChip]), {
      fastTimeout: true,
    });

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("does not accept a visible effort chip as gpt-5.5-pro under select strategy", async () => {
    const effortChip = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([effortChip]),
      {
        fastTimeout: true,
      },
    );

    expect(result).toMatchObject({ status: "option-not-found" });
  });

  it("selects GPT-5.5 Pro from the composer-pill model picker DOM", async () => {
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement(
      "Pro• Extended",
      { "data-testid": "model-switcher-gpt-5-5-pro" },
      [],
      () => {
        modelButton.textContent = "GPT-5.5 Pro";
        option.setAttribute("aria-checked", "true");
      },
    );
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "GPT-5.5 Pro" });
  });

  it("selects GPT-5.5 Pro from the current visible Pro Extended label", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Pro• Extended", {}, [], () => {
      modelButton.textContent = "Extended Pro";
      option.setAttribute("aria-checked", "true");
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "gpt-5.5-pro",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "Extended Pro" });
  });

  it("selects Thinking 5.5 from the current visible Thinking Heavy label", async () => {
    const modelButton = new FakeElement("Standard", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const option = new FakeElement("Thinking• Heavy", {}, [], () => {
      modelButton.textContent = "Thinking Heavy";
      option.setAttribute("aria-checked", "true");
    });
    const menu = new FakeElement("", { role: "menu" }, [option]);

    const result = await runModelSelectionExpression(
      "Thinking 5.5",
      new FakeDocument([modelButton], [menu]),
    );

    expect(result).toEqual({ status: "switched", label: "Thinking Heavy" });
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
});
