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
    expect(buildThinkingTimeExpressionForTest("heavy")).toContain("heavy: ['heavy', 'extra high'");
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
    const modelButton = new FakeElement("Extended", {
      "data-testid": "model-switcher-dropdown-button",
      "aria-expanded": "true",
    });
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
        selector.includes("model-switcher-dropdown-button") ? modelButton : null,
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

    expect(logs.at(-1)).toContain("continuing with ChatGPT default");
  });

  it("drives ChatGPT's new Intelligence effort picker for Pro Extended", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("composer-intelligence-picker-content");
    expect(expression).toContain("matchesProExtended");
    expect(expression).toContain("INTELLIGENCE_WAIT_MS");
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

    const result = await evaluate(
      documentStub,
      { now: () => 0 },
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
    const expression = buildThinkingTimeExpressionForTest("heavy", "Thinking 5.5");
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

  it("verifies non-Pro Intelligence selection from the composer pill when the menu closes", async () => {
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

    let intelligenceMenuOpen = true;
    const modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const instantRadio = new FakeElement(
      "Instant",
      { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
      [],
      () => {
        modelButton.textContent = "Instant";
        modelButton.setAttribute("aria-expanded", "false");
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
