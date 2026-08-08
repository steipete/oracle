import { describe, expect, it } from "vitest";
import type { ThinkingTimeLevel } from "../../src/oracle/types.js";
import {
  buildThinkingTimeExpressionForTest,
  ensureThinkingTime,
  inferThinkingTargetModelKindForTest,
} from "../../src/browser/actions/thinkingTime.js";

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
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "extra-high", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("supports ChatGPT's model-menu thinking effort control", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("MODEL_BUTTON_SELECTOR");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("data-model-picker-thinking-effort-row");
    expect(expression).toContain("aria-controls");
    expect(expression).toContain("LEVEL_TOKENS");
    expect(expression).toContain("return selectAndVerify(trailing");
  });

  it("maps ChatGPT's new Intelligence labels onto existing thinking levels", () => {
    expect(buildThinkingTimeExpressionForTest("light")).toContain("light: ['light', 'instant'");
    expect(buildThinkingTimeExpressionForTest("standard")).toContain(
      "standard: ['standard', 'medium'",
    );
    expect(buildThinkingTimeExpressionForTest("extended")).toContain(
      "extended: ['extended', 'high'",
    );
    expect(buildThinkingTimeExpressionForTest("extra-high")).toContain(
      "'extra-high': ['extra high'",
    );
    expect(buildThinkingTimeExpressionForTest("heavy")).toContain("heavy: ['heavy'");
    expect(buildThinkingTimeExpressionForTest("heavy")).not.toContain(
      "heavy: ['heavy', 'extra high'",
    );
  });

  it("accepts standard selected-state markers when verifying effort", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("aria-selected");
    expect(expression).toContain("aria-current");
    expect(expression).toContain("data-selected");
  });

  it("targets the selected model row before opening the effort menu", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("const findEffortRow");
    expect(expression).toContain("const rowIsSelected");
    expect(expression).toContain("if (rowIsSelected(row)) return t;");
    expect(expression).toContain("modelKindFromTrailing");
    expect(expression).toContain("model-kind-not-found");
  });

  it("preserves Chinese thinking-effort labels while normalizing", () => {
    const expression = buildThinkingTimeExpressionForTest("extra-high");
    expect(expression).toContain("\\u4e00-\\u9fa5");
    expect(expression).toContain("'极高'");
  });

  it("infers target model kind with token matching", () => {
    expect(inferThinkingTargetModelKindForTest("gpt-5.5-pro")).toBe("pro");
    expect(inferThinkingTargetModelKindForTest("Thinking 5.5")).toBe("thinking");
    expect(inferThinkingTargetModelKindForTest("Instant")).toBe("instant");
    expect(inferThinkingTargetModelKindForTest("gpt-5.5")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("profile")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("prototype")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("project")).toBeNull();
  });

  it("waits for the model button when current Pro effort rows render first", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }

    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly parent: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }

      get parentElement(): FakeElement | null {
        return this.parent;
      }

      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      querySelector(selector: string): FakeElement | null {
        if (selector.includes("data-model-picker-thinking-effort-menu-item")) {
          return this.attributes["aria-checked"] ? this : null;
        }
        return null;
      }

      querySelectorAll(_selector: string): FakeElement[] {
        return [];
      }

      closest(_selector: string): FakeElement | null {
        return this.parent;
      }

      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }

      getBoundingClientRect(): { width: number; height: number } {
        return { width: 24, height: 24 };
      }

      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }

    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let proClicks = 0;
    let thinkingClicks = 0;
    let now = 0;
    let modelButtonClicks = 0;
    let firstModelButtonClickAt: number | null = null;
    const modelButton = new FakeElement(
      "Extended",
      {
        "data-testid": "model-switcher-dropdown-button",
        "aria-expanded": "false",
      },
      null,
      () => {
        modelButtonClicks += 1;
        firstModelButtonClickAt ??= now;
      },
    );
    const unrelatedComposerPill = new FakeElement("Canvas", {
      class: "__composer-pill",
    });
    const thinkingRow = new FakeElement("", {
      "data-model-picker-thinking-effort-row": "true",
      "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
      },
      thinkingRow,
      () => {
        thinkingClicks += 1;
      },
    );
    const proRow = new FakeElement("", {
      "data-model-picker-thinking-effort-row": "true",
      "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
      },
      proRow,
      () => {
        proClicks += 1;
      },
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) =>
        selector.includes("model-switcher-dropdown-button") && now >= 1_000 ? modelButton : null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [unrelatedComposerPill];
        return selector.includes("data-model-picker-thinking-effort-action")
          ? [thinkingTrailing, proTrailing]
          : [];
      },
      dispatchEvent: () => true,
    };
    const performanceStub = {
      now: () => {
        now += 500;
        return now;
      },
    };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const windowStub = {
      PointerEvent: FakeMouseEvent,
      MouseEvent: FakeMouseEvent,
      Event: FakeMouseEvent,
    };
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        windowStub,
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toMatchObject({ status: "menu-not-found" });
    expect(modelButtonClicks).toBeGreaterThan(0);
    expect(firstModelButtonClickAt).not.toBeNull();
    expect(firstModelButtonClickAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2_000);
    expect(proClicks).toBeGreaterThan(0);
    expect(thinkingClicks).toBe(0);
  });

  it("does not trust the model button label as Pro Extended effort proof", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).not.toContain("const modelButtonLabel = normalize");
    expect(expression).not.toContain("hasToken(modelButtonLabel, 'extended')");
  });

  it("fails closed for any unconfirmed Pro Extended effort status", async () => {
    const statuses = [
      "chip-not-found",
      "menu-not-found",
      "option-not-found",
      "selection-unverified",
      "model-kind-not-found",
      "unknown-status",
      undefined,
    ] as const;

    for (const status of statuses) {
      const runtime = {
        evaluate: async () => ({
          result: {
            value:
              status === undefined
                ? undefined
                : status === "model-kind-not-found"
                  ? { status, modelKind: "pro" }
                  : { status },
          },
        }),
      };

      await expect(
        ensureThinkingTime(runtime as never, "extended", (() => {}) as never, "gpt-5.5-pro"),
      ).rejects.toThrow(/refusing to submit without confirmed Pro Extended/);
    }
  });

  it("fails closed when the current model is inferred as Pro", async () => {
    const runtime = {
      evaluate: async () => ({
        result: { value: { status: "selection-unverified", modelKind: "pro" } },
      }),
    };

    await expect(
      ensureThinkingTime(runtime as never, "extended", (() => {}) as never, null),
    ).rejects.toThrow(/refusing to submit without confirmed Pro Extended/);
  });

  it("keeps thinking effort best-effort when no target model kind is provided", async () => {
    const runtime = {
      evaluate: async () => ({
        result: { value: { status: "model-kind-not-found", modelKind: null } },
      }),
    };
    const logs: string[] = [];

    await expect(
      ensureThinkingTime(
        runtime as never,
        "extended",
        ((message: string) => logs.push(message)) as never,
        null,
      ),
    ).resolves.toBeUndefined();

    expect(logs.at(-1)).toContain("keeping the effort already selected in ChatGPT");
  });

  it("drives ChatGPT's new Intelligence effort picker for Pro Extended", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("composer-intelligence-picker-content");
    expect(expression).toContain("matchesProExtended");
    expect(expression).toContain("INTELLIGENCE_WAIT_MS");
    expect(expression).toContain("menu?.querySelector?.(INTELLIGENCE_MENU_SELECTOR)");
    expect(expression).toContain("itemText === 'pro'");
    expect(expression).toContain("!document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR)");
  });

  it("accepts checked Pro in GPT-5.6's wrapped Intelligence menu", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
        private readonly nestedIntelligence: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("composer-intelligence-picker-content")) {
          return this.nestedIntelligence;
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proRadio = new FakeElement("Pro", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const effortItems = [
      new FakeElement("极速5.5", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("中", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("高", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("极高", { role: "menuitemradio", "aria-checked": "false" }),
      proRadio,
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const intelligenceGroup = new FakeElement(
      "智能 极速5.5 中 高 极高 Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      effortItems,
    );
    const outerMenu = new FakeElement(
      intelligenceGroup.textContent,
      { role: "menu" },
      effortItems,
      intelligenceGroup,
    );
    const modelButton = new FakeElement("Pro", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceGroup;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [outerMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Pro" });

    const solHeavyExpression = buildThinkingTimeExpressionForTest("heavy", "gpt-5.6-sol");
    const currentMenuItems = [
      new FakeElement("ModelGPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
      new FakeElement("EffortPro", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const currentIntelligenceGroup = new FakeElement(
      "ModelGPT-5.6 SolEffortPro",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      currentMenuItems,
    );
    const currentOuterMenu = new FakeElement(
      currentIntelligenceGroup.textContent,
      { role: "menu" },
      currentMenuItems,
      currentIntelligenceGroup,
    );
    const proOnlyDocumentStub = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) {
          return currentIntelligenceGroup;
        }
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [currentOuterMenu];
        }
        return [];
      },
    };
    const evaluateSolHeavy = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${solHeavyExpression};`,
    ) as typeof evaluate;

    await expect(
      evaluateSolHeavy(
        proOnlyDocumentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Pro" });

    const proAttributes: Record<string, string> = {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    };
    const selectablePro = new FakeElement("Pro", proAttributes, [], null, () => {
      proAttributes["aria-checked"] = "true";
      proAttributes["data-state"] = "checked";
    });
    const selectableItems = [
      selectablePro,
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const selectableGroup = new FakeElement(
      "Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      selectableItems,
    );
    const selectableMenu = new FakeElement(
      selectableGroup.textContent,
      { role: "menu" },
      selectableItems,
      selectableGroup,
    );
    const solModelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const selectableDocumentStub = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return selectableGroup;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return solModelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [solModelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [selectableMenu];
        }
        return [];
      },
    };

    await expect(
      evaluateSolHeavy(
        selectableDocumentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
      // No heavy label in the menu: keep whatever is selected instead of switching to Pro.
    ).resolves.toMatchObject({ status: "option-not-found" });

    const competingProAttributes: Record<string, string> = {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    };
    const competingPro = new FakeElement("Pro", competingProAttributes, [], null, () => {
      competingProAttributes["aria-checked"] = "true";
      competingProAttributes["data-state"] = "checked";
    });
    const competingItems = [
      new FakeElement("Extra High", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
      competingPro,
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const competingGroup = new FakeElement(
      "Extra High Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      competingItems,
    );
    const competingMenu = new FakeElement(
      competingGroup.textContent,
      { role: "menu" },
      competingItems,
      competingGroup,
    );
    const competingDocumentStub = {
      ...selectableDocumentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return competingGroup;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return solModelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [solModelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [competingMenu];
        }
        return [];
      },
    };

    await expect(
      evaluateSolHeavy(
        competingDocumentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
      // Extra High is not a heavy label either, so Pro must not be hijacked.
    ).resolves.toMatchObject({ status: "option-not-found" });

    const extraHighAttributes: Record<string, string> = {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    };
    const selectableExtraHigh = new FakeElement("Extra High", extraHighAttributes, [], null, () => {
      extraHighAttributes["aria-checked"] = "true";
      extraHighAttributes["data-state"] = "checked";
    });
    const extraHighItems = [
      selectableExtraHigh,
      new FakeElement("Pro", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const extraHighGroup = new FakeElement(
      "Extra High Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      extraHighItems,
    );
    const extraHighMenu = new FakeElement(
      extraHighGroup.textContent,
      { role: "menu" },
      extraHighItems,
      extraHighGroup,
    );
    const mediumPill = new FakeElement("High", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const extraHighDocumentStub = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return extraHighGroup;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return mediumPill;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [mediumPill];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [extraHighMenu];
        }
        return [];
      },
    };
    const evaluateSolExtraHigh = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${buildThinkingTimeExpressionForTest("extra-high", "gpt-5.6-sol")};`,
    ) as typeof evaluate;

    await expect(
      evaluateSolExtraHigh(
        extraHighDocumentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Extra High" });

    const alreadyExtraHighPill = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "false",
      "aria-haspopup": "menu",
    });
    const alreadyExtraHighItems = [
      new FakeElement("Extra High", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      }),
      new FakeElement("Pro", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const alreadyExtraHighGroup = new FakeElement(
      "Extra High Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      alreadyExtraHighItems,
    );
    const alreadyExtraHighMenu = new FakeElement(
      alreadyExtraHighGroup.textContent,
      { role: "menu" },
      alreadyExtraHighItems,
      alreadyExtraHighGroup,
    );
    const alreadyExtraHighDocumentStub = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) {
          return alreadyExtraHighGroup;
        }
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return alreadyExtraHighPill;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [alreadyExtraHighPill];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [alreadyExtraHighMenu];
        }
        return [];
      },
    };

    await expect(
      evaluateSolExtraHigh(
        alreadyExtraHighDocumentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Extra High" });
  });

  it("selects exact Chinese Intelligence tiers without prefix collisions", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly nestedIntelligence: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("composer-intelligence-picker-content")) {
          return this.nestedIntelligence;
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const cases: Array<{
      level: "light" | "standard" | "extended" | "extra-high" | "heavy";
      label: string;
      reverseAmbiguousPair?: boolean;
      omitExtraHigh?: boolean;
    }> = [
      { level: "light", label: "极速5.5" },
      { level: "standard", label: "中" },
      { level: "extended", label: "高", reverseAmbiguousPair: true },
      { level: "extra-high", label: "极高" },
      { level: "extra-high", label: "极高", reverseAmbiguousPair: true },
      { level: "extra-high", label: "高", omitExtraHigh: true },
    ];

    for (const testCase of cases) {
      let clickedLabel: string | null = null;
      let unrelatedPillClicks = 0;
      const proRadio = new FakeElement("Pro 深度模式", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      });
      const makeRadio = (label: string) => {
        const radio = new FakeElement(
          label,
          { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
          [],
          null,
          () => {
            clickedLabel = label;
            radio.setAttribute("aria-checked", "true");
            radio.setAttribute("data-state", "checked");
            proRadio.setAttribute("aria-checked", "false");
            proRadio.setAttribute("data-state", "unchecked");
          },
        );
        return radio;
      };
      const instant = makeRadio("极速5.5");
      const medium = makeRadio("中");
      const high = makeRadio("高");
      const extraHigh = makeRadio("极高");
      const ambiguousPair = testCase.omitExtraHigh
        ? [high]
        : testCase.reverseAmbiguousPair
          ? [extraHigh, high]
          : [high, extraHigh];
      const orderedEfforts = [instant, medium, ...ambiguousPair];
      const proEfforts = testCase.level === "heavy" ? [] : [proRadio];
      const effortItems = [
        ...orderedEfforts,
        ...proEfforts,
        new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
      ];
      const intelligenceGroup = new FakeElement(
        `智能 ${orderedEfforts.map((item) => item.textContent).join(" ")} ${proEfforts.map((item) => item.textContent).join(" ")} GPT-5.6 Sol`,
        { "data-testid": "composer-intelligence-picker-content", role: "group" },
        effortItems,
      );
      const outerMenu = new FakeElement(
        intelligenceGroup.textContent,
        { role: "menu" },
        effortItems,
        intelligenceGroup,
      );
      const modelButton = new FakeElement("Pro", {
        class: "__composer-pill",
        "aria-expanded": "true",
        "aria-haspopup": "menu",
      });
      const unrelatedPill = new FakeElement(
        "Canvas",
        { class: "__composer-pill" },
        [],
        null,
        () => {
          unrelatedPillClicks += 1;
        },
      );
      const documentStub = {
        body: new FakeElement(""),
        querySelector: (selector: string) => {
          if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
          if (selector.includes("composer-intelligence-picker-content")) return intelligenceGroup;
          if (
            selector.includes("model-switcher-dropdown-button") ||
            selector.includes("__composer-pill")
          ) {
            return modelButton;
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector.includes("__composer-pill")) return [unrelatedPill, modelButton];
          if (selector.includes('role="menu"') || selector.includes("data-radix")) {
            return [outerMenu];
          }
          return [];
        },
        dispatchEvent: () => true,
      };
      let now = 0;
      const performanceStub = { now: () => (now += 100) };
      const expression = buildThinkingTimeExpressionForTest(testCase.level, "GPT-5.6 Sol");
      const evaluate = new Function(
        "document",
        "performance",
        "setTimeout",
        "window",
        "EventTarget",
        "PointerEvent",
        "MouseEvent",
        "HTMLElement",
        `return ${expression};`,
      ) as (
        document: unknown,
        performance: unknown,
        setTimeout: unknown,
        window: unknown,
        EventTarget: unknown,
        PointerEvent: unknown,
        MouseEvent: unknown,
        HTMLElement: unknown,
      ) => Promise<unknown>;

      await expect(
        evaluate(
          documentStub,
          performanceStub,
          (callback: () => void) => callback(),
          { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
          FakeEventTarget,
          FakeMouseEvent,
          FakeMouseEvent,
          FakeElement,
        ),
      ).resolves.toEqual({ status: "switched", label: testCase.label });
      expect(clickedLabel).toBe(testCase.label);
      expect(unrelatedPillClicks).toBe(0);
    }
  });

  it("selects German Intelligence tiers and keeps Hoch distinct from Sehr hoch", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly nestedIntelligence: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        return selector.includes("composer-intelligence-picker-content")
          ? this.nestedIntelligence
          : null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const GERMAN_TIERS = ["Sofort", "Mittel", "Hoch", "Sehr hoch"];
    const cases: Array<{ level: ThinkingTimeLevel; label: string | null; tiers: string[] }> = [
      { level: "light", label: "Sofort", tiers: GERMAN_TIERS },
      { level: "standard", label: "Mittel", tiers: GERMAN_TIERS },
      { level: "extended", label: "Hoch", tiers: GERMAN_TIERS },
      { level: "extra-high", label: "Sehr hoch", tiers: GERMAN_TIERS },
      // Sehr hoch must never satisfy `extended`, even when it is the only high tier.
      { level: "extended", label: null, tiers: ["Sofort", "Mittel", "Sehr hoch"] },
      // ...nor may Hoch satisfy `extra-high` when Sehr hoch is absent.
      { level: "extra-high", label: null, tiers: ["Sofort", "Mittel", "Hoch"] },
      // Row descriptions must not decide the tier: "sehr" inside Hoch's description
      // may not disqualify it, and "Hochladen" may not stand in for Hoch.
      {
        level: "extended",
        label: "Hoch – für sehr komplexe Aufgaben",
        tiers: ["Sofort", "Mittel", "Hoch – für sehr komplexe Aufgaben", "Sehr hoch"],
      },
      { level: "extended", label: null, tiers: ["Sofort", "Mittel", "Hochladen"] },
      {
        level: "standard",
        label: "Mittel – ausgewogene Denkdauer",
        tiers: ["Sofort", "Mittel – ausgewogene Denkdauer", "Hoch", "Sehr hoch"],
      },
      { level: "standard", label: null, tiers: ["Sofort", "Ermitteln", "Hoch"] },
    ];

    for (const testCase of cases) {
      let clickedLabel: string | null = null;
      const makeRadio = (label: string) => {
        const radio = new FakeElement(
          label,
          { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
          [],
          null,
          () => {
            clickedLabel = label;
            radio.setAttribute("aria-checked", "true");
            radio.setAttribute("data-state", "checked");
          },
        );
        return radio;
      };
      const effortItems = [
        ...testCase.tiers.map(makeRadio),
        new FakeElement("Pro", {
          role: "menuitemradio",
          "aria-checked": "false",
          "data-state": "unchecked",
        }),
        new FakeElement("GPT-5.6", { role: "menuitem", "aria-haspopup": "menu" }),
      ];
      const intelligenceGroup = new FakeElement(
        `Intelligenz ${effortItems.map((item) => item.textContent).join(" ")}`,
        { "data-testid": "composer-intelligence-picker-content", role: "group" },
        effortItems,
      );
      const outerMenu = new FakeElement(
        intelligenceGroup.textContent,
        { role: "menu" },
        effortItems,
        intelligenceGroup,
      );
      const modelButton = new FakeElement("Hoch", {
        class: "__composer-pill",
        "aria-expanded": "true",
        "aria-haspopup": "menu",
      });
      const documentStub = {
        body: new FakeElement(""),
        querySelector: (selector: string) => {
          if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
          if (selector.includes("composer-intelligence-picker-content")) return intelligenceGroup;
          if (
            selector.includes("model-switcher-dropdown-button") ||
            selector.includes("__composer-pill")
          ) {
            return modelButton;
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector.includes("__composer-pill")) return [modelButton];
          if (selector.includes('role="menu"') || selector.includes("data-radix")) {
            return [outerMenu];
          }
          return [];
        },
        dispatchEvent: () => true,
      };
      let now = 0;
      const performanceStub = { now: () => (now += 100) };
      const evaluate = new Function(
        "document",
        "performance",
        "setTimeout",
        "window",
        "EventTarget",
        "PointerEvent",
        "MouseEvent",
        "HTMLElement",
        `return ${buildThinkingTimeExpressionForTest(testCase.level, "GPT-5.6")};`,
      ) as (...args: unknown[]) => Promise<unknown>;

      const result = (await evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      )) as { status: string; label?: string | null };
      if (testCase.label === null) {
        expect(result.status).toBe("option-not-found");
        expect(clickedLabel).toBeNull();
      } else {
        expect(result.status).toBe("switched");
        expect(result.label).toBe(testCase.label);
        expect(clickedLabel).toBe(testCase.label);
      }
    }
  });

  it("selects Extended from the current standalone Pro composer pill", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector === "button.__composer-pill" && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proPill = new FakeElement(
      "Pro",
      {
        class: "__composer-pill",
        "aria-controls": "pro-effort-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => proPill.setAttribute("aria-expanded", "true"),
    );
    const standard = new FakeElement("Standard", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const extended = new FakeElement(
      "Extended",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        standard.setAttribute("aria-checked", "false");
        standard.setAttribute("data-state", "unchecked");
        extended.setAttribute("aria-checked", "true");
        extended.setAttribute("data-state", "checked");
        proPill.setAttribute("aria-expanded", "false");
      },
    );
    const effortMenu = new FakeElement(
      "Pro thinking effort Standard Extended",
      { role: "menu", "data-state": "open" },
      [standard, extended],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("form button.__composer-pill")) return [proPill];
        if (selector.includes("composer-footer-actions")) return [proPill];
        if (selector.includes("__composer-pill-composite")) return [proPill];
        if (selector.includes('[role="menu"]')) {
          return proPill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "pro-effort-menu" && proPill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    let now = 0;
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        { now: () => (now += 100) },
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Extended" });
    expect(extended.getAttribute("aria-checked")).toBe("true");
  });

  it("selects Standard from the current standalone Pro composer pill", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector === "button.__composer-pill" && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proPill = new FakeElement(
      "Pro",
      {
        class: "__composer-pill",
        "aria-controls": "pro-effort-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => proPill.setAttribute("aria-expanded", "true"),
    );
    const standard = new FakeElement(
      "Standard",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        standard.setAttribute("aria-checked", "true");
        standard.setAttribute("data-state", "checked");
        extended.setAttribute("aria-checked", "false");
        extended.setAttribute("data-state", "unchecked");
        proPill.setAttribute("aria-expanded", "false");
      },
    );
    const extended = new FakeElement("Extended", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const effortMenu = new FakeElement(
      "Pro thinking effort Standard Extended",
      { role: "menu", "data-state": "open" },
      [standard, extended],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("form button.__composer-pill")) return [proPill];
        if (selector.includes("composer-footer-actions")) return [proPill];
        if (selector.includes("__composer-pill-composite")) return [proPill];
        if (selector.includes('[role="menu"]')) {
          return proPill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "pro-effort-menu" && proPill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    let now = 0;
    const expression = buildThinkingTimeExpressionForTest("standard", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        { now: () => (now += 100) },
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Standard" });
    expect(standard.getAttribute("aria-checked")).toBe("true");
  });

  it("waits for a delayed Intelligence pill when its model button and menu appear first", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector.includes("__composer-pill") && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let pillVisible = false;
    let modelButtonClicks = 0;
    const modelButton = new FakeElement(
      "Thinking",
      {
        "data-testid": "model-switcher-dropdown-button",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => {
        modelButtonClicks += 1;
      },
    );
    const intelligencePill = new FakeElement(
      "Medium",
      {
        class: "__composer-pill",
        "aria-controls": "intelligence-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => intelligencePill.setAttribute("aria-expanded", "true"),
    );
    const medium = new FakeElement("Medium", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const extraHigh = new FakeElement(
      "Extra High",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        medium.setAttribute("aria-checked", "false");
        medium.setAttribute("data-state", "unchecked");
        extraHigh.setAttribute("aria-checked", "true");
        extraHigh.setAttribute("data-state", "checked");
        intelligencePill.textContent = "Extra High";
        intelligencePill.setAttribute("aria-expanded", "false");
      },
    );
    const effortMenu = new FakeElement(
      "Intelligence Instant Medium High Extra High",
      { role: "menu", "data-state": "open" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        medium,
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        extraHigh,
      ],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("model-switcher-dropdown-button")) return modelButton;
        if (selector === '[data-testid="composer-intelligence-picker-content"]') return effortMenu;
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (
          selector.includes("form button.__composer-pill") ||
          selector.includes("composer-footer-actions") ||
          selector.includes("__composer-pill-composite")
        ) {
          return pillVisible ? [intelligencePill] : [];
        }
        if (selector.includes('[role="menu"]')) {
          return intelligencePill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "intelligence-menu" && intelligencePill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    for (const targetModel of [null, "gpt-5.5"] as const) {
      pillVisible = false;
      modelButtonClicks = 0;
      intelligencePill.textContent = "Medium";
      intelligencePill.setAttribute("aria-expanded", "false");
      medium.setAttribute("aria-checked", "true");
      medium.setAttribute("data-state", "checked");
      extraHigh.setAttribute("aria-checked", "false");
      extraHigh.setAttribute("data-state", "unchecked");
      let now = 0;
      let timers = 0;
      const expression = buildThinkingTimeExpressionForTest("extra-high", targetModel);
      const evaluate = new Function(
        "document",
        "performance",
        "setTimeout",
        "window",
        "EventTarget",
        "PointerEvent",
        "MouseEvent",
        "HTMLElement",
        `return ${expression};`,
      ) as (
        document: unknown,
        performance: unknown,
        setTimeout: unknown,
        window: unknown,
        EventTarget: unknown,
        PointerEvent: unknown,
        MouseEvent: unknown,
        HTMLElement: unknown,
      ) => Promise<unknown>;

      await expect(
        evaluate(
          documentStub,
          { now: () => (now += 100) },
          (callback: () => void) => {
            timers += 1;
            if (timers >= 40) pillVisible = true;
            callback();
          },
          { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
          FakeEventTarget,
          FakeMouseEvent,
          FakeMouseEvent,
          FakeElement,
        ),
      ).resolves.toEqual({ status: "switched", label: "Extra High" });
      expect(intelligencePill.textContent).toBe("Extra High");
      expect(modelButtonClicks).toBeGreaterThan(0);
    }
  });

  it("captures a model-picker diagnostic on failure outcomes", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("collectPickerDiagnostic");
    expect(expression).toContain("describeMenu");
    expect(expression).toContain("diagnostic: collectPickerDiagnostic()");
  });

  it("bounds and redacts model-picker diagnostic text", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
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
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(_selector: string): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 120, height: 30 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const secret = "abcdefghijklmnopqrstuvwxyz0123456789TOKEN";
    const item = new FakeElement(`Pro user@example.com ${secret}`, {
      role: "menuitemradio",
      "aria-label": `user@example.com ${secret}`,
    });
    const menu = new FakeElement(`Pro user@example.com ${secret}`, { role: "menu" }, [item]);
    const composerButton = new FakeElement(`user@example.com ${secret}`, {
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [];
        if (selector.includes("composer-footer-actions")) return [];
        if (selector.includes("data-model-picker-thinking-effort")) return [];
        if (selector.includes('data-testid*="model-switcher"')) return [];
        if (selector.includes("form button[aria-haspopup")) return [composerButton];
        if (selector.includes('[role="menu"]')) return [menu];
        return [];
      },
      dispatchEvent: () => true,
    };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    let now = 0;
    const result = await evaluate(
      documentStub,
      { now: () => (now += 500) },
      (callback: () => void) => callback(),
      { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
      FakeEventTarget,
      FakeMouseEvent,
      FakeMouseEvent,
      FakeElement,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[redacted-email]");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain(secret);
  });

  it("preserves current Pro Extended when no target model kind is supplied", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
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
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const highRadio = new FakeElement("High", {
      role: "menuitemradio",
      "aria-checked": "false",
    });
    const proExtendedRadio = new FakeElement("Pro Extended", {
      role: "menuitemradio",
      "aria-checked": "true",
    });
    const intelligenceMenu = new FakeElement(
      "InstantMediumHighExtra HighPro Extended",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [highRadio, proExtendedRadio],
    );
    const modelButton = new FakeElement("Pro Extended", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", null);
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Pro Extended" });

    const genericOnlyMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra High",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [highRadio],
    );
    const genericOnlyDocument = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return genericOnlyMenu;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [genericOnlyMenu];
        }
        return [];
      },
    };

    await expect(
      evaluate(
        genericOnlyDocument,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toMatchObject({ status: "option-not-found", modelKind: "pro" });
  });

  it("opens the Pro effort submenu before selecting Pro Standard", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let proSubmenuOpen = false;
    const mediumRadio = new FakeElement("Medium", {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    });
    const proTrigger = new FakeElement(
      "",
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-state": "closed",
        "data-testid": "composer-intelligence-pro-thinking-effort-trigger",
      },
      [],
      () => {
        proSubmenuOpen = true;
        proTrigger.setAttribute("aria-expanded", "true");
        proTrigger.setAttribute("data-state", "open");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        mediumRadio,
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "true" }),
        proTrigger,
        new FakeElement("GPT-5.5", { role: "menuitem", "aria-haspopup": "menu" }),
      ],
    );
    const proStandardRadio = new FakeElement(
      "Pro Standard",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        proStandardRadio.setAttribute("aria-checked", "true");
        proStandardRadio.setAttribute("data-state", "checked");
        mediumRadio.setAttribute("aria-checked", "false");
        mediumRadio.setAttribute("data-state", "unchecked");
      },
    );
    const proSubmenu = new FakeElement("Pro StandardPro Extended", { role: "menu" }, [
      proStandardRadio,
      new FakeElement("Pro Extended", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
    ]);
    const modelButton = new FakeElement("Pro Extended", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) {
          return proTrigger;
        }
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return proSubmenuOpen ? [intelligenceMenu, proSubmenu] : [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("standard", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Pro Standard" });
  });

  it("verifies Pro Extended when the submenu closes after selection", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let intelligenceMenuOpen = true;
    let proSubmenuOpen = false;
    const proTrigger = new FakeElement(
      "",
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-state": "closed",
        "data-testid": "composer-intelligence-pro-thinking-effort-trigger",
      },
      [],
      () => {
        proSubmenuOpen = true;
        proTrigger.setAttribute("aria-expanded", "true");
        proTrigger.setAttribute("data-state", "open");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighProGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Pro", { role: "menuitemradio", "aria-checked": "true" }),
        proTrigger,
        new FakeElement("GPT-5.5", { role: "menuitem", "aria-haspopup": "menu" }),
      ],
    );
    const modelButton = new FakeElement("Pro", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const proExtendedRadio = new FakeElement(
      "Pro Extended",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        modelButton.textContent = "Pro Extended";
        modelButton.setAttribute("aria-expanded", "false");
        intelligenceMenuOpen = false;
        proSubmenuOpen = false;
      },
    );
    const proSubmenu = new FakeElement("Pro StandardPro Extended", { role: "menu" }, [
      new FakeElement("Pro Standard", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      }),
      proExtendedRadio,
    ]);
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) {
          return intelligenceMenuOpen ? proTrigger : null;
        }
        if (selector.includes("composer-intelligence-picker-content")) {
          return intelligenceMenuOpen ? intelligenceMenu : null;
        }
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          if (!intelligenceMenuOpen) return [];
          return proSubmenuOpen ? [intelligenceMenu, proSubmenu] : [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Pro Extended" });
  });

  it("confirms Extra High from an effort-only pill without aria-haspopup", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const extraHighRadio = new FakeElement("Extra High", {
      role: "menuitemradio",
      "aria-checked": "true",
    });
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        extraHighRadio,
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extra-high", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Extra High" });
  });

  it("selects High for Thinking extended without matching Extra High", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const highRadio = new FakeElement(
      "High",
      { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
      [],
      () => {
        highRadio.setAttribute("aria-checked", "true");
        highRadio.setAttribute("data-state", "checked");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumExtra HighHighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        highRadio,
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "High" });
  });

  it("verifies non-Pro Intelligence selection from a replacement pill when the menu closes", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      public isConnected = true;

      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let intelligenceMenuOpen = true;
    let modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const instantRadio = new FakeElement(
      "Instant",
      { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
      [],
      () => {
        if (!intelligenceMenuOpen) return;
        modelButton.isConnected = false;
        modelButton = new FakeElement("Instant", {
          class: "__composer-pill",
          "aria-expanded": "false",
        });
        intelligenceMenuOpen = false;
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        instantRadio,
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "true" }),
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) {
          return intelligenceMenuOpen ? intelligenceMenu : null;
        }
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return intelligenceMenuOpen ? [intelligenceMenu] : [];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("light", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Instant" });
  });
});

