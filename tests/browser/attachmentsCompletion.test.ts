import { describe, expect, test, vi } from "vitest";
import {
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../../src/browser/pageActions.js";
import type { ChromeClient } from "../../src/browser/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe("attachment completion fallbacks", () => {
  test("reports the stalled ninth Markdown name while one text bundle becomes ready", async () => {
    useFakeTime();
    const names = [
      "01-alpha.md",
      "02-bravo.md",
      "03-charlie.md",
      "04-delta.md",
      "05-echo.md",
      "06-foxtrot.md",
      "07-golf.md",
      "08-hotel.md",
      "09-india.md",
    ];
    const directRuntime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "disabled",
            uploading: true,
            filesAttached: true,
            attachedNames: names.slice(0, -1),
            inputNames: names.slice(0, -1),
            fileCount: 8,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const directErrorPromise = waitForAttachmentCompletion(directRuntime, 800, names).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const directError = await directErrorPromise;
    expect(directError).toBeInstanceOf(Error);
    expect((directError as Error).message).toContain('"missingAttachmentNames":["09-india.md"]');
    expect((directError as Error).message).toContain('"missingInputNames":["09-india.md"]');
    expect((directError as Error).message).toContain('"sendState":"disabled"');
    expect((directError as Error).message).toContain('"uploading":true');
    expect((directError as Error).message).toContain('"fileCount":8');

    const bundleRuntime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["attachments-bundle.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const bundleReady = waitForAttachmentCompletion(bundleRuntime, 10_000, [
      "attachments-bundle.txt",
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(bundleReady).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion resolves when ready file input contains expected name (no UI chip)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion does not resolve input-only match while upload is still flagged", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: true,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion resolves when all ready file input names match", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt", "b.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input misses an expected name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["a.txt", "b.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input has an unexpected extra name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt", "unexpected-extra.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 2_000, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion can resolve when send button is missing (input match fallback)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "missing",
            uploading: false,
            filesAttached: true,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when send button stays disabled (upload likely in progress)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "disabled",
            uploading: false,
            filesAttached: true,
            attachedNames: ["oracle-attach-verify.txt"],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when neither UI nor file input matches", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });
});

describe("sent turn attachment verification", () => {
  test("waitForUserTurnAttachments resolves when last user turn includes filename", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\noracle-attach-verify.txt\nDocument",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 1000),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments times out when filename never appears", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments skips when user turn lacks attachment UI", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment UI here)",
            attrs: [],
            hasAttachmentUi: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments resolves when attachment UI count satisfies expected files (no filename text)", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 2,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(
        runtime,
        ["oracle-attach-verify-a.txt", "oracle-attach-verify-b.txt"],
        1000,
      ),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments ignores turns before the expected baseline", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        minTurnIndex: 4,
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments requires prompt evidence when provided", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said: unrelated prompt oracle-attach-verify.txt",
            attrs: [],
            hasAttachmentUi: true,
            promptMatches: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedPrompt: "expected prompt text",
      },
    );
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments ignores mismatched conversations", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            conversationMismatch: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedConversationId: "conv-123",
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });
});
