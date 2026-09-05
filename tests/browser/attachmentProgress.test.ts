import { afterEach, expect, test, vi } from "vitest";
import { waitForAttachmentCompletion } from "../../src/browser/actions/attachments.js";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

afterEach(() => vi.useRealTimers());

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
  const evaluate = (expression: string) =>
    new Function("document", "HTMLElement", "HTMLInputElement", "window", `return ${expression};`)(
      document,
      FakeElement,
      FakeInputElement,
      { getComputedStyle: () => ({ pointerEvents: "auto" }) },
    );
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression) },
    })),
  } as unknown as ChromeClient["Runtime"];
  return { evaluate, runtime, form };
}

test.each([
  ["upload state", { "data-state": "uploading" }, ""],
  ["pending state", { "data-state": "pending" }, ""],
  ["progress text", { "aria-live": "polite" }, "Uploading 50%"],
  ["processing text", { "data-testid": "attachment-status" }, "Processing…"],
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
