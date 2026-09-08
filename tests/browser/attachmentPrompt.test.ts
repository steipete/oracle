import { expect, test, vi } from "vitest";
import { stageAttachmentPrompt } from "../../src/browser/actions/attachmentPrompt.js";

test("refuses a context changed during DOM readiness before inserting any prompt", async () => {
  const runtime = {
    evaluate: vi.fn().mockResolvedValue({
      result: {
        value: {
          ready: false,
          blocked: { currentUrl: "https://chatgpt.com/c/other", workSelected: false },
        },
      },
    }),
  };
  await expect(
    stageAttachmentPrompt(runtime as never, "private prompt", "https://chatgpt.com/c/original"),
  ).rejects.toMatchObject({ details: { code: "attachment-control-unexpected-navigation" } });
  expect(runtime.evaluate).toHaveBeenCalledTimes(2); // preparation and guard cleanup
});

test("does not repeat an ambiguously acknowledged renderer insertion", async () => {
  const runtime = {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce({ result: { value: { ready: true } } })
      .mockRejectedValueOnce(new Error("transport failed after possible insertion"))
      .mockResolvedValue({}),
  };
  await expect(
    stageAttachmentPrompt(runtime as never, "private prompt", "https://chatgpt.com/c/original"),
  ).rejects.toThrow("transport failed");
  expect(runtime.evaluate).toHaveBeenCalledTimes(3); // prepare, one insertion, cleanup
});

test("does not fall back when navigation replaced the guarded document", async () => {
  const runtime = {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce({ result: { value: { ready: true } } })
      .mockResolvedValueOnce({ result: { value: { ready: false } } })
      .mockResolvedValue({}),
  };
  await expect(
    stageAttachmentPrompt(runtime as never, "private prompt", "https://chatgpt.com/c/original"),
  ).rejects.toMatchObject({ details: { code: "attachment-prompt-not-ready" } });
  expect(runtime.evaluate).toHaveBeenCalledTimes(3);
});
