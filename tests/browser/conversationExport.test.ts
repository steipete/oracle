import { describe, expect, it, vi } from "vitest";
import {
  buildConversationExportExpression,
  evaluateCompleteness,
  exportChatGptConversationViaDom,
  mergeConversationRecords,
  normalizeConversationRef,
  sortConversationRecords,
  type ConversationExport,
} from "../../src/browser/conversationExport.js";
import {
  parseConversationPort,
  renderConversationExport,
} from "../../src/cli/conversationCommand.js";

// Small fixed-size DOM fixture used only to assert role/order parsing behavior
// below (buildConversationExportExpression, DOM shell-guarding). It is not a
// completeness claim: real ChatGPT conversations routinely exceed 70 turns,
// and virtualized-crawl completeness (turnIndex gaps, bottom-reached, merge
// order) is covered separately by the turnIndex/crawl tests further down.
const sevenRecords = [
  "user",
  "assistant",
  "assistant",
  "user",
  "assistant",
  "user",
  "assistant",
] as const;

function fakeTurn(role: "user" | "assistant", text: string) {
  return {
    id: "",
    textContent: text,
    getAttribute: (name: string) =>
      name === "data-message-author-role"
        ? role
        : name === "data-message-id"
          ? `${role}-${text}`
          : null,
    querySelector: () => null,
    querySelectorAll: () => [],
    cloneNode() {
      return { textContent: text, querySelectorAll: () => [] };
    },
    closest: () => null,
    matches: () => true,
  };
}

function evaluateExpression(
  pathname: string,
  turns: ReturnType<typeof fakeTurn>[],
  shellTurns: ReturnType<typeof fakeTurn>[] = [],
) {
  const expression = buildConversationExportExpression("actual-thread");
  const execute = new Function("document", "location", `return ${expression};`);
  const transcript = { querySelectorAll: () => turns };
  return execute(
    {
      querySelector: () => transcript,
      querySelectorAll: () => shellTurns,
      body: transcript,
    },
    { pathname, href: `https://chatgpt.com${pathname}` },
  ) as { scopeMismatch: boolean; records: Array<{ role: string; text: string }> };
}

/**
 * Minimal but selector-accurate fake DOM element for tests that need real
 * removal/scoping behavior (sr-only stripping, `.markdown`-scoped text).
 * Supports exactly the selector forms buildConversationExportExpression
 * uses: tag names, `.class`, `[attr]`, `[attr="v"]`, `[attr^="v"]`,
 * `[attr*="v" i]`, comma-separated lists, and `.remove()`/`.cloneNode()`.
 */
class FakeNode {
  tagName: string;
  className: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  leafText: string;
  parent: FakeNode | null = null;

  constructor(
    tagName: string,
    opts: {
      className?: string;
      attrs?: Record<string, string>;
      text?: string;
      children?: FakeNode[];
    } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    this.className = opts.className ?? "";
    this.attrs = opts.attrs ?? {};
    this.leafText = opts.text ?? "";
    this.children = opts.children ?? [];
    for (const child of this.children) child.parent = this;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.leafText;
    return this.children.map((child) => child.textContent).join("");
  }

  get innerText(): string {
    return this.textContent;
  }

  get id(): string {
    return this.attrs.id ?? "";
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    return this.attrs[name] ?? null;
  }

