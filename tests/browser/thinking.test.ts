import { createContext, Script } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildThinkingStatusExpressionForTest,
  formatThinkingLog,
  formatThinkingWaitingLog,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "../../src/browser/index.js";
import type { ChromeClient } from "../../src/browser/types.js";

type FakeRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const visibleRect = (overrides: Partial<FakeRect> = {}): FakeRect => ({
  top: 10,
  left: 10,
  right: 210,
  bottom: 90,
  width: 200,
  height: 80,
  ...overrides,
});

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly children: FakeElement[] = [];

  constructor(
    readonly tagName: string,
    public textContent = "",
    attrs: Record<string, string> = {},
    private readonly rect: FakeRect = visibleRect(),
    private readonly onClick?: () => void,
  ) {
    for (const [key, value] of Object.entries(attrs)) {
      this.setAttribute(key, value);
    }
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name.startsWith("data-")) {
      const dataKey = name
        .slice("data-".length)
        .replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
      this.dataset[dataKey] = value;
    }
  }

  getBoundingClientRect() {
    return this.rect;
  }

  click() {
    this.onClick?.();
  }

  contains(node: FakeElement): boolean {
    for (let current: FakeElement | null = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelectorList(this, selector)) return this;
    for (
      let current: FakeElement | null = this.parentElement;
      current;
      current = current.parentElement
    ) {
      if (matchesSelectorList(current, selector)) return current;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (matchesSelectorList(child, selector)) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

class FakeProgressElement extends FakeElement {
  constructor(
    value: number,
    max: number,
    attrs: Record<string, string> = {},
    rect: FakeRect = visibleRect(),
  ) {
    super("progress", "", attrs, rect);
    this.value = value;
    this.max = max;
  }

  value: number;
  max: number;
}

class FakeDocument {
  readonly body = new FakeElement("body");

  constructor(public title = "") {}

  append(...nodes: FakeElement[]) {
    this.body.append(...nodes);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
}

function matchesSelectorList(node: FakeElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSimpleSelector(node, part));
}

function matchesSimpleSelector(node: FakeElement, selector: string): boolean {
  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && node.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) {
    return false;
  }

  const classMatches = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
  for (const match of classMatches) {
    if (!node.className.split(/\s+/).includes(match[1] ?? "")) {
      return false;
    }
  }

  const attrMatches = [
    ...selector.matchAll(/\[([a-zA-Z0-9_-]+)([*^]?=)?(?:"([^"]*)"|'([^']*)'|([^\]]+))?\]/g),
  ];
  for (const match of attrMatches) {
    const attr = match[1] ?? "";
    const operator = match[2];
    const expected = match[3] ?? match[4] ?? match[5] ?? "";
    const actual = node.getAttribute(attr);
    if (!operator && actual == null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !String(actual ?? "").includes(expected)) return false;
    if (operator === "^=" && !String(actual ?? "").startsWith(expected)) return false;
  }

  return true;
}

async function runThinkingStatusExpression(document: FakeDocument) {
  const context = createContext({
    document,
    HTMLElement: FakeElement,
    HTMLProgressElement: FakeProgressElement,
    Number,
    String,
    Array,
    Set,
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    window: {
      innerHeight: 900,
      innerWidth: 1200,
      getComputedStyle: (node: FakeElement) => ({
        display: node.style.display ?? "block",
        visibility: node.style.visibility ?? "visible",
        opacity: node.style.opacity ?? "1",
        width: node.style.width ?? "",
        transform: node.style.transform ?? "",
      }),
    },
  });
  return await new Script(buildThinkingStatusExpressionForTest()).runInContext(context);
}

function assistantTurn(...children: FakeElement[]) {
  const turn = new FakeElement("article", "", {
    "data-testid": "conversation-turn-1",
    "data-message-author-role": "assistant",
  });
  turn.append(...children);
  return turn;
}

function sidecarWithProgress(progress: number, text = "Thinking sidecar") {
  const sidecar = new FakeElement(
    "aside",
    text,
    { role: "complementary", class: "oracle-thinking-sidecar" },
    visibleRect({ left: 720, right: 1120, width: 400, height: 300, bottom: 360 }),
  );
  sidecar.append(
    new FakeElement("div", "", {
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(progress),
    }),
  );
  return sidecar;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("formatThinkingLog", () => {
  test("renders thinking heartbeat without emoji", () => {
    const line = formatThinkingLog(0, 300_000, "planning", "");
    expect(line).toBe("[browser] ChatGPT thinking - 5m 0s elapsed; status=active; source=inline");
    expect(line).not.toMatch(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u);
  });

  test("renders sidecar progress and unchanged duration", () => {
    const line = formatThinkingLog(
      0,
      1_200_000,
      { message: "thinking sidecar active", source: "sidecar", progressPercent: 42.4 },
      "",
      61_000,
    );
    expect(line).toBe(
      "[browser] ChatGPT thinking - 42% UI progress, 20m 0s elapsed; status=thinking sidecar active; last change 1m 1s ago; source=sidecar",
    );
  });

  test("caps UI progress at 100%", () => {
    const line = formatThinkingLog(
      0,
      1_200_000,
      { message: "finishing", source: "sidecar", progressPercent: 124 },
      "",
    );
    expect(line).toContain("100% UI progress");
  });

  test("adds a stale hint when UI progress does not change for a long time", () => {
    const line = formatThinkingLog(
      0,
      900_000,
      { message: "active", source: "sidecar", progressPercent: 42 },
      "",
      10 * 60_000,
    );
    expect(line).toContain("stale-hint=no UI progress change");
  });

  test("renders waiting heartbeat when no status is visible", () => {
    const line = formatThinkingWaitingLog(0, 30_000);
    expect(line).toBe(
      "[browser] Waiting for ChatGPT response - 30s elapsed; no thinking status detected yet.",
    );
  });

  test("redacts long thinking text to avoid logging reasoning content", () => {
    expect(
      sanitizeThinkingText(
        "Pro thinking: I will first inspect the entire codebase, then reason through every possible selector failure mode before producing a patch.",
      ),
    ).toBe("active");
    expect(sanitizeThinkingText("Pro thinking - planning")).toBe("active");
    expect(sanitizeThinkingText("Thinking: check auth before tests")).toBe("active");
  });

  test("normalizes sidecar progress snapshots from the browser", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            message: "thinking sidecar active",
            source: "sidecar",
            progressPercent: 42.4,
            panelVisible: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readThinkingStatusForTest(runtime)).resolves.toEqual({
      message: "thinking sidecar active",
      source: "sidecar",
      progressPercent: 42.4,
      panelOpened: false,
      panelVisible: true,
    });
  });

  test("redacts short browser status snapshots before logging", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: "Thinking: check auth before tests" },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readThinkingStatusForTest(runtime)).resolves.toEqual({
      message: "active",
      source: "inline",
    });
  });

  test("skips heartbeat logging when runtime evaluation fails", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockRejectedValue(new Error("target closed")),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 1000,
      now: () => 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(logger).not.toHaveBeenCalled();

    stop();
  });

  test("does not log an in-flight heartbeat after stop", async () => {
    vi.useFakeTimers();
    const logger = vi.fn();
    let resolveEvaluate: (value: { result: { value: string } }) => void = () => {};
    const runtime = {
      evaluate: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveEvaluate = resolve;
          }),
      ),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 1000,
      now: () => 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    resolveEvaluate({ result: { value: "active" } });
    await vi.runOnlyPendingTimersAsync();

    expect(logger).not.toHaveBeenCalled();
  });

  test("uses the configured heartbeat interval", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const logger = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "planning" } }),
    } as unknown as ChromeClient["Runtime"];
    const stop = startThinkingStatusMonitorForTest(runtime, logger, {
      intervalMs: 5000,
      now: () => nowMs,
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(logger).not.toHaveBeenCalled();

    nowMs = 5000;
    await vi.advanceTimersByTimeAsync(1);
    expect(logger).toHaveBeenCalledTimes(1);

    stop();
  });
});

