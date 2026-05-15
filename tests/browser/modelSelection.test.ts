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
): unknown => {
  const expression = buildModelSelectionExpressionForTest(targetModel);
  const modelButton = { textContent: buttonLabel };
  const composerSignal = composerLabel ? { textContent: composerLabel } : null;
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
    querySelectorAll: () => [],
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
  option: { label: string; testId: string },
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

    querySelector(_selector: string): FakeElement | null {
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
  const modelOption = new FakeElement(option.label, { "data-testid": option.testId }, [], () => {
    modelButton.textContent = option.label;
  });
  const menu = new FakeElement("", { role: "menu" }, [modelOption]);
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
        return [menu];
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
    expect(expression).toContain("hasToken(label, 'pro') && !hasToken(label, 'thinking')");
    expect(expression).not.toContain('button[aria-label*="Pro"]');
    expect(expression).toContain("normalizedLabel === 'chatgpt' && hasProComposerPill()");
  });

  it("hard-rejects Thinking candidates when targeting Pro", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const candidateHasThinking =");
    expect(expression).toContain("if (wantsPro && candidateHasThinking) return 0;");
    expect(expression).toContain("if (wantsPro && !candidateHasPro) return 0;");
  });

  it("does not treat per-row thinking effort controls as model options", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("const isThinkingEffortControl = (node) =>");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("if (isThinkingEffortControl(option))");
  });

  it("does not accept a changed but wrong model selection as success", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain("resolve('target')");
    expect(expression).toContain("resolve('changed')");
    expect(expression).toContain("if (selectionSettled === 'target')");
    expect(expression).not.toContain(
      "optionIsSelected(match.node) || activeSelectionMatchesTarget()",
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
      includesAny: [],
      excludesAny: ["thinking", "pro"],
      allowBlank: true,
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
    expect(expression).toContain(".trailing svg");
  });

  it("finds the rewritten ChatGPT composer pill model button", () => {
    const expression = buildModelSelectionExpressionForTest("gpt-5.5-pro");
    expect(expression).toContain('data-testid="model-switcher-dropdown-button"');
    expect(expression).toContain("button.__composer-pill[aria-haspopup=");
  });
});