  private matchesSimple(selector: string): boolean {
    const tagMatch = selector.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
    let rest = selector;
    if (tagMatch) {
      if (this.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = selector.slice(tagMatch[0].length);
    }
    const partRe = /\.([\w-]+)|\[([\w-]+)(?:([~^*$|]?=)"([^"]*)")?\s*(i)?\]/g;
    let match: RegExpExecArray | null;
    while ((match = partRe.exec(rest))) {
      if (match[1]) {
        if (!this.className.split(/\s+/).includes(match[1])) return false;
        continue;
      }
      const attrName = match[2] as string;
      const op = match[3];
      const value = match[4];
      const ci = Boolean(match[5]);
      const actual = this.getAttribute(attrName);
      if (actual === null) return false;
      if (op === undefined) continue;
      const a = ci ? actual.toLowerCase() : actual;
      const v = ci ? (value ?? "").toLowerCase() : (value ?? "");
      if (op === "=" && a !== v) return false;
      if (op === "^=" && !a.startsWith(v)) return false;
      if (op === "*=" && !a.includes(v)) return false;
    }
    return true;
  }

  matches(selectorList: string): boolean {
    return selectorList
      .split(",")
      .map((s) => s.trim())
      .some((s) => this.matchesSimple(s));
  }

  private *walk(): Generator<FakeNode> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  querySelectorAll(selectorList: string): FakeNode[] {
    const results: FakeNode[] = [];
    for (const node of this.walk()) {
      if (node === this) continue;
      if (node.matches(selectorList)) results.push(node);
    }
    return results;
  }

  querySelector(selectorList: string): FakeNode | null {
    return this.querySelectorAll(selectorList)[0] ?? null;
  }

  closest(selectorList: string): FakeNode | null {
    if (this.matches(selectorList)) return this;
    return this.parent ? this.parent.closest(selectorList) : null;
  }

  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
  }

  cloneNode(deep: boolean): FakeNode {
    return new FakeNode(this.tagName, {
      className: this.className,
      attrs: { ...this.attrs },
      text: this.leafText,
      children: deep ? this.children.map((child) => child.cloneNode(true)) : [],
    });
  }
}

function evaluateExpressionWithNodes(pathname: string, turns: FakeNode[]) {
  const expression = buildConversationExportExpression("actual-thread");
  const execute = new Function("document", "location", `return ${expression};`);
  const transcript = { querySelectorAll: () => turns };
  return execute(
    {
      querySelector: () => transcript,
      querySelectorAll: () => [],
      body: transcript,
    },
    { pathname, href: `https://chatgpt.com${pathname}` },
  ) as {
    scopeMismatch: boolean;
    records: Array<{ role: string; text: string; markdown?: string; turnIndex?: number }>;
  };
}

