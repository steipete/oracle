import { describe, expect, it } from "vitest";
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
    const levels = ["light", "standard", "extended", "heavy"] as const;
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
    const expression = buildThinkingTimeExpressionForTest("heavy");
    expect(expression).toContain("\\u4e00-\\u9fa5");
    expect(expression).toContain("'重度'");
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

  it("uses current ChatGPT data-testid shape to target the Pro effort row", async () => {
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

      matches(_selector: string): boolean {
        return false;
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
    const modelButton = new FakeElement("Extended", {
      "data-testid": "model-switcher-dropdown-button",
      "aria-expanded": "true",
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
        selector.includes("model-switcher-dropdown-button") ? modelButton : null,
      querySelectorAll: (selector: string) =>
        selector.includes("data-model-picker-thinking-effort-action")
          ? [thinkingTrailing, proTrailing]
          : [],
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

    expect(logs.at(-1)).toContain("continuing with ChatGPT default");
  });

  it("drives ChatGPT's new Intelligence effort picker for Pro Extended", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("composer-intelligence-picker-content");
    expect(expression).toContain("matchesProExtended");
    expect(expression).toContain("INTELLIGENCE_WAIT_MS");
  });

  it("captures a model-picker diagnostic on failure outcomes", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("collectPickerDiagnostic");
    expect(expression).toContain("describeMenu");
    expect(expression).toContain("diagnostic: collectPickerDiagnostic()");
  });

  it("confirms Pro Extended from the Intelligence menu's checked radio", async () => {
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
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proExtendedRadio = new FakeElement("Pro Extended", {
      role: "menuitemradio",
      "aria-checked": "true",
    });
    const intelligenceMenu = new FakeElement(
      "InstantMediumHighExtra HighPro Extended",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [proExtendedRadio],
    );
    const modelButton = new FakeElement("Pro Extended", {
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button") || selector.includes("__composer-pill")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (_selector: string) => [],
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
    ).resolves.toEqual({ status: "already-selected", label: "Pro Extended" });
  });

  it("downgrades the strict Pro Extended throw when ORACLE_BROWSER_PRO_EFFORT_RELAXED is set", async () => {
    const runtime = {
      evaluate: async () => ({ result: { value: { status: "chip-not-found" } } }),
    };
    const logs: string[] = [];
    const previous = process.env.ORACLE_BROWSER_PRO_EFFORT_RELAXED;
    process.env.ORACLE_BROWSER_PRO_EFFORT_RELAXED = "1";
    try {
      await expect(
        ensureThinkingTime(
          runtime as never,
          "extended",
          ((message: string) => logs.push(message)) as never,
          "gpt-5.5-pro",
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.ORACLE_BROWSER_PRO_EFFORT_RELAXED;
      } else {
        process.env.ORACLE_BROWSER_PRO_EFFORT_RELAXED = previous;
      }
    }
    expect(logs.some((line) => line.includes("ORACLE_BROWSER_PRO_EFFORT_RELAXED"))).toBe(true);
  });
});
