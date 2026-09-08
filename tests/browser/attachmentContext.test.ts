import { expect, test, vi } from "vitest";
import {
  buildComposerNavigationValidationExpression,
  buildFileInputGuardExpression,
} from "../../src/browser/actions/attachmentContext.js";

type FileEvent = {
  target: unknown;
  type: string;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};
function renderer(
  url: string,
  labels: Array<{
    text: string;
    selected: boolean;
    mode?: string;
    role?: string;
    inMessage?: boolean;
    inComposer?: boolean;
  }> = [],
) {
  const listeners = new Map<string, (event: FileEvent) => void>();
  const input = { value: "existing-selection", type: "file", getAttribute: () => null };
  const radios = labels.map((label) => ({
    textContent: label.text,
    inComposer: label.inComposer,
    matches: () => true,
    closest: () => (label.inMessage ? {} : null),
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: (name: string) =>
      name ===
      (label.role === "tab"
        ? "aria-selected"
        : label.role === "pressed"
          ? "aria-pressed"
          : label.role === "state"
            ? "data-state"
            : "aria-checked")
        ? label.role === "state"
          ? "active"
          : String(label.selected)
        : name === "data-mode"
          ? (label.mode ?? null)
          : null,
  }));
  const composer = { contains: (node: { inComposer?: boolean }) => Boolean(node.inComposer) };
  const prompt = { getAttribute: () => null, closest: () => composer };
  const document = { querySelector: () => prompt, querySelectorAll: () => radios };
  const window = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    addEventListener: (name: string, handler: (event: FileEvent) => void) =>
      listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const location = { href: url, pathname: new URL(url).pathname };
  const evaluate = (expression: string) =>
    Function(
      "document",
      "window",
      "location",
      "input",
      `return ${expression};`,
    )(document, window, location, input);
  return { input, listeners, location, evaluate };
}

test.each(["https://chatgpt.com/c/WEB:task", "https://chatgpt.com/g/project/c/WEB%3Atask"])(
  "recognizes Work identity independently of labels: %s",
  (url) => {
    const page = renderer(url);
    expect(page.evaluate(buildComposerNavigationValidationExpression(url))).toMatchObject({
      workSelected: true,
      contextMatches: false,
    });
  },
);

test.each(["radio", "tab", "pressed"])(
  "does not infer mode from an unrelated or localized selected %s control",
  (role) => {
    const page = renderer("https://chatgpt.com/", [
      { text: "Unterhaltung", selected: false },
      { text: "Unterhaltung", selected: true, role },
    ]);
    expect(
      page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
    ).toMatchObject({ modeUnverified: false, contextMatches: true });
  },
);

test.each(["Deep research", "Web search"])(
  "does not treat the %s tool as an unknown mode",
  (text) => {
    const page = renderer("https://chatgpt.com/", [{ text, selected: true, role: "pressed" }]);
    expect(
      page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
    ).toMatchObject({ modeUnverified: false, contextMatches: true });
  },
);

test("ignores selected feedback or content controls inside conversation turns", () => {
  const page = renderer("https://chatgpt.com/", [
    { text: "Arbeit", selected: true, role: "pressed", inMessage: true },
  ]);
  expect(
    page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
  ).toMatchObject({ modeUnverified: false, workSelected: false, contextMatches: true });
});

test.each(["radio", "tab", "pressed", "state"])(
  "uses a machine-readable Work value with localized %s control",
  (role) => {
    const page = renderer("https://chatgpt.com/", [
      { text: "Arbeit", selected: true, mode: "work", role },
    ]);
    expect(
      page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
    ).toMatchObject({ workSelected: true, contextMatches: false });
  },
);

test("an invalid initial context preserves a preexisting file selection", () => {
  const page = renderer("https://chatgpt.com/c/wrong");
  const guard = page.evaluate(
    buildFileInputGuardExpression("input", "https://chatgpt.com/c/expected"),
  );
  expect(guard.blocked).toMatchObject({ contextMatches: false });
  expect(page.input.value).toBe("existing-selection");
  expect(page.listeners.size).toBe(0);
});

test("rolls back a newly assigned selection before application input/change handlers", () => {
  const page = renderer("https://chatgpt.com/c/expected");
  const guard = page.evaluate(buildFileInputGuardExpression("input", page.location.href));
  expect(guard.blocked).toBeNull();
  page.location.href = "https://chatgpt.com/c/wrong";
  page.location.pathname = "/c/wrong";
  for (const type of ["input", "change"]) {
    const event = {
      type,
      target: page.input,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    page.listeners.get(type)?.(event);
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  expect(page.input.value).toBe("");
  expect(guard.blocked).toMatchObject({ contextMatches: false });
  expect(page.listeners.size).toBe(0);
});

test("ignores an unrelated selected sidebar item named Work", () => {
  const page = renderer("https://chatgpt.com/", [{ text: "Work", selected: true, role: "tab" }]);
  expect(
    page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
  ).toMatchObject({ workSelected: false, contextMatches: true });
});

test("recognizes a selected Work label on a composer control", () => {
  const page = renderer("https://chatgpt.com/", [
    { text: "Work", selected: true, role: "pressed", inComposer: true },
  ]);
  expect(
    page.evaluate(buildComposerNavigationValidationExpression("https://chatgpt.com/")),
  ).toMatchObject({ workSelected: true, contextMatches: false });
});