describe("conversation export", () => {
  it("keeps every DOM-ordered role record without pairing branches", () => {
    const value: ConversationExport = {
      version: 1,
      source: {
        url: "https://chatgpt.com/g/project/c/thread-1",
        conversationId: "thread-1",
        targetId: "tab",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
      records: sevenRecords.map((role, ordinal) => ({
        ordinal,
        role,
        text: `turn ${ordinal}`,
        textHash: `hash-${ordinal}`,
      })),
      fingerprint: "export-hash",
      complete: true,
    };
    const parsed = JSON.parse(renderConversationExport(value, "json")) as ConversationExport;
    expect(parsed.records.map((record) => record.role)).toEqual(sevenRecords);
    expect(parsed.records[0]).not.toHaveProperty("pairedWith");
  });

  it("guards project/workspace shells by the actual /c/ thread id", () => {
    const shell = evaluateExpression("/g/project/c/other-thread", [
      fakeTurn("user", "wrong project turn"),
      fakeTurn("assistant", "wrong project answer"),
    ]);
    expect(shell).toMatchObject({ scopeMismatch: true, records: [] });
  });

  it("uses the main transcript instead of five same-page project-shell turns", () => {
    const actual = sevenRecords.map((role, ordinal) => fakeTurn(role, `actual ${ordinal}`));
    const shell = ["user", "assistant", "user", "assistant", "assistant"].map((role, ordinal) =>
      fakeTurn(role as "user" | "assistant", `shell ${ordinal}`),
    );
    const value = evaluateExpression("/g/project/c/actual-thread", actual, shell);
    expect(value.records).toHaveLength(7);
    expect(value.records.map((record) => record.text)).not.toContain("shell 0");
  });

  it("keeps collapsible user text from its DOM root and does not depend on labels", () => {
    const value = evaluateExpression("/g/project/c/actual-thread", [
      fakeTurn("user", "full hidden prompt remains in the DOM"),
      fakeTurn("assistant", "answer adjacent to the actual prompt"),
    ]);
    expect(value.records).toEqual([
      expect.objectContaining({ role: "user", text: "full hidden prompt remains in the DOM" }),
      expect.objectContaining({ role: "assistant", text: "answer adjacent to the actual prompt" }),
    ]);
  });

  it("rejects unsafe CDP ports", () => {
    expect(parseConversationPort("9334")).toBe(9334);
    expect(() => parseConversationPort("0")).toThrow("1 to 65535");
    expect(() => parseConversationPort("nope")).toThrow("1 to 65535");
  });

  it("keeps the export expression free of side-effecting CDP calls", () => {
    const expression = buildConversationExportExpression("thread-1");
    for (const forbidden of [
      ".click(",
      "Page.navigate",
      "Input.dispatch",
      "Target.createTarget",
      "CDP.New",
      "composer",
      "archive",
    ]) {
      expect(expression).not.toContain(forbidden);
    }
  });

  it("merges virtualized viewport windows into ordered, deduped records", () => {
    const roles = [
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ] as const;
    const records = roles.map((role, ordinal) => ({
      role,
      text: `turn ${ordinal}`,
      messageId: `id-${ordinal}`,
    }));
    const merged = new Map<string, (typeof records)[number]>();
    // pass1: records 0-2, pass2: records 2-5 (overlap at 2), pass3: records 4-6 (overlap at 4-5)
    mergeConversationRecords(merged, records.slice(0, 3));
    mergeConversationRecords(merged, records.slice(2, 6));
    mergeConversationRecords(merged, records.slice(4, 7));
    const finalRecords = Array.from(merged.values());
    expect(finalRecords).toHaveLength(7);
    expect(finalRecords.map((record) => record.role)).toEqual(roles);
    expect(new Set(finalRecords.map((record) => record.messageId)).size).toBe(7);
  });
});

describe("buildConversationExportExpression text scoping (sr-only stripping)", () => {
  it('strips sr-only accessibility labels (e.g. "あなた:") from the returned text', () => {
    const turn = new FakeNode("DIV", {
      attrs: { "data-message-author-role": "user", "data-testid": "conversation-turn-1" },
      children: [
        new FakeNode("H5", { className: "sr-only", text: "あなた:" }),
        new FakeNode("DIV", { text: "実際のユーザー入力テキスト" }),
      ],
    });
    const { records } = evaluateExpressionWithNodes("/c/actual-thread", [turn]);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe("実際のユーザー入力テキスト");
    expect(records[0]?.text).not.toContain("あなた:");
  });

  it("sources assistant text from the .markdown scope, excluding reasoning-UI text like 思考時間", () => {
    const turn = new FakeNode("DIV", {
      attrs: { "data-message-author-role": "assistant", "data-testid": "conversation-turn-2" },
      children: [
        new FakeNode("H5", { className: "sr-only", text: "ChatGPT:" }),
        new FakeNode("DIV", { className: "thinking-widget", text: "思考時間: 1m 15s" }),
        new FakeNode("DIV", { className: "markdown", text: "回答本文です" }),
      ],
    });
    const { records } = evaluateExpressionWithNodes("/c/actual-thread", [turn]);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe("回答本文です");
    expect(records[0]?.text).not.toContain("思考時間");
    expect(records[0]?.text).not.toContain("ChatGPT:");
  });

  it("keeps an assistant record with turnIndex even when the cleaned clone has no visible text", () => {
    const turnWithIndex = new FakeNode("DIV", {
      attrs: { "data-message-author-role": "assistant", "data-testid": "conversation-turn-3" },
      // Only an sr-only label; no .markdown, no other visible content — the
      // cleaned clone is empty, but turnIndex still parses, so this must not
      // be dropped (dropping it would create a false gap and complete:false).
      children: [new FakeNode("H5", { className: "sr-only", text: "ChatGPT:" })],
    });
    const { records } = evaluateExpressionWithNodes("/c/actual-thread", [turnWithIndex]);
    expect(records).toHaveLength(1);
    expect(records[0]?.text).toBe("");
    expect(records[0]?.turnIndex).toBe(3);
  });

  it("still skips a record with neither visible text nor a parseable turnIndex", () => {
    const turnWithoutIndex = new FakeNode("DIV", {
      attrs: { "data-message-author-role": "assistant" },
      children: [new FakeNode("H5", { className: "sr-only", text: "ChatGPT:" })],
    });
    const { records } = evaluateExpressionWithNodes("/c/actual-thread", [turnWithoutIndex]);
    expect(records).toHaveLength(0);
  });
});

describe("exportChatGptConversationViaDom CDP surface", () => {
  it("only calls Runtime.evaluate and close, and restores scroll positions", async () => {
    const evaluateCalls: string[] = [];
    const twoRecords = [
      { role: "user", text: "hi", messageId: "m1" },
      { role: "assistant", text: "hello", messageId: "m2" },
    ];
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      evaluateCalls.push(expression);
      if (expression.includes("scopeMismatch")) {
        return {
          result: {
            value: {
              scopeMismatch: false,
              url: "https://chatgpt.com/c/thread-1",
              records: twoRecords,
            },
          },
        };
      }
      if (expression.includes("best.scrollHeight")) {
        return {
          result: {
            value: { scrollHeight: 300, clientHeight: 300, scrollTop: 300, bottomReached: true },
          },
        };
      }
      return { result: {} };
    });
    const close = vi.fn(async () => undefined);
    const client = { Runtime: { evaluate }, close };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/thread-1" } as never,
    }));

    const value = await exportChatGptConversationViaDom({ connect: connect as never });

    expect(value.records.map((record) => record.role)).toEqual(["user", "assistant"]);
    expect(close).toHaveBeenCalledOnce();
    expect(
      evaluateCalls.some((expr) => expr.includes("window.__oracleConversationScroll ||")),
    ).toBe(true);
    // The mock client exposes only Runtime/close: any Page/Input/Target access would throw.
    expect(Object.keys(client)).toEqual(["Runtime", "close"]);
  });

  it("strips text, markdown, and html from records when redactText is set", async () => {
    const SECRET_TEXT = "the secret user prompt";
    const SECRET_MARKDOWN = "**the secret assistant markdown**";
    const SECRET_HTML = "<p>the secret assistant html</p>";
    const twoRecords = [
      { role: "user", text: SECRET_TEXT, messageId: "m1" },
      {
        role: "assistant",
        text: "the secret assistant plain text",
        markdown: SECRET_MARKDOWN,
        html: SECRET_HTML,
        messageId: "m2",
      },
    ];
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("scopeMismatch")) {
        return {
          result: {
            value: {
              scopeMismatch: false,
              url: "https://chatgpt.com/c/thread-1",
              records: twoRecords,
            },
          },
        };
      }
      if (expression.includes("best.scrollHeight")) {
        return {
          result: {
            value: { scrollHeight: 300, clientHeight: 300, scrollTop: 300, bottomReached: true },
          },
        };
      }
      return { result: {} };
    });
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/thread-1" } as never,
    }));

    const value = await exportChatGptConversationViaDom({
      connect: connect as never,
      redactText: true,
    });

    const serialized = JSON.stringify(value.records);
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain(SECRET_MARKDOWN);
    expect(serialized).not.toContain(SECRET_HTML);
    expect(serialized).not.toContain("the secret assistant plain text");
    for (const record of value.records) {
      expect(record.text).toBeUndefined();
      expect(record.markdown).toBeUndefined();
      expect(record.html).toBeUndefined();
      expect(record.textHash).toBeTruthy();
    }
  });
});