describe("thinking status browser expression", () => {
  test("opens only the latest assistant turn disclosure and reads sidecar progress", async () => {
    const document = new FakeDocument();
    let oldClicked = false;
    let latestClicked = false;
    const oldDisclosure = new FakeElement(
      "button",
      "Thinking",
      { "aria-expanded": "false" },
      visibleRect(),
      () => {
        oldClicked = true;
      },
    );
    const latestDisclosure = new FakeElement(
      "button",
      "Pro thinking",
      { "aria-expanded": "false" },
      visibleRect(),
      () => {
        latestClicked = true;
        document.append(sidecarWithProgress(42, "Private reasoning should not be logged"));
      },
    );
    document.append(assistantTurn(oldDisclosure), assistantTurn(latestDisclosure));

    const result = await runThinkingStatusExpression(document);

    expect(oldClicked).toBe(false);
    expect(latestClicked).toBe(true);
    expect(result).toMatchObject({
      message: "thinking sidecar opened",
      source: "sidecar",
      progressPercent: 42,
      panelOpened: true,
      panelVisible: true,
    });
    expect(JSON.stringify(result)).not.toContain("Private reasoning");
  });

  test("uses an existing sidecar without clicking the thinking disclosure", async () => {
    const document = new FakeDocument();
    let clicked = false;
    document.append(
      assistantTurn(
        new FakeElement("button", "Thinking", { "aria-expanded": "false" }, visibleRect(), () => {
          clicked = true;
        }),
      ),
      sidecarWithProgress(64),
    );

    const result = await runThinkingStatusExpression(document);

    expect(clicked).toBe(false);
    expect(result).toMatchObject({
      message: "thinking sidecar active",
      source: "sidecar",
      progressPercent: 64,
      panelOpened: false,
      panelVisible: true,
    });
  });

  test("ignores composer-adjacent thinking controls", async () => {
    const document = new FakeDocument();
    let clicked = false;
    const composer = new FakeElement("div", "", { "data-testid": "composer-footer-actions" });
    composer.append(
      new FakeElement("button", "Thinking", { "aria-expanded": "false" }, visibleRect(), () => {
        clicked = true;
      }),
    );
    document.append(assistantTurn(composer));

    const result = await runThinkingStatusExpression(document);

    expect(clicked).toBe(false);
    expect(result).toBeNull();
  });
});
