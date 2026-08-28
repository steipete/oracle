import { describe, expect, test, vi } from "vitest";
import { buildAttachmentEvidenceExpression } from "../../src/browser/actions/attachmentEvidence.js";
import {
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForAttachmentVisible,
} from "../../src/browser/actions/attachments.js";
import { buildAttachmentReadyExpressionForTest } from "../../src/browser/actions/promptComposer.js";
import { FakeDocument, FakeElement, FakeInputElement } from "./domFixture.js";

function fixture() {
  const form = new FakeElement("form", { "data-testid": "composer" }, [
    new FakeElement("textarea", { id: "prompt-textarea" }),
    new FakeInputElement([]),
    new FakeElement("button", { "data-testid": "send-button" }),
  ]);
  const document = new FakeDocument([form]);
  const renderer = {};
  const evaluate = (expression: string) =>
    new Function(
      "document",
      "HTMLElement",
      "HTMLInputElement",
      "window",
      "globalThis",
      `return ${expression};`,
    )(
      document,
      FakeElement,
      FakeInputElement,
      { getComputedStyle: () => ({ pointerEvents: "auto" }) },
      renderer,
    );
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: evaluate(expression) },
    })),
  };
  const action = (
    names: string[],
    kind: "read" | "begin" | "confirm" | "clear" = "read",
    id?: string,
  ) => evaluate(buildAttachmentEvidenceExpression(names, kind, id));
  const addPreview = (parent = form) => {
    const control = new FakeElement("button", { "aria-label": "Remove attachment" });
    parent.append(new FakeElement("div", { "data-testid": "attachment-chip" }, [control]));
    return control;
  };
  return { form, document, runtime, evaluate, action, addPreview };
}

describe("per-file attachment evidence", () => {
  test.each([
    "Remove attachment",
    "Remove file 1: first.md",
    "Remove file 1: added.md",
    "Remove file 1: upload.txt",
  ])("upload never uses %s as the add button", async (label) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const remove = new FakeElement("button", { "aria-label": label });
      const click = vi.fn();
      Object.assign(remove, { click, scrollIntoView: () => {} });
      f.form.append(remove);
      const input = { dispatchMouseEvent: vi.fn() };
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: expression.includes("'#composer-plus-btn'")
              ? f.evaluate(expression)
              : { input: true },
          },
        })),
      };
      const upload = uploadAttachmentFile(
        { runtime: runtime as never, dom: {} as never, input: input as never },
        { path: "/tmp/second.txt", displayPath: "second.txt" },
        () => {},
      );
      await vi.advanceTimersByTimeAsync(500);
      await expect(upload).resolves.toBe(true);
      expect(click).not.toHaveBeenCalled();
      expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("carries a filename-less assignment through visibility, completion, and send readiness", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect(f.action(["image.jpg"], "begin", "first")).toBe(true);
      f.addPreview();
      expect(f.action([], "confirm", "first")).toBe(true);
      expect(f.action(["image.jpg", "missing.txt"])).toEqual([true, false]);
      await waitForAttachmentVisible(f.runtime as never, "image.jpg", 500);
      const completion = waitForAttachmentCompletion(f.runtime as never, 3_000, ["image.jpg"]);
      await vi.advanceTimersByTimeAsync(2_500);
      await completion;
      expect(f.evaluate(buildAttachmentReadyExpressionForTest(["image.jpg"]))).toBe(true);
      expect(f.evaluate(buildAttachmentReadyExpressionForTest(["image.jpg", "missing.txt"]))).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("never credits a pre-existing or sidebar control to an assignment", () => {
    const f = fixture();
    f.addPreview();
    f.action(["image.jpg"], "begin", "first");
    f.addPreview(f.document.body);
    expect(f.action([], "confirm", "first")).toBe(false);
    expect(f.action(["image.jpg"])).toEqual([false]);
  });

  test("rejects ambiguous additions and never spends one control on two files", () => {
    const f = fixture();
    f.action(["one.jpg"], "begin", "first");
    const one = f.addPreview();
    const other = f.addPreview();
    expect(f.action([], "confirm", "first")).toBe(false);
    other.remove();
    expect(f.action([], "confirm", "first")).toBe(true);
    f.action(["two.jpg"], "begin", "second");
    expect(f.action([], "confirm", "second")).toBe(false);
    one.remove();
    f.addPreview();
    expect(f.action(["one.jpg"])).toEqual([false]);
  });

  test("a removed/replaced attachment, a new composer, and explicit clear invalidate evidence", () => {
    const f = fixture();
    f.action(["image.jpg"], "begin", "first");
    const control = f.addPreview();
    f.action([], "confirm", "first");
    control.remove();
    f.addPreview();
    expect(f.action(["image.jpg"])).toEqual([false]);
    f.action(["image.jpg"], "begin", "second");
    f.addPreview();
    f.action([], "confirm", "second");
    expect(f.action(["image.jpg"])).toEqual([true]);
    f.action([], "clear");
    expect(f.action(["image.jpg"])).toEqual([false]);
    f.action(["image.jpg"], "begin", "third");
    f.addPreview();
    f.action([], "confirm", "third");
    f.form.remove();
    expect(f.action(["image.jpg"])).toEqual([false]);
  });
});