describe("normalizeConversationRef", () => {
  it("reduces a bare ChatGPT conversation URL to its stable id", () => {
    expect(
      normalizeConversationRef("https://chatgpt.com/c/68f067e2-1111-2222-3333-444455556666"),
    ).toBe("68f067e2-1111-2222-3333-444455556666");
  });

  it("reduces a project-prefixed ChatGPT conversation URL to its stable id", () => {
    expect(
      normalizeConversationRef(
        "https://chatgpt.com/g/g-p-abc123-my-project/c/68f067e2-1111-2222-3333-444455556666",
      ),
    ).toBe("68f067e2-1111-2222-3333-444455556666");
  });

  it("passes non-URL refs (targetId, title substrings) through unchanged", () => {
    expect(normalizeConversationRef("18F3A2BC91")).toBe("18F3A2BC91");
    expect(normalizeConversationRef("My ChatGPT conversation title")).toBe(
      "My ChatGPT conversation title",
    );
  });

  it("passes undefined through unchanged", () => {
    expect(normalizeConversationRef(undefined)).toBeUndefined();
  });

  it("normalizes the ref before it reaches the connect DI hook", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("scopeMismatch")) {
        return {
          result: {
            value: {
              scopeMismatch: false,
              url: "https://chatgpt.com/g/g-p-abc/c/thread-1",
              records: [{ role: "user", text: "hi", messageId: "m1" }],
            },
          },
        };
      }
      if (expression.includes("best.scrollHeight")) {
        return {
          result: {
            value: { scrollHeight: 300, clientHeight: 300, scrollTop: 300, bottomReached: true },
          },
        };
      }
      return { result: {} };
    });
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async (opts: { ref?: string }) => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/g/g-p-abc/c/thread-1" } as never,
      __receivedRef: opts.ref,
    }));

    await exportChatGptConversationViaDom({
      connect: connect as never,
      ref: "https://chatgpt.com/c/thread-1",
    });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ ref: "thread-1" }));
  });
});

