import { describe, expect, it, vi } from "vitest";
import {
  assertResolvedModelSelectionForTest,
  buildComposerSignalMatchersForTest,
  buildModelMatchersLiteralForTest,
  buildModelSelectionExpressionForTest,
  ensureModelSelection,
} from "../../src/browser/actions/modelSelection.js";

const expectContains = (arr: string[], value: string) => {
  expect(arr).toContain(value);
};

const evaluateImmediateModelSelectionExpression = (
  targetModel: string,
  buttonLabel: string,
  composerLabel = "",
  proPillLabel = "",
): unknown => {
  const expression = buildModelSelectionExpressionForTest(targetModel);
  const modelButton = { textContent: buttonLabel };
  const composerSignal = composerLabel ? { textContent: composerLabel } : null;
  const proPill = proPillLabel
    ? {
        textContent: proPillLabel,
        getAttribute: (name: string) => (name === "aria-label" ? proPillLabel : null),
        matches: (selector: string) => selector.includes("__composer-pill"),
      }
    : null;
  const documentStub = {
    querySelector: (selector: string) => {
      if (selector.includes("model-switcher-dropdown-button")) {
        return modelButton;
      }
      if (selector.includes("__composer-pill") || selector.includes("Pro, click to remove")) {
        return null;
      }
      if (selector.includes("composer")) {
        return composerSignal;
      }
      return null;
    },
    querySelectorAll: () => (proPill ? [proPill] : []),
    title: "",
    body: { innerText: "" },
  };
  const performanceStub = { now: () => 0 };
  const windowStub = { location: { href: "https://chatgpt.com/" } };
  const EventTargetStub = class {};
  const MouseEventStub = class {};
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "MouseEvent",
    `return ${expression};`,
  ) as (
    document: unknown,
    performance: unknown,
    setTimeout: unknown,
    window: unknown,
    EventTarget: unknown,
    MouseEvent: unknown,
  ) => unknown;

  return evaluate(
    documentStub,
    performanceStub,
    () => 0,
    windowStub,
    EventTargetStub,
    MouseEventStub,
  );
};

const evaluateMenuModelSelectionExpression = async (
  targetModel: string,
  option: { label: string; testId?: string } | Array<{ label: string; testId?: string }>,
  extraMenus: unknown[] = [],
): Promise<unknown> => {
  class FakeEventTarget {
    dispatchEvent(_event: unknown): boolean {
      return true;
    }
  }

  class FakeElement extends FakeEventTarget {
    constructor(
      public textContent: string,
      private readonly attributes: Readonly<Record<string, string>> = {},
      private readonly children: readonly FakeElement[] = [],
      private readonly onDispatch?: () => void,
    ) {
      super();
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FakeElement | null {
      if (selector.includes("model-switcher-")) {
        return (
          this.children.find((child) =>
            child.getAttribute("data-testid")?.startsWith("model-switcher-"),
          ) ?? null
        );
      }
      return null;
    }

    querySelectorAll(_selector: string): FakeElement[] {
      return [...this.children];
    }

    closest(_selector: string): FakeElement | null {
      return null;
    }

    override dispatchEvent(event: unknown): boolean {
      this.onDispatch?.();
      return super.dispatchEvent(event);
    }
  }

  class FakeMouseEvent {
    readonly type: string;
    readonly init?: unknown;

    constructor(type: string, init?: unknown) {
      this.type = type;
      this.init = init;
    }
  }

  const expression = buildModelSelectionExpressionForTest(targetModel);
  const modelButton = new FakeElement("ChatGPT", {
    "data-testid": "model-switcher-dropdown-button",
  });
  const options = Array.isArray(option) ? option : [option];
  const modelOptions = options.map(
    (item) =>
      new FakeElement(item.label, item.testId ? { "data-testid": item.testId } : {}, [], () => {
        modelButton.textContent = item.label;
      }),
  );
  const menu = new FakeElement(
    options.map((item) => item.label).join(" "),
    { role: "menu" },
    modelOptions,
  );
  const menus = [...extraMenus, menu];
  const documentStub = {
    querySelector: (selector: string) => {
      if (selector.includes("model-switcher-dropdown-button")) {
        return modelButton;
      }
      if (selector.includes('role="menu"') || selector.includes("data-radix")) {
        return menu;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector.includes('role="menu"') || selector.includes("data-radix")) {
        return menus;
      }
      return [];
    },
    title: "",
    body: { innerText: "" },
    dispatchEvent: () => true,
  };
  const performanceStub = { now: () => 0 };
  const windowStub = { location: { href: "https://chatgpt.com/" } };
  const immediateSetTimeout = (handler: TimerHandler): number => {
    if (typeof handler === "function") {
      handler();
    }
    return 0;
  };
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "MouseEvent",
    "HTMLElement",
    `return ${expression};`,
  ) as (
    document: unknown,
    performance: unknown,
    setTimeout: unknown,
    window: unknown,
    EventTarget: unknown,
    MouseEvent: unknown,
    HTMLElement: unknown,
  ) => unknown;

  return await Promise.resolve(
    evaluate(
      documentStub,
      performanceStub,
      immediateSetTimeout,
      windowStub,
      FakeEventTarget,
      FakeMouseEvent,
      FakeElement,
    ),
  );
};

