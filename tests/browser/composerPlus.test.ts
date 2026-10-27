import { expect, test, vi } from "vitest";
import { activateComposerPlus } from "../../src/browser/actions/attachments.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

function fixture(attributes: Record<string, string>) {
  const button = new FakeElement("button", attributes);
  const document = Object.assign(
    new FakeDocument([
      new FakeElement("form", { "data-chatgpt-composer": "" }, [
        new FakeElement("div", { id: "prompt-textarea", contenteditable: "true", role: "textbox" }),
        button,
      ]),
    ]),
    { activeElement: null as FakeElement | null },
  );
  Object.assign(button, {
    focus: () => {
      document.activeElement = button;
    },
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function(
          "document",
          "HTMLElement",
          "window",
          "location",
          "URL",
          "Node",
          `return ${expression};`,
        )(document, FakeElement, window, new URL("https://chatgpt.com/"), URL, FakeElement),
      },
    })),
  };
  const input = {
    dispatchKeyEvent: vi.fn(async ({ type, key }: { type: string; key: string }) => {
      listeners.get(type.toLowerCase())?.({
        key,
        isTrusted: true,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      });
    }),
  };
  const activate = () =>
    activateComposerPlus(runtime as never, input as never, "https://chatgpt.com/");
  return { activate, button, document, input, listeners };
}

test.each<Record<string, string>>([
  { id: "composer-plus-btn" },
  { "data-testid": "composer-plus-btn" },
  { "data-composer-navigation-target": "add-context" },
])(
  "activates the exact composer plus control through probe and dispatch guards: %j",
  async (attributes) => {
    const f = fixture(attributes);
    await expect(f.activate()).resolves.toEqual({
      method: "trusted-keyboard",
      startUrl: "https://chatgpt.com/",
    });
    expect(f.document.activeElement).toBe(f.button);
    expect(f.input.dispatchKeyEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "keyDown",
      "keyUp",
    ]);
    expect(f.listeners.size).toBe(0);
  },
);

test("does not activate an unrelated navigation control", async () => {
  const f = fixture({ "data-composer-navigation-target": "send" });
  await expect(f.activate()).resolves.toEqual({
    method: "unavailable",
    startUrl: "https://chatgpt.com/",
  });
  expect(f.input.dispatchKeyEvent).not.toHaveBeenCalled();
});

test("does not dispatch to a disabled add-context button", async () => {
  const f = fixture({ "data-composer-navigation-target": "add-context", disabled: "" });
  await expect(f.activate()).rejects.toMatchObject({
    details: { code: "attachment-plus-not-ready" },
  });
  expect(f.input.dispatchKeyEvent).not.toHaveBeenCalled();
});

test("ignores a hidden legacy button before the visible add-context control", async () => {
  const f = fixture({ "data-composer-navigation-target": "add-context" });
  const hidden = new FakeElement("button", { id: "composer-plus-btn" });
  Object.assign(hidden, { getBoundingClientRect: () => ({ width: 0, height: 0 }) });
  hidden.parentElement = f.document.body;
  f.document.body.children.unshift(hidden);
  await expect(f.activate()).resolves.toMatchObject({ method: "trusted-keyboard" });
  expect(f.document.activeElement).toBe(f.button);
});