describe("evaluateCompleteness / sortConversationRecords (turnIndex gap detection)", () => {
  function turn(turnIndex: number, role: "user" | "assistant" = "user") {
    return { role, text: `turn ${turnIndex}`, turnIndex, messageId: `id-${turnIndex}` };
  }

  it("flags a repeated-viewport crawl (1,2,68-72,3,4) as incomplete with the exact gap 5..67", () => {
    const merged = new Map<string, ReturnType<typeof turn>>();
    // Reproduces the real-world defect: a virtualized transcript can go
    // "stable" (same viewport window repeats) while a whole mid-conversation
    // block was never scraped.
    mergeConversationRecords(merged, [turn(1), turn(2, "assistant")]);
    mergeConversationRecords(
      merged,
      [68, 69, 70, 71, 72].map((n) => turn(n, n % 2 === 0 ? "assistant" : "user")),
    );
    mergeConversationRecords(merged, [turn(3, "assistant"), turn(4)]);

    const records = Array.from(merged.values());
    const { complete, missingTurnIndices } = evaluateCompleteness(records, true);

    expect(complete).toBe(false);
    expect(missingTurnIndices).toEqual(Array.from({ length: 67 - 5 + 1 }, (_, i) => i + 5));

    const sorted = sortConversationRecords(records);
    expect(sorted.map((record) => record.turnIndex)).toEqual([1, 2, 3, 4, 68, 69, 70, 71, 72]);
  });

  it("reports complete when turnIndex coverage is contiguous and the crawl settled", () => {
    const merged = new Map<string, ReturnType<typeof turn>>();
    mergeConversationRecords(
      merged,
      Array.from({ length: 7 }, (_, i) => turn(i + 1, i % 2 === 0 ? "user" : "assistant")),
    );
    const records = Array.from(merged.values());

    const { complete, missingTurnIndices } = evaluateCompleteness(records, true);
    expect(complete).toBe(true);
    expect(missingTurnIndices).toEqual([]);
    expect(sortConversationRecords(records).map((record) => record.turnIndex)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("stays incomplete when the crawl never settled, even with contiguous turnIndex coverage", () => {
    const records = [turn(1), turn(2, "assistant"), turn(3)];
    const { complete, missingTurnIndices } = evaluateCompleteness(records, false);
    expect(complete).toBe(false);
    expect(missingTurnIndices).toEqual([]);
  });

  it("falls back to crawlSettled alone (missingTurnIndices undefined) when no record has a turnIndex", () => {
    const records = [{ role: "user" as const, text: "hi", messageId: "m1" }];
    expect(evaluateCompleteness(records, true)).toEqual({ complete: true });
    expect(evaluateCompleteness(records, false)).toEqual({ complete: false });
    expect(evaluateCompleteness(records, true).missingTurnIndices).toBeUndefined();
  });
});

describe("exportChatGptConversationViaDom end-to-end crawl completeness", () => {
  it("surfaces complete:false and the exact missingTurnIndices for out-of-order virtualized passes", async () => {
    const viewportPasses = [
      [1, 2],
      [68, 69, 70, 71, 72],
      [3, 4],
    ];
    let passIndex = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("scopeMismatch")) {
        const turns = viewportPasses[Math.min(passIndex, viewportPasses.length - 1)];
        passIndex += 1;
        return {
          result: {
            value: {
              scopeMismatch: false,
              url: "https://chatgpt.com/c/thread-1",
              records: turns.map((n) => ({
                role: n % 2 === 0 ? "assistant" : "user",
                text: `turn ${n}`,
                turnIndex: n,
                messageId: `id-${n}`,
                domTestId: `conversation-turn-${n}`,
              })),
            },
          },
        };
      }
      if (expression.includes("best.scrollHeight")) {
        // The viewport reports "at bottom" from the first scroll: this
        // reproduces the real defect where the crawl reaches a settled
        // bottom while a mid-conversation block (turns 5-67) was still
        // never scraped by any pass.
        return {
          result: {
            value: { scrollHeight: 300, clientHeight: 300, scrollTop: 300, bottomReached: true },
          },
        };
      }
      return { result: {} };
    });
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/thread-1" } as never,
    }));

    const value = await exportChatGptConversationViaDom({ connect: connect as never });

    expect(value.complete).toBe(false);
    expect(value.missingTurnIndices).toEqual(Array.from({ length: 67 - 5 + 1 }, (_, i) => i + 5));
    expect(value.records.map((record) => record.turnIndex)).toEqual([
      1, 2, 3, 4, 68, 69, 70, 71, 72,
    ]);
  });

  it("surfaces complete:true when every turn is captured and the crawl settles at the bottom", async () => {
    const allTurns = [1, 2, 3, 4, 5];
    let scraped = false;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("scopeMismatch")) {
        scraped = true;
        return {
          result: {
            value: {
              scopeMismatch: false,
              url: "https://chatgpt.com/c/thread-1",
              records: allTurns.map((n) => ({
                role: n % 2 === 0 ? "assistant" : "user",
                text: `turn ${n}`,
                turnIndex: n,
                messageId: `id-${n}`,
                domTestId: `conversation-turn-${n}`,
              })),
            },
          },
        };
      }
      if (expression.includes("best.scrollHeight")) {
        return {
          result: {
            value: {
              scrollHeight: 300,
              clientHeight: 300,
              scrollTop: 300,
              bottomReached: scraped,
            },
          },
        };
      }
      return { result: {} };
    });
    const client = { Runtime: { evaluate }, close: vi.fn(async () => undefined) };
    const connect = vi.fn(async () => ({
      client,
      targetId: "target-1",
      tab: { url: "https://chatgpt.com/c/thread-1" } as never,
    }));

    const value = await exportChatGptConversationViaDom({ connect: connect as never });

    expect(value.complete).toBe(true);
    expect(value.missingTurnIndices).toEqual([]);
    expect(value.records.map((record) => record.turnIndex)).toEqual([1, 2, 3, 4, 5]);
  });
});