const evaluateIntelligenceModelSelectionExpression = async (
  targetModel: string,
): Promise<unknown> => {
  class FakeEventTarget {
    dispatchEvent(_event: unknown): boolean {
      return true;
    }
  }

  class FakeMouseEvent {
    readonly type: string;
    readonly init?: unknown;

    constructor(type: string, init?: unknown) {
      this.type = type;
      this.init = init;
    }
  }

  let intelligenceMenuOpen = false;
  let gpt55SubmenuOpen = false;

  class FakeElement extends FakeEventTarget {
    constructor(
      public textContent: string,
      private readonly attributes: Readonly<Record<string, string>> = {},
      private readonly children: readonly FakeElement[] = [],
      private readonly onDispatch?: (event: unknown) => void,
    ) {
      super();
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FakeElement | null {
      if (selector.includes("model-switcher-")) {
        return (
          this.children.find((child) =>
            child.getAttribute("data-testid")?.startsWith("model-switcher-"),
          ) ?? null
        );
      }
      return null;
    }

    querySelectorAll(_selector: string): FakeElement[] {
      return [...this.children];
    }

    closest(selector: string): FakeElement | null {
      if (selector.includes("role")) return this;
      return null;
    }

    matches(selector: string): boolean {
      return selector.includes("__composer-pill") &&
        this.attributes.class?.includes("__composer-pill")
        ? true
        : selector.includes("aria-haspopup") && this.attributes["aria-haspopup"] === "menu";
    }

    getBoundingClientRect(): { width: number; height: number } {
      return { width: 120, height: 36 };
    }

    override dispatchEvent(event: unknown): boolean {
      this.onDispatch?.(event);
      return super.dispatchEvent(event);
    }
  }

  const fiveFive = new FakeElement("5.5", {
    role: "menuitemradio",
    "aria-checked": "true",
    "data-state": "checked",
  });
  const gpt55Submenu = new FakeElement("5.55.45.34.5o3", { role: "menu" }, [fiveFive]);
  const gpt55Trigger = new FakeElement(
    "GPT-5.5",
    {
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "data-state": "closed",
    },
    [],
    () => {
      gpt55SubmenuOpen = true;
    },
  );
  const intelligenceMenu = new FakeElement(
    "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
    { role: "menu", "data-testid": "composer-intelligence-picker-content" },
    [
      new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "true" }),
      new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      gpt55Trigger,
    ],
  );
  const modelButton = new FakeElement(
    "Extra High",
    { class: "__composer-pill", "aria-haspopup": "menu", "aria-expanded": "false" },
    [],
    () => {
      intelligenceMenuOpen = true;
    },
  );

  const expression = buildModelSelectionExpressionForTest(targetModel);
  const documentStub = {
    querySelector: (selector: string) => {
      if (selector.includes("__composer-pill")) {
        return modelButton;
      }
      if (selector.includes("model-switcher-dropdown-button")) {
        return null;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector.includes("button.__composer-pill")) {
        return [modelButton];
      }
      if (selector.includes('role="menu"') || selector.includes("data-radix")) {
        return [
          ...(intelligenceMenuOpen ? [intelligenceMenu] : []),
          ...(gpt55SubmenuOpen ? [gpt55Submenu] : []),
        ];
      }
      return [];
    },
    title: "",
    body: { innerText: "" },
    dispatchEvent: () => true,
  };
  let now = 0;
  const performanceStub = { now: () => (now += 250) };
  const windowStub = {
    location: { href: "https://chatgpt.com/" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  const immediateSetTimeout = (handler: TimerHandler): number => {
    if (typeof handler === "function") {
      handler();
    }
    return 0;
  };
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "MouseEvent",
    "HTMLElement",
    `return ${expression};`,
  ) as (
    document: unknown,
    performance: unknown,
    setTimeout: unknown,
    window: unknown,
    EventTarget: unknown,
    MouseEvent: unknown,
    HTMLElement: unknown,
  ) => unknown;

  return await Promise.resolve(
    evaluate(
      documentStub,
      performanceStub,
      immediateSetTimeout,
      windowStub,
      FakeEventTarget,
      FakeMouseEvent,
      FakeElement,
    ),
  );
};

