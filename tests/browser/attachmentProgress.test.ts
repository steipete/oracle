import { afterEach, expect, test, vi } from "vitest";
import { waitForAttachmentCompletion } from "../../src/browser/actions/attachments.js";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

afterEach(() => vi.useRealTimers());

test.each(["input", "textarea", "contenteditable", "hidden-input", "hidden-textarea"])(
  "explicit busy state on %s blocks completion and send",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const progress = new FakeElement(
      "div",
      kind === "contenteditable" ? { contenteditable: "true", "aria-busy": "true" } : {},
    );
    const { evaluate, runtime, form } = fixture(progress);
    if (kind !== "contenteditable") {
      const control = form.querySelector(kind.replace("hidden-", ""))!;
      const get = control.getAttribute.bind(control);
      control.getAttribute = (name) => (name === "aria-busy" ? "true" : get(name));
      if (kind.startsWith("hidden-"))
        control.getBoundingClientRect = () => ({ width: 0, height: 0 });
    }
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(false);
    const outcome = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]).then(
      () => "resolved",
      () => "timed-out",
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await outcome).toBe("timed-out");
  },
);

test.each(["", "true", "plaintext-only", "TRUE"])(
  "markup inside contenteditable=%s cannot assert upload state",
  async (value) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const editor = new FakeElement("div", { contenteditable: value }, [
      new FakeElement("span", { "data-state": "uploading" }),
    ]);
    const { evaluate, runtime } = fixture(editor);
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test.each([0.5, 1, null])(
  "native progress value %s has matching completion and send state",
  async (value) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const attributes: Record<string, string> = value === null ? {} : { value: String(value) };
    const progress = Object.assign(new FakeElement("progress", attributes), {
      value: value ?? 0,
      max: 1,
    });
    const { evaluate, runtime } = fixture(progress);
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(value === 1);
    const outcome = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]).then(
      () => "resolved",
      () => "timed-out",
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await outcome).toBe(value === 1 ? "resolved" : "timed-out");
  },
);

function fixture(progress: FakeElement, outside = false) {
  const form = new FakeElement("form", { "data-testid": "composer" }, [
    new FakeElement("textarea", { id: "prompt-textarea" }),
    new FakeInputElement([{ name: "a.txt" }, { name: "b.txt" }]),
    ...["a.txt", "b.txt"].map(
      (name) =>
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": `Remove file: ${name}` }),
        ]),
    ),
    new FakeElement("button", { "data-testid": "send-button" }),
  ]);
  if (!outside) form.append(progress);
  const document = new FakeDocument(outside ? [progress, form] : [form]);
  const styles = new Map<FakeElement, Record<string, string>>();
  const evaluate = (expression: string) =>
    new Function("document", "HTMLElement", "HTMLInputElement", "window", `return ${expression};`)(
      document,
      FakeElement,
      FakeInputElement,
      { getComputedStyle: (node: FakeElement) => ({ pointerEvents: "auto", ...styles.get(node) }) },
    );
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression) },
    })),
  } as unknown as ChromeClient["Runtime"];
  return { evaluate, runtime, form, styles };
}

test.each([
  ["upload state", { "data-state": "uploading" }, ""],
  ["pending state", { "data-state": "pending" }, ""],
  ["loading state", { "data-state": "loading" }, ""],
  ["ARIA busy", { "aria-busy": "true" }, ""],
  ["ARIA progress", { role: "progressbar", "aria-valuenow": "50" }, ""],
  ["ARIA role tokens", { role: "progressbar status", "aria-valuenow": "50" }, ""],
  ["ARIA role whitespace", { role: " progressbar ", "aria-valuenow": "50" }, ""],
  ["indeterminate ARIA progress", { role: "progressbar" }, ""],
] as const)(
  "completion and final send reject active %s beyond three seconds",
  async (_, attrs, text) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { evaluate, runtime } = fixture(new FakeElement("div", attrs, [], text));
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(false);
    const outcome = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]).then(
      () => "resolved",
      () => "timed-out",
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await outcome).toBe("timed-out");
  },
);

