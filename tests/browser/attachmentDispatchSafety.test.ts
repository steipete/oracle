import { expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadAttachmentViaDataTransfer } from "../../src/browser/actions/remoteFileTransfer.js";
import {
  activateComposerPlus,
  uploadAttachmentFile,
} from "../../src/browser/actions/attachments.js";
import { __test__ as composer, submitPrompt } from "../../src/browser/actions/promptComposer.js";

test.each([1, 2])("never repeats plus activation after key event %s fails", async (failure) => {
  const runtime = {
    evaluate: vi.fn().mockResolvedValue({
      result: {
        value: {
          status: "focused",
          focused: true,
          startUrl: "https://chatgpt.com/",
          currentUrl: "https://chatgpt.com/",
        },
      },
    }),
  };
  let events = 0;
  const input = {
    dispatchKeyEvent: vi.fn(async () => {
      if (++events === failure) throw new Error("transport failed after possible dispatch");
    }),
  };
  await expect(activateComposerPlus(runtime as never, input as never)).rejects.toThrow(
    "transport failed",
  );
  expect(runtime.evaluate).toHaveBeenCalledTimes(3);
  expect(input.dispatchKeyEvent).toHaveBeenCalledTimes(failure);
});

test.each([
  { focused: false, attachmentsReady: true },
  { focused: true, attachmentsReady: false },
])("rechecks final dispatch state %j before sending a key", async (state) => {
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: expression.includes("currentUrl: location.href")
          ? { currentUrl: "https://chatgpt.com/", workSelected: false, ...state }
          : { status: "focused" },
      },
    })),
  };
  const input = { dispatchKeyEvent: vi.fn() };
  expect(
    await composer.activateExactAttachmentSendButton(
      runtime as never,
      input as never,
      undefined,
      "https://chatgpt.com/",
    ),
  ).toBe(false);
  expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
});

test("refuses changed context before staging any attachment prompt text", async () => {
  const runtime = {
    evaluate: vi.fn().mockResolvedValue({
      result: { value: { currentUrl: "https://chatgpt.com/c/wrong", workSelected: false } },
    }),
  };
  const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
  await expect(
    submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        attachmentNames: ["first.png"],
        attachmentNavigationUrl: "https://chatgpt.com/c/expected",
      },
      "Do not stage in another conversation.",
      Object.assign(vi.fn(), { verbose: false }),
    ),
  ).rejects.toMatchObject({ details: { code: "attachment-control-unexpected-navigation" } });
  expect(runtime.evaluate).toHaveBeenCalledTimes(1);
  expect(input.insertText).not.toHaveBeenCalled();
  expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
});

test("rejects navigation during the missing-plus delay before assigning a file", async () => {
  vi.useFakeTimers();
  try {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: expression.includes("const startUrl = navigation.currentUrl")
            ? { status: "missing", startUrl: "https://chatgpt.com/" }
            : expression.includes("currentUrl: location.href")
              ? { currentUrl: "https://chatgpt.com/c/wrong", workSelected: false }
              : { ui: false, input: false },
        },
      })),
    };
    const dom = { getDocument: vi.fn(), setFileInputFiles: vi.fn() };
    const pending = uploadAttachmentFile(
      { runtime: runtime as never, dom: dom as never },
      { path: "/tmp/synthetic.png", displayPath: "synthetic.png" },
      () => {},
    );
    const assertion = expect(pending).rejects.toMatchObject({
      details: { code: "attachment-control-unexpected-navigation" },
    });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("does not hide a failed plus probe as a missing control", async () => {
  const runtime = { evaluate: vi.fn().mockRejectedValue(new Error("execution context destroyed")) };
  await expect(activateComposerPlus(runtime as never)).rejects.toThrow(
    "execution context destroyed",
  );
});

test("rechecks remote context after reading file bytes and before assigning them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-transfer-guard-"));
  const file = path.join(root, "synthetic.txt");
  await fs.writeFile(file, "synthetic attachment");
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: expression.includes("currentUrl: location.href")
          ? {
              success: false,
              navigationBlocked: { currentUrl: "https://chatgpt.com/c/wrong", workSelected: false },
            }
          : true,
      },
    })),
  };
  const dom = {
    getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
    querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
  };
  try {
    await expect(
      uploadAttachmentViaDataTransfer(
        {
          runtime: runtime as never,
          dom: dom as never,
          navigationUrl: "https://chatgpt.com/c/expected",
        },
        { path: file, displayPath: "synthetic.txt" },
        () => {},
      ),
    ).rejects.toMatchObject({ details: { code: "attachment-control-unexpected-navigation" } });
    expect(
      runtime.evaluate.mock.calls.some(([params]) =>
        params.expression.includes("const base64Data"),
      ),
    ).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves the original context before activating any plus control", async () => {
  const input = { dispatchKeyEvent: vi.fn() };
  const runtime = {
    evaluate: vi.fn().mockResolvedValue({
      result: {
        value: {
          status: "context-changed",
          startUrl: "https://chatgpt.com/c/original",
          navigation: { currentUrl: "https://chatgpt.com/c/other", workSelected: false },
        },
      },
    }),
  };
  await expect(
    activateComposerPlus(runtime as never, input as never, "https://chatgpt.com/c/original"),
  ).rejects.toMatchObject({ details: { code: "attachment-control-unexpected-navigation" } });
  expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  expect(runtime.evaluate).toHaveBeenCalledOnce();
});