const createNonPickerMenuForTest = (labels: string[]): unknown => {
  class FakeEventTarget {
    dispatchEvent(_event: unknown): boolean {
      return true;
    }
  }

  class FakeElement extends FakeEventTarget {
    constructor(
      public textContent: string,
      private readonly attributes: Readonly<Record<string, string>> = {},
      private readonly children: readonly FakeElement[] = [],
    ) {
      super();
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FakeElement | null {
      if (selector.includes("model-switcher-")) {
        return (
          this.children.find((child) =>
            child.getAttribute("data-testid")?.startsWith("model-switcher-"),
          ) ?? null
        );
      }
      return null;
    }

    querySelectorAll(_selector: string): FakeElement[] {
      return [...this.children];
    }

    closest(_selector: string): FakeElement | null {
      return null;
    }
  }

  return new FakeElement(
    labels.join(" "),
    { "data-radix-collection-root": "" },
    labels.map((label) => new FakeElement(label)),
  );
};

const evaluateComposerPillFallbackExpression = (
  targetModel: string,
  pillLabel: string,
  strategy: "select" | "current" = "select",
): unknown => {
  class FakeElement {
    constructor(public textContent: string) {}

    getAttribute(_name: string): string | null {
      return null;
    }

    matches(selector: string): boolean {
      return selector === "button.__composer-pill" || selector.includes("__composer-pill");
    }

    getBoundingClientRect(): { width: number; height: number } {
      return { width: 64, height: 32 };
    }
  }

  const pill = new FakeElement(pillLabel);
  const expression = buildModelSelectionExpressionForTest(targetModel, strategy);
  const documentStub = {
    querySelector: (selector: string) => {
      if (selector.includes("model-switcher-dropdown-button")) {
        return null;
      }
      return null;
    },
    querySelectorAll: (selector: string) => {
      if (selector.includes("button.__composer-pill")) {
        return [pill];
      }
      return [];
    },
    title: "",
    body: { innerText: "" },
  };
  const performanceStub = { now: () => 0 };
  const windowStub = {
    location: { href: "https://chatgpt.com/" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  const EventTargetStub = class {};
  const MouseEventStub = class {};
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "MouseEvent",
    "HTMLElement",
    `return ${expression};`,
  ) as (
    document: unknown,
    performance: unknown,
    setTimeout: unknown,
    window: unknown,
    EventTarget: unknown,
    MouseEvent: unknown,
    HTMLElement: unknown,
  ) => unknown;

  return evaluate(
    documentStub,
    performanceStub,
    () => 0,
    windowStub,
    EventTargetStub,
    MouseEventStub,
    FakeElement,
  );
};

const evaluateNoModelButtonExpression = (
  targetModel: string,
  strategy: "select" | "current" = "select",
  composerLabel = "",
): unknown => {
  const expression = buildModelSelectionExpressionForTest(targetModel, strategy);
  const documentStub = {
    querySelector: (selector: string) =>
      selector.includes("composer-footer-actions") && composerLabel
        ? { textContent: composerLabel }
        : null,
    querySelectorAll: () => [],
    title: "",
    body: { innerText: "Ready when you are." },
    dispatchEvent: () => true,
  };
  const performanceStub = { now: () => 0 };
  const windowStub = { location: { href: "https://chatgpt.com/" } };
  const EventTargetStub = class {};
  const MouseEventStub = class {};
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "MouseEvent",
    "HTMLElement",
    `return ${expression};`,
  ) as (
    document: unknown,
    performance: unknown,
    setTimeout: unknown,
    window: unknown,
    EventTarget: unknown,
    MouseEvent: unknown,
    HTMLElement: unknown,
  ) => unknown;

  return evaluate(
    documentStub,
    performanceStub,
    () => 0,
    windowStub,
    EventTargetStub,
    MouseEventStub,
    class {},
  );
};

describe("browser model selection matchers", () => {
  it("includes pro + 5.5 tokens for gpt-5.5-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-pro");
    expect(labelTokens).toContain("pro extended");
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.5-pro") || t.includes("gpt-5-5-pro"))).toBe(
      true,
    );
  });

  it("includes pro + 5.4 tokens for gpt-5.4-pro", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.4-pro");
    expect(labelTokens.some((t) => t.includes("pro"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.4") || t.includes("5-4"))).toBe(true);
    expect(testIdTokens.some((t) => t.includes("gpt-5.4-pro") || t.includes("gpt-5-4-pro"))).toBe(
      true,
    );
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

  it("includes instant tokens for gpt-5.5-instant", () => {
    const { labelTokens, testIdTokens } = buildModelMatchersLiteralForTest("gpt-5.5-instant");
    expect(labelTokens.some((t) => t.includes("instant"))).toBe(true);
    expect(labelTokens.some((t) => t.includes("5.5") || t.includes("5-5"))).toBe(true);
    expect(testIdTokens).toContain("model-switcher-gpt-5-5-instant");
    expect(testIdTokens).toContain("gpt-5.5-instant");
    // Bare 5.5 picker testid must NOT leak in — that would cause the Instant
    // request to match the default "Thinking 5.5" row.
    expect(testIdTokens).not.toContain("model-switcher-gpt-5-5");
    expect(testIdTokens).toContain("gpt-5-5");
    expect(testIdTokens).toContain("gpt55");
  });

  it("hard-rejects non-Instant candidates when targeting Instant", () => {
    const expression = buildModelSelectionExpressionForTest("GPT-5.5 Instant");
    expect(expression).toContain("const candidateHasInstant =");
    expect(expression).toContain("if (wantsInstant && !candidateHasInstant) return 0;");
  });

  it("selects the observed bare GPT-5.5 row when its label is Instant", async () => {
    await expect(
      evaluateMenuModelSelectionExpression("GPT-5.5 Instant", {
        label: "Instant",
        testId: "model-switcher-gpt-5-5",
      }),
    ).resolves.toEqual({ status: "switched", label: "Instant" });
  });

  it("closes the menu after a successful selection path", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.4");
    expect(expression).toContain("const closeMenu = () =>");
    expect(expression).toContain("key: 'Escape'");
    expect(expression).toContain("closeMenu();");
  });

  it("recognizes current GPT-5.5 visible aliases in the picker expression", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("isTargetGpt55VisibleAlias");
    // ChatGPT as of 2026-05 shows bare "Pro" (not "Pro Extended") in the picker.
    // Composer pill may also display "Extended Pro" (reversed ordering).
    expect(expression).toContain(
      "label === 'pro' || label === 'pro extended' || label === 'extended pro'",
    );
    expect(expression).toContain("desiredVersion === '5-5'");
  });

  it("recognizes bare Pro as already selected when Pro is the browser target", () => {
    const result = evaluateImmediateModelSelectionExpression("Pro", "Pro");
    expect(result).toEqual({ status: "already-selected", label: "Pro" });
  });

  it("does not accept stale versioned Pro labels for the current Pro target", () => {
    const result = evaluateImmediateModelSelectionExpression("Pro", "GPT-5.4 Pro");
    expect(result).toBeInstanceOf(Promise);
  });

  it("does not accept stale versioned Pro composer signals under a generic header", () => {
    const result = evaluateImmediateModelSelectionExpression("Pro", "ChatGPT", "GPT-5.4 Pro");
    expect(result).toBeInstanceOf(Promise);
  });

  it("selects the current bare Pro row even when its test id still looks legacy", async () => {
    await expect(
      evaluateMenuModelSelectionExpression("Pro", {
        label: "Pro",
        testId: "model-switcher-gpt-5-pro",
      }),
    ).resolves.toEqual({ status: "switched", label: "Pro" });
  });

  it("recognizes ChatGPT plus the Pro composer pill as the current Pro model", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const hasProComposerPill = () =>");
    expect(expression).toContain("const withProPillSignal = (label) =>");
    expect(expression).toContain("return resolved + ' + Pro'");
    expect(expression).toContain("if (normalized.includes('thinking')) return 'Pro'");
    expect(expression).toContain("normalizedLabel === 'extended'");
    expect(expression).toContain("hasToken(label, 'pro') && !hasToken(label, 'thinking')");
    expect(expression).not.toContain('button[aria-label*="Pro"]');
    expect(expression).toContain("hasProComposerPill()");
  });

  it("does not let a standalone thinking chip pollute Pro model verification", () => {
    const result = evaluateImmediateModelSelectionExpression(
      "gpt-5.5-pro",
      "ChatGPT",
      "Thinking Extended",
      "Pro, click to remove",
    );
    expect(result).toEqual({ status: "already-selected", label: "Pro" });
  });

  it("accepts a Pro pill plus effort label as the current Pro model", () => {
    const result = evaluateImmediateModelSelectionExpression(
      "gpt-5.5-pro",
      "Extended",
      "",
      "Pro, click to remove",
    );
    expect(result).toEqual({ status: "already-selected", label: "Extended + Pro" });
  });

  it("hard-rejects Thinking candidates when targeting Pro", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const candidateHasThinking =");
    expect(expression).toContain("if (wantsPro && candidateHasThinking) return 0;");
    expect(expression).toContain("if (wantsPro && !candidateHasPro) return 0;");
  });

  it("hard-rejects non-Thinking candidates when targeting Thinking", () => {
    const expression = buildModelSelectionExpressionForTest("Thinking 5.5");
    expect(expression).toContain("if (wantsThinking && !candidateHasThinking) return 0;");
    expect(expression).not.toContain("candidateGpt55VisibleAlias ||\n        labelHasProWord");
  });

  it("selects Thinking instead of the generic Instant row for GPT-5.5", async () => {
    await expect(
      evaluateMenuModelSelectionExpression("Thinking 5.5", [
        { label: "Instant", testId: "model-switcher-gpt-5-5" },
        { label: "Thinking Heavy", testId: "model-switcher-gpt-5-5-thinking" },
      ]),
    ).resolves.toEqual({ status: "switched", label: "Thinking Heavy" });
  });

  it("recognizes effort-only labels as selected Thinking when no Pro pill is present", () => {
    const result = evaluateImmediateModelSelectionExpression("Thinking 5.5", "Heavy", "Thinking");
    expect(result).toEqual({ status: "already-selected", label: "Thinking" });
  });

  it("requires a current GPT-5.5 model signal before accepting effort-only labels", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.2-thinking");
    expect(expression).toContain("desiredVersion === '5-5' &&");
    expect(expression).toContain("isTargetGpt55VisibleAlias(readComposerModelSignal())");
  });

  it("accepts exact version row ids for Thinking models without Thinking in the label", async () => {
    await expect(
      evaluateMenuModelSelectionExpression("Thinking 5.4", {
        label: "GPT-5.4",
        testId: "model-switcher-gpt-5-4",
      }),
    ).resolves.toEqual({ status: "switched", label: "GPT-5.4" });
  });

  it("finds the current model pill when ChatGPT omits aria-haspopup", () => {
    const result = evaluateComposerPillFallbackExpression("Thinking 5.5", "Thinking Heavy");
    expect(result).toEqual({ status: "already-selected", label: "Thinking Heavy" });
  });

  it("finds the new effort-only composer pill when ChatGPT omits aria-haspopup", () => {
    const result = evaluateComposerPillFallbackExpression("Thinking 5.5", "Extra High", "current");
    expect(result).toEqual({ status: "already-selected", label: "Extra High" });
  });

  it("allows the explicit current strategy when ChatGPT hides the model picker", () => {
    const result = evaluateNoModelButtonExpression("Pro", "current");
    expect(result).toEqual({ status: "already-selected", label: null });
  });

  it("records a visible composer model label without requiring the picker", () => {
    const result = evaluateNoModelButtonExpression("Pro", "current", "Thinking");
    expect(result).toEqual({ status: "already-selected", label: "Thinking" });
  });

  it("keeps strict selection failed when ChatGPT hides the model picker", () => {
    const result = evaluateNoModelButtonExpression("Pro", "select");
    expect(result).toEqual({ status: "button-missing" });
  });

  it("does not treat per-row thinking effort controls as model options", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const isThinkingEffortControl = (node) =>");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("if (isThinkingEffortControl(option))");
  });

  it("scopes model option scans to actual model picker menus", () => {
    const expression = buildModelSelectionExpressionForTest("Thinking 5.5");
    expect(expression).toContain("const queryPickerMenus = () =>");
    expect(expression).toContain("'[data-testid^=\"model-switcher-\"]'");
    expect(expression).toContain("const textFallbackMenus = menus.filter(");
    expect(expression).toContain("return pickerMenus.concat(textFallbackMenus);");
    expect(expression).toContain("const menus = queryPickerMenus();");
    expect(expression).toContain("const menuOpen = queryPickerMenus().length > 0;");
  });

  it("ignores sidebar Radix collections when selecting model rows", async () => {
    const sidebarMenu = createNonPickerMenuForTest([
      "Search chats",
      "Recents",
      "Projects",
      "New project",
    ]);

    await expect(
      evaluateMenuModelSelectionExpression(
        "Thinking 5.5",
        { label: "Thinking Heavy", testId: "model-switcher-gpt-5-5-thinking" },
        [sidebarMenu],
      ),
    ).resolves.toEqual({ status: "switched", label: "Thinking Heavy" });
  });

  it("falls back to text-only model picker rows when testids are absent", async () => {
    await expect(
      evaluateMenuModelSelectionExpression("Thinking 5.5", { label: "Thinking Heavy" }),
    ).resolves.toEqual({ status: "switched", label: "Thinking Heavy" });
  });

  it("keeps model-looking text fallback roots when a marked picker root is present", async () => {
    const markedPickerMenu = {
      textContent: "Instant",
      querySelector: (selector: string) =>
        selector.includes("model-switcher-") ? { textContent: "Instant" } : null,
      querySelectorAll: () => [],
    };

    await expect(
      evaluateMenuModelSelectionExpression("Thinking 5.5", { label: "Thinking Heavy" }, [
        markedPickerMenu,
      ]),
    ).resolves.toEqual({ status: "switched", label: "Thinking Heavy" });
  });

  it("does not accept a changed but wrong model selection as success", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("resolve('target')");
    expect(expression).toContain("resolve('changed')");
    expect(expression).toContain("if (selectionSettled === 'target')");
    expect(expression).toContain(
      "if (optionIsSelected(match.node) || activeSelectionMatchesTarget())",
    );
  });

  it("fails loudly if post-selection state resolves to Thinking instead of Pro", () => {
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Thinking 5.5 Heavy")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "GPT-5.5")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Extended")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Thinking Extended")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Thinking Pro")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "ChatGPT")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    // Both the new bare "Pro" label and the legacy "GPT-5.5 Pro" should pass.
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Pro")).not.toThrow();
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "GPT-5.5 Pro")).not.toThrow();
    expect(() => assertResolvedModelSelectionForTest("gpt-5.5-pro", "Extended Pro")).not.toThrow();
    expect(() => assertResolvedModelSelectionForTest("Pro", "Thinking 5.5 Heavy")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("Pro", "GPT-5.4 Pro")).toThrow(
      /requires GPT-5.5 Pro/,
    );
    expect(() => assertResolvedModelSelectionForTest("Pro", "Pro")).not.toThrow();
  });

  it("does not validate the active picker label when strategy keeps current selection", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "already-selected", label: "Thinking 5.5 Heavy" } },
      }),
    };
    const logger = vi.fn();

    await expect(
      ensureModelSelection(runtime as never, "gpt-5.5-pro", logger as never, "current"),
    ).resolves.toMatchObject({
      requestedModel: "gpt-5.5-pro",
      resolvedLabel: "Thinking 5.5 Heavy",
      status: "already-selected",
      strategy: "current",
      verified: false,
    });
    expect(logger).toHaveBeenCalledWith("Model picker: Thinking 5.5 Heavy");
  });

  it("does not substitute the requested model when the current label is unavailable", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "already-selected", label: null } },
      }),
    };
    const logger = vi.fn();

    await expect(
      ensureModelSelection(runtime as never, "gpt-5.5-pro", logger as never, "current"),
    ).resolves.toMatchObject({
      requestedModel: "gpt-5.5-pro",
      resolvedLabel: null,
      status: "already-selected",
      strategy: "current",
      verified: false,
    });
    expect(logger).toHaveBeenCalledWith("Model picker: current model (label unavailable)");
  });

  it("builds composer footer matchers for generic ChatGPT header states", () => {
    expect(buildComposerSignalMatchersForTest("GPT-5.5 Pro")).toEqual({
      includesAny: ["pro"],
      excludesAny: ["thinking"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("Thinking 5.5")).toEqual({
      includesAny: ["thinking"],
      excludesAny: ["pro"],
      allowBlank: false,
    });
    expect(buildComposerSignalMatchersForTest("GPT-5.2 Instant")).toEqual({
      includesAny: ["instant"],
      excludesAny: ["thinking", "pro"],
      allowBlank: false,
    });
  });

  it("waits for composer footer state when the header button stays generic", () => {
    const expression = buildModelSelectionExpressionForTest("GPT-5.5 Pro");
    expect(expression).toContain("const readComposerModelSignal = () =>");
    expect(expression).toContain("const activeSelectionMatchesTarget = () =>");
    expect(expression).toContain(
      "const waitForTargetSelection = (previousButtonLabel, previousComposerSignal) =>",
    );
  });

  it("accepts a post-click state change even when the footer text is localized", () => {
    const expression = buildModelSelectionExpressionForTest("Thinking 5.5");
    expect(expression).toContain(
      "const selectionStateChanged = (previousButtonLabel, previousComposerSignal) =>",
    );
    expect(expression).toContain("const previousComposerSignal = readComposerModelSignal();");
    expect(expression).toContain("const previousButtonLabel = normalizeText(getButtonLabel());");
    expect(expression).toContain("ariaChecked === 'true'");
    expect(expression).not.toContain(".trailing svg");
  });

  it("finds the rewritten ChatGPT composer pill model button", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain('data-testid="model-switcher-dropdown-button"');
    expect(expression).toContain("button.__composer-pill[aria-haspopup=");
    expect(expression).toContain("const findModelButton = () =>");
    expect(expression).toContain("button.__composer-pill')).find(looksLikeModelPill)");
  });

  it("recognizes GPT-5.5 from the new Intelligence submenu while the button shows effort", async () => {
    await expect(evaluateIntelligenceModelSelectionExpression("Thinking 5.5")).resolves.toEqual({
      status: "already-selected",
      label: "GPT-5.5",
    });
  });
});