test.each(["outside", "hidden", "filename"])(
  "unrelated %s progress does not block completed files",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const progress =
      kind === "filename"
        ? new FakeElement("div", { "data-testid": "attachment-chip" }, [], "processing.ts")
        : new FakeElement("div", { "data-state": "uploading" });
    if (kind === "hidden") progress.getBoundingClientRect = () => ({ width: 0, height: 0 });
    const { evaluate, runtime } = fixture(progress, kind === "outside");
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test("completion waits for progress to clear and restarts its stability window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const progress = new FakeElement("div", { "data-state": "uploading" });
  const { evaluate, runtime } = fixture(progress);
  let completed = false;
  const completion = waitForAttachmentCompletion(runtime, 9_000, ["a.txt", "b.txt"]).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(4_000);
  expect(completed).toBe(false);
  progress.remove();
  expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await completion;
  expect(completed).toBe(true);
});

test("a missing send button cannot bypass active upload progress", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { form, runtime } = fixture(new FakeElement("div", { "data-state": "uploading" }));
  form.querySelector('[data-testid="send-button"]')?.remove();
  const outcome = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]).then(
    () => "resolved",
    () => "timed-out",
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await outcome).toBe("timed-out");
});

test.each(["self", "parent"])(
  "faded progress on %s does not block ready attachments",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const progress = new FakeElement("div", { "data-state": "uploading" });
    const wrapper = new FakeElement("div", {}, [progress]);
    const { evaluate, runtime, styles } = fixture(wrapper);
    styles.set(kind === "self" ? progress : wrapper, { opacity: "0" });
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test.each(["processing", "uploading", "processing notes.txt"])(
  "filename %s is not an upload status",
  async (name) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { evaluate, runtime } = fixture(
      new FakeElement("div", { "data-testid": "attachment-chip" }, [], name),
    );
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test("completed ARIA progress does not block ready attachments", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { evaluate, runtime } = fixture(
    new FakeElement(
      "div",
      { role: "progressbar", "aria-valuenow": "1", "aria-valuemax": "1" },
      [],
      "Uploading 100%",
    ),
  );
  expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
  const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
  await vi.advanceTimersByTimeAsync(2_000);
  await completion;
});

test.each(["Processing complete", "Finished uploading", "Processing is complete"])(
  "terminal status %s does not block ready attachments",
  async (text) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { evaluate, runtime } = fixture(new FakeElement("div", { role: "status" }, [], text));
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test.each(["one-pixel", "offscreen", "clip", "clip-path"])(
  "visually hidden %s status does not block attachments",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const progress = new FakeElement(
      "div",
      kind.startsWith("clip") ? { "data-state": "uploading" } : { role: "status" },
      [],
      "Uploading",
    );
    const { evaluate, runtime, styles } = fixture(progress);
    if (kind === "one-pixel") progress.getBoundingClientRect = () => ({ width: 1, height: 1 });
    if (kind === "offscreen")
      progress.getBoundingClientRect = () => ({ width: 100, height: 20, bottom: -1, right: -1 });
    if (kind === "clip") styles.set(progress, { clip: "rect(0px, 0px, 0px, 0px)" });
    if (kind === "clip-path") styles.set(progress, { clipPath: "inset(50%)" });
    expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(true);
    const completion = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await completion;
  },
);

test("explicit upload state remains blocking when the attachment is below the viewport", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const progress = new FakeElement("div", { "data-state": "uploading" });
  progress.getBoundingClientRect = () => ({ width: 100, height: 20, bottom: -1, right: -1 });
  const { evaluate, runtime } = fixture(progress);
  expect(evaluate(buildAttachmentReadyExpressionForTest(["a.txt", "b.txt"]))).toBe(false);
  const outcome = waitForAttachmentCompletion(runtime, 5_000, ["a.txt", "b.txt"]).then(
    () => "resolved",
    () => "timed-out",
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await outcome).toBe("timed-out");
});
