import { performance } from "node:perf_hooks";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildThinkingTimeExpressionForTest } from "../../src/browser/actions/thinkingTime.js";

class FakeElement extends EventTarget {
  parentElement: FakeElement | null = null;

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
    for (const child of children) {
      child.parentElement = this;
    }
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  getBoundingClientRect() {
    return { height: 32, width: 160 };
  }

  contains(node: FakeElement) {
    for (let current: FakeElement | null = node; current; current = current.parentElement) {
      if (current === this) {
        return true;
      }
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    const className = this.getAttribute("class") ?? "";
    if (
      selector.includes("model-picker-thinking-effort-row") &&
      className.includes("model-picker-thinking-effort-row")
    ) {
      return this;
    }
    if (
      selector.includes("data-radix-collection-item") &&
      this.getAttribute("data-radix-collection-item")
    ) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        const testId = child.getAttribute("data-testid") ?? "";
        const ariaChecked = child.getAttribute("aria-checked");
        const role = child.getAttribute("role");
        if (
          selector === "*" ||
          (selector.includes('[aria-checked="true"]') && ariaChecked === "true") ||
          (selector.includes("data-model-picker-thinking-effort-action") &&
            child.getAttribute("data-model-picker-thinking-effort-action") === "true") ||
          (selector.includes("model-switcher-") && testId.includes("model-switcher-")) ||
          (selector.includes("menuitem") && role?.includes("menuitem"))
        ) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  dispatchEvent(event: Event) {
    if (event.type === "click") {
      this.onClick?.();
    }
    return super.dispatchEvent(event);
  }
}

class FakeDocument extends EventTarget {
  private readonly byId = new Map<string, FakeElement>();

  constructor(
    private readonly modelButton: FakeElement,
    private readonly trailingButtons: FakeElement[],
    menusById: Record<string, FakeElement>,
  ) {
    super();
    for (const [id, element] of Object.entries(menusById)) {
      this.byId.set(id, element);
    }
  }

  getElementById(id: string) {
    return this.byId.get(id) ?? null;
  }

  querySelectorAll(selector: string) {
    if (selector.includes('button.__composer-pill[aria-haspopup="menu"]')) {
      return [this.modelButton];
    }
    if (selector.includes("data-model-picker-thinking-effort-action")) {
      return this.trailingButtons;
    }
    return [];
  }

  dispatchEvent(event: Event) {
    return super.dispatchEvent(event);
  }
}

const runThinkingTimeExpression = async (
  document: FakeDocument,
  level: "heavy" | "extended",
  options: { fastTimeout?: boolean } = {},
) => {
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
            now += 9_000;
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
    window: {},
  });
  return await new Script(buildThinkingTimeExpressionForTest(level)).runInContext(context);
};

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
    expect(expression).toContain("MODEL_BUTTON_SELECTOR");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("aria-controls");
    expect(expression).toContain('button.__composer-pill[aria-haspopup="menu"]');
    expect(expression).toContain("EFFORT_LABELS.has(text)");
    expect(expression).toContain("aria === 'pro' || text === 'pro'");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("score += 1000");
    expect(expression).toContain("const isEffortOnly = label === 'pro' || label === 'thinking'");
    expect(expression).toContain("className.includes('__composer-pill')");
    expect(expression).toContain("findEffortRow");
    expect(expression).toContain("modelKindFromTestId");
    expect(expression).toContain("best.score >= 100");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("opens the effort menu for the currently selected model row", async () => {
    let thinkingClicked = false;
    let proClicked = false;
    let extendedClicked = false;
    const modelButton = new FakeElement("Standard Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "true",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const extendedOption = new FakeElement("Extended", { role: "menuitemradio" }, [], () => {
      extendedClicked = true;
    });
    const document = new FakeDocument(modelButton, [thinkingTrailing, proTrailing], {
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, [extendedOption]),
    });

    const result = await runThinkingTimeExpression(document, "extended");

    expect(result).toEqual({ status: "switched", label: "Extended" });
    expect(thinkingClicked).toBe(false);
    expect(proClicked).toBe(true);
    expect(extendedClicked).toBe(true);
  });

  it("does not click an arbitrary trailing effort control when the current row is ambiguous", async () => {
    let thinkingClicked = false;
    let proClicked = false;
    const modelButton = new FakeElement("Heavy", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "false",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const document = new FakeDocument(modelButton, [thinkingTrailing, proTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "heavy", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
    expect(proClicked).toBe(false);
  });

  it("does not trust a single trailing effort control from another model row", async () => {
    let thinkingClicked = false;
    const modelButton = new FakeElement("Standard Pro", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    new FakeElement(
      "Thinking Heavy",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Heavy", {
          "aria-checked": "false",
          "data-testid": "model-switcher-gpt-5-5-thinking",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    const document = new FakeDocument(modelButton, [thinkingTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "heavy", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
  });

  it("does not treat the thinking-effort suffix as Thinking model evidence", async () => {
    let proClicked = false;
    const modelButton = new FakeElement("Thinking", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "aria-controls": "pro-effort",
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
        role: "menuitem",
      },
      [],
      () => {
        proClicked = true;
      },
    );
    new FakeElement("Pro Extended", { class: "group/model-picker-thinking-effort-row relative" }, [
      new FakeElement("Pro Extended", {
        "aria-checked": "false",
        "data-testid": "model-switcher-gpt-5-5-pro",
        role: "menuitemradio",
      }),
      proTrailing,
    ]);
    const document = new FakeDocument(modelButton, [proTrailing], {
      "pro-effort": new FakeElement("Standard Extended", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "extended", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(proClicked).toBe(false);
  });

  it("does not use effort-label overlap as current-row proof", async () => {
    let thinkingClicked = false;
    const modelButton = new FakeElement("Pro Extended", {
      "aria-haspopup": "menu",
      class: "__composer-pill __composer-pill--neutral",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "aria-controls": "thinking-effort",
        "data-model-picker-thinking-effort-action": "true",
        role: "menuitem",
      },
      [],
      () => {
        thinkingClicked = true;
      },
    );
    new FakeElement(
      "Thinking Extended",
      { class: "group/model-picker-thinking-effort-row relative" },
      [
        new FakeElement("Thinking Extended", {
          "aria-checked": "false",
          role: "menuitemradio",
        }),
        thinkingTrailing,
      ],
    );
    const document = new FakeDocument(modelButton, [thinkingTrailing], {
      "thinking-effort": new FakeElement("Standard Extended Heavy", { role: "menu" }, []),
    });

    const result = await runThinkingTimeExpression(document, "extended", { fastTimeout: true });

    expect(result).toEqual({ status: "option-not-found" });
    expect(thinkingClicked).toBe(false);
  });
});
