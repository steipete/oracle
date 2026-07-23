import { createContext, Script } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  buildPinConversationExpressionForTest,
  pinCurrentConversation,
} from "../../src/browser/actions/pinConversation.js";

describe("pinCurrentConversation", () => {
  test("waits until ChatGPT exposes the verified Unpin state", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: { status: "ready", title: "Tracker" } } })
          .mockResolvedValueOnce({ result: { value: { status: "clicked", title: "Tracker" } } })
          .mockResolvedValueOnce({ result: { value: { status: "pinned", title: "Tracker" } } }),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });
      const promise = pinCurrentConversation(runtime as never, logger as never, 1_000);
      await vi.advanceTimersByTimeAsync(300);

      await expect(promise).resolves.toMatchObject({
        attempted: true,
        pinned: true,
        alreadyPinned: false,
        title: "Tracker",
      });
      expect(runtime.evaluate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports an already-pinned conversation without clicking", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "pinned", title: "Tracker" } },
      }),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      pinCurrentConversation(runtime as never, logger as never, 100),
    ).resolves.toMatchObject({ pinned: true, alreadyPinned: true });
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  });

  test("executes the DOM click path and observes the resulting Unpin state", () => {
    class FakeElement {
      public href = "";
      public textContent = "";
      public children: FakeElement[] = [];
      public click = vi.fn();

      public constructor(public attributes: Record<string, string> = {}) {}

      public getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      public querySelectorAll(selector: string): FakeElement[] {
        return selector === "button[aria-label]" ? this.children : [];
      }
    }

    const pinButton = new FakeElement({ "aria-label": "Pin Tracker" });
    pinButton.click.mockImplementation(() => {
      pinButton.attributes["aria-label"] = "Unpin Tracker";
    });
    const anchor = new FakeElement({ "aria-label": "Tracker" });
    anchor.href = "https://chatgpt.com/c/abc";
    anchor.textContent = "Tracker";
    anchor.children = [pinButton];
    const context = createContext({
      URL,
      HTMLElement: FakeElement,
      location: { pathname: "/c/abc", href: "https://chatgpt.com/c/abc" },
      document: {
        querySelectorAll: (selector: string) => (selector === 'a[href*="/c/"]' ? [anchor] : []),
      },
    });
    const evaluate = (click: boolean) =>
      new Script(buildPinConversationExpressionForTest(click)).runInContext(context);

    expect(evaluate(false)).toMatchObject({ status: "ready", conversationId: "abc" });
    expect(evaluate(true)).toMatchObject({ status: "clicked", conversationId: "abc" });
    expect(pinButton.click).toHaveBeenCalledTimes(1);
    expect(evaluate(false)).toMatchObject({ status: "pinned", conversationId: "abc" });
  });
});