describe("unified Intelligence picker with Advanced -> Effort submenu", () => {
  // Mirrors the ChatGPT layout observed 2026-08-07: a "power" slider in the simple
  // view, with the effort tiers reachable only through Advanced -> Effort.
  class FakeEventTarget {
    dispatchEvent(_event: unknown): boolean {
      return true;
    }
  }

  class Node extends FakeEventTarget {
    public readonly children: Node[];
    private readonly attrs: Record<string, string>;
    public clicks = 0;

    constructor(
      public textContent: string,
      attrs: Record<string, string> = {},
      children: Node[] = [],
      private readonly onClick?: (self: Node) => void,
    ) {
      super();
      this.attrs = { ...attrs };
      this.children = children;
    }

    get parentElement(): Node | null {
      return null;
    }

    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }

    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }

    private matchesSelector(selector: string): boolean {
      const role = this.attrs.role ?? "";
      const testid = this.attrs["data-testid"] ?? "";
      if (selector.includes('[role="menuitem"][aria-haspopup="menu"]')) {
        return role === "menuitem" && this.attrs["aria-haspopup"] === "menu";
      }
      if (selector.includes("composer-model-picker-slider-advanced-view")) {
        return testid === "composer-model-picker-slider-advanced-view";
      }
      if (selector.includes("composer-intelligence-picker-content")) {
        return testid === "composer-intelligence-picker-content";
      }
      if (selector.includes('role="menuitemradio"') && role === "menuitemradio") return true;
      if (selector.includes('role="menuitem"'))
        return role === "menuitem" || role === "menuitemradio";
      if (selector.includes('role="menu"')) return role === "menu";
      return false;
    }

    private descendants(): Node[] {
      return this.children.flatMap((child) => [child, ...child.descendants()]);
    }

    querySelector(selector: string): Node | null {
      return this.descendants().find((node) => node.matchesSelector(selector)) ?? null;
    }

    querySelectorAll(selector: string): Node[] {
      return this.descendants().filter((node) => node.matchesSelector(selector));
    }

    closest(_selector: string): Node | null {
      return null;
    }

    matches(selector: string): boolean {
      if (selector.includes("__composer-pill")) {
        return (this.attrs.class ?? "").includes("__composer-pill");
      }
      return this.matchesSelector(selector);
    }

    contains(node: unknown): boolean {
      return this.descendants().includes(node as Node);
    }

    getBoundingClientRect(): { width: number; height: number } {
      return { width: 40, height: 20 };
    }

    override dispatchEvent(event: unknown): boolean {
      if (String((event as { type?: string }).type) === "click") {
        this.clicks += 1;
        this.onClick?.(this);
      }
      return super.dispatchEvent(event);
    }
  }

  class FakeMouseEvent {
    constructor(
      public readonly type: string,
      public readonly init?: unknown,
    ) {}
  }

  function buildDom(currentTier: string) {
    const tierNames = ["Instant", "Medium", "High", "Extra High", "Pro"];
    let selectedTier = currentTier;
    const tierRows = tierNames.map(
      (name) =>
        new Node(
          name,
          { role: "menuitemradio", "aria-checked": name === selectedTier ? "true" : "false" },
          [],
          (self) => {
            selectedTier = name;
            for (const row of tierRows) {
              row.setAttribute("aria-checked", row === self ? "true" : "false");
            }
          },
        ),
    );
    const submenu = new Node(
      "InstantMediumHighExtra HighPro",
      { role: "menu", id: "effort-submenu" },
      tierRows,
    );

    // The submenu is portalled in only once its opener is activated, so a descent
    // that never really opens it cannot quietly pass by reading it up front.
    let submenuOpen = false;
    const effortOpener = new Node(
      `Effort${selectedTier}`,
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-controls": "effort-submenu",
        "data-state": "closed",
      },
      [],
      (self) => {
        submenuOpen = true;
        self.setAttribute("aria-expanded", "true");
      },
    );
    const modelOpener = new Node("ModelGPT-5.6 Sol", {
      role: "menuitem",
      "aria-haspopup": "menu",
      "data-state": "closed",
    });
    const advancedView = new Node(
      "ModelGPT-5.6 SolEffortHigh",
      { "data-testid": "composer-model-picker-slider-advanced-view" },
      [modelOpener, effortOpener],
    );
    const advancedToggle = new Node("Advanced", {
      role: "menuitem",
      "aria-label": "Show advanced options",
      "aria-expanded": "false",
    });
    const slider = new Node("", { role: "menuitem", "aria-label": "Power" });
    const pickerContent = new Node(
      "High, 3 of 5.AdvancedFasterSmarter",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      [slider, advancedToggle, advancedView],
    );
    const topMenu = new Node("High, 3 of 5.Advanced", { role: "menu" }, [pickerContent]);
    const pill = new Node(currentTier, {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });

    const documentStub = {
      body: new Node(""),
      getElementById: (id: string) => (id === "effort-submenu" && submenuOpen ? submenu : null),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return pickerContent;
        if (selector.includes("__composer-pill")) return pill;
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [pill];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return submenuOpen ? [topMenu, submenu] : [topMenu];
        }
        if (selector.includes('role="menuitem"'))
          return [advancedToggle, modelOpener, effortOpener];
        return [];
      },
      dispatchEvent: () => true,
    };
    return {
      documentStub,
      advancedToggle,
      effortOpener,
      modelOpener,
      tierRows,
      getSelectedTier: () => selectedTier,
    };
  }

  function run(documentStub: unknown, level: string, model: string | null = "gpt-5.6-sol") {
    let now = 0;
    const performanceStub = {
      now: () => {
        now += 50;
        return now;
      },
    };
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${buildThinkingTimeExpressionForTest(level as ThinkingTimeLevel, model)};`,
    ) as (...args: unknown[]) => Promise<{ status: string; label: string | null }>;
    return evaluate(
      documentStub,
      performanceStub,
      (callback: () => void) => callback(),
      { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
      FakeEventTarget,
      FakeMouseEvent,
      FakeMouseEvent,
      Node,
    );
  }

  it("selects Pro through the Effort submenu", async () => {
    const dom = buildDom("High");
    await expect(run(dom.documentStub, "pro")).resolves.toEqual({
      status: "switched",
      label: "Pro",
    });
    expect(dom.getSelectedTier()).toBe("Pro");
  });

  it("expands the collapsed Advanced view before reading the tiers", async () => {
    const dom = buildDom("High");
    await run(dom.documentStub, "pro");
    expect(dom.advancedToggle.clicks).toBeGreaterThan(0);
  });

  it("reports Pro as already selected without clicking again", async () => {
    const dom = buildDom("Pro");
    await expect(run(dom.documentStub, "pro")).resolves.toEqual({
      status: "already-selected",
      label: "Pro",
    });
    const proRow = dom.tierRows[4];
    expect(proRow?.clicks).toBe(0);
  });

  it("still reaches non-Pro tiers through the same submenu", async () => {
    const dom = buildDom("High");
    await expect(run(dom.documentStub, "extra-high")).resolves.toEqual({
      status: "switched",
      label: "Extra High",
    });
    expect(dom.getSelectedTier()).toBe("Extra High");
  });

  it("never lands on Pro when a lower tier was requested", async () => {
    const dom = buildDom("Pro");
    await run(dom.documentStub, "extended");
    expect(dom.getSelectedTier()).toBe("High");
  });

  it("descends past a Model opener whose label contains Pro", async () => {
    // The Model row names the active model and can read "ModelGPT-5.6 Pro". It has
    // the same shape as the Effort opener, so a Pro request must not click it.
    const dom = buildDom("High");
    dom.modelOpener.textContent = "ModelGPT-5.6 Pro";
    await expect(run(dom.documentStub, "pro")).resolves.toEqual({
      status: "switched",
      label: "Pro",
    });
    expect(dom.modelOpener.clicks).toBe(0);
    expect(dom.effortOpener.clicks).toBeGreaterThan(0);
    expect(dom.getSelectedTier()).toBe("Pro");
  });

  it("refuses to guess the Effort opener in an unrecognized language", async () => {
    const dom = buildDom("High");
    dom.effortOpener.textContent = "Nivå Hög";
    dom.modelOpener.textContent = "Modell GPT-5.6 Pro";
    const result = await run(dom.documentStub, "pro");
    expect(result.status).not.toBe("switched");
    expect(dom.modelOpener.clicks).toBe(0);
    expect(dom.getSelectedTier()).toBe("High");
  });

  it("does not mistake a localized Advanced toggle for an effort tier", async () => {
    // German "Erweitert" is both the Advanced disclosure label and one of the
    // `extended` tier tokens. Matching it as a tier would satisfy the flat scan,
    // skip the descent, and click the toggle instead of an effort row.
    const dom = buildDom("Instant");
    dom.advancedToggle.textContent = "Erweitert";
    await expect(run(dom.documentStub, "extended")).resolves.toEqual({
      status: "switched",
      label: "High",
    });
    expect(dom.getSelectedTier()).toBe("High");
    expect(dom.effortOpener.clicks).toBeGreaterThan(0);
  });

  it("never settles on Pro for a lower tier when no model is supplied", async () => {
    // With no desiredModel the model kind is inferred from the composer pill. A pill
    // showing the Pro *effort* must not read as a Pro *model*, or the Pro-row
    // exclusion lifts and an `extended` request can match a Pro row carrying an
    // extended token — Chinese "Pro 深度模式" contains 深度, an extended token.
    const dom = buildDom("Pro");
    dom.tierRows[4]!.textContent = "Pro 深度模式";
    const result = await run(dom.documentStub, "extended", null);
    // Declining to act is fine (the tab stays where it was, and the caller warns).
    // Reporting Pro as satisfying `extended` is not.
    expect(dom.tierRows[4]?.clicks).toBe(0);
    if (result.status === "switched" || result.status === "already-selected") {
      expect(result.label ?? "").not.toContain("Pro");
    }
  });

  it("keeps Pro out of effort-owner classification", () => {
    // LEVEL_TOKENS classifies controls and menus as effort owners; TARGET_LEVEL_TOKENS
    // adds Pro for target matching only. Merging them would make a model pill reading
    // "Pro" look like the effort pill, and a model menu listing Instant/Pro look like
    // a tier list.
    const expression = buildThinkingTimeExpressionForTest("pro", "gpt-5.6-sol");
    const classifier = expression.slice(
      expression.indexOf("const LEVEL_TOKENS"),
      expression.indexOf("const TARGET_LEVEL_TOKENS"),
    );
    expect(classifier).not.toContain("pro: ['pro']");
    expect(expression).toContain("const TARGET_LEVEL_TOKENS = { ...LEVEL_TOKENS, pro: ['pro'] }");
    expect(expression).toContain("Object.values(LEVEL_TOKENS).some((tokens) => matchesTokens");
  });

  it("fails closed for every unconfirmed explicit Pro status", async () => {
    // Pro is expensive and rate-limited: an unconfirmed selection must abort rather
    // than silently submit at whatever cheaper tier the tab happened to be on.
    const statuses = [
      "chip-not-found",
      "menu-not-found",
      "option-not-found",
      "selection-unverified",
      "model-kind-not-found",
      "unknown-status",
      undefined,
    ] as const;

    for (const status of statuses) {
      const runtime = {
        evaluate: async () => ({
          result: { value: status === undefined ? undefined : { status } },
        }),
      };
      await expect(
        ensureThinkingTime(runtime as never, "pro", (() => {}) as never, "gpt-5.6-sol"),
      ).rejects.toThrow(/refusing to submit without confirmed Pro/);
    }
  });

  it("does not claim the previous effort survived an unverified click", async () => {
    const lines: string[] = [];
    const runtime = {
      evaluate: async () => ({ result: { value: { status: "selection-unverified" } } }),
    };
    await ensureThinkingTime(
      runtime as never,
      "extended",
      ((line: string) => lines.push(line)) as never,
      "gpt-5.6-sol",
    );
    const logged = lines.join(" ");
    expect(logged).toContain("unconfirmed");
    expect(logged).not.toContain("keeping the effort already selected");
  });

  it("never touches a tier row while hunting for the opener", async () => {
    // Regression guard: an opener matcher that accepted a tier row would change the
    // effort on hover alone, before any click.
    const dom = buildDom("High");
    const decoy = dom.tierRows[4];
    dom.effortOpener.textContent = "Nivå Hög";
    await run(dom.documentStub, "pro");
    expect(decoy?.clicks).toBe(0);
    expect(dom.getSelectedTier()).toBe("High");
  });
});
