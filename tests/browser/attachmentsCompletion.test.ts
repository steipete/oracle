import { describe, expect, test, vi } from "vitest";
import {
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../../src/browser/pageActions.js";
import { buildAttachmentNamePattern } from "../../src/browser/actions/attachments.js";
import type { ChromeClient } from "../../src/browser/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe("collision-renamed attachment names", () => {
  test.each([
    ["01.jpg", "01(5).jpg"],
    ["document.md", "document(20260818-145702).md"],
    ["document.md", "document.md"],
    ["a+b.jpg", "a+b(2).jpg"],
    ["01.jpg", "remove file 1: 01.jpg"],
    ["01.jpg", "remove file 2: 01(1).jpg"],
    ["01.jpg", "remove file 2: 01(5).jpg"],
    ["document.md", "remove file 1: document(20260818-145702).md"],
    ["01.jpg", "Remove file 1: 01 (5).jpg"],
    ["가01.jpg", "Remove file 1: 가01(5).jpg"],
    ["é01.jpg", "Remove file 1: é01(5).jpg"],
    ["𐐀01.jpg", "Remove file 1: 𐐀01(5).jpg"],
  ])("matches %s to %s", (expectedName, actualName) => {
    expect(buildAttachmentNamePattern(expectedName)?.test(actualName)).toBe(true);
  });

  test.each([
    ["01.jpg", "010.jpg"],
    ["01.jpg", "02(5).jpg"],
    ["01.jpg", "remove file 1: 001.jpg"],
    ["01.jpg", "remove file 1: x01.jpg"],
    ["01.jpg", "remove file 1: 01.jpeg"],
    ["01.jpg", "remove file 1: photo01.jpg"],
    ["attachments-bundle.txt", "not-attachments-bundle.txt"],
    ["report.pdf", "remove file 1: my_report.pdf"],
    ["report.pdf", "remove file 1: report.pdf.bak"],
    ["01.jpg", "remove file 1: 가01(5).jpg"],
    ["01.jpg", "remove file 1: é01(5).jpg"],
    ["01.jpg", "remove file 1: 01(5).jpgé"],
    ["01.jpg", "remove file 1: \u030101(5).jpg"],
    ["01.jpg", "remove file 1: 𐐀01(5).jpg"],
    ["01.jpg", "remove file 1: ١01(5).jpg"],
    ["README.md", "remove file 1: 가README(5).md"],
    ["README.md", "remove file 1: README(5).mdé"],
    ["README.md", "remove file 1: README (5).pdf"],
    ["README.md", "remove file 1: README(abc).md"],
  ])("does not match %s to %s", (expectedName, actualName) => {
    expect(buildAttachmentNamePattern(expectedName)?.test(actualName)).toBe(false);
    expect(buildAttachmentNamePattern(expectedName, true)?.test(actualName)).toBe(false);
  });

  test("waitForAttachmentCompletion resolves for a collision-renamed short filename", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: true,
            attachedNames: ["01(5).jpg"],
            inputNames: [],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    try {
      const promise = waitForAttachmentCompletion(runtime, 3_000, ["01.jpg"]);
      const resolved = promise.then(
        () => true,
        () => false,
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await resolved).toBe(true);
    } finally {
      useRealTime();
    }
  });

  test.each([
    ["01.jpg", "가01(5).jpg"],
    ["01.jpg", "é01(5).jpg"],
    ["01.jpg", "01(5).jpgé"],
    ["01.jpg", "가01.jpg"],
    ["README.md", "가README(5).md"],
    ["README.md", "README(5).mdé"],
    ["README.md", "README(5).pdf"],
  ])("completion rejects %s when the chip names %s", async (expected, actual) => {
    useFakeTime();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: true,
            attachedNames: [`Remove file 1: ${actual}`],
            inputNames: [],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    try {
      const assertion = expect(
        waitForAttachmentCompletion(runtime, 3_000, [expected]),
      ).rejects.toThrow(/did not finish uploading/i);
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("sent-turn name verification recognizes a short collision suffix without a count fallback", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "01(5).jpg",
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 0,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForUserTurnAttachments(runtime, ["01.jpg"], 500)).resolves.toBe(true);
  });
});

describe("attachment completion fallbacks", () => {
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

    const promise = waitForAttachmentCompletion(runtime, 5_000, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(6_000);
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

  test("waitForAttachmentCompletion does not let one extension satisfy a same-stem file", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: true,
            attachedNames: ["report.md"],
            inputNames: [],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 2_000, ["report.md", "report.jpg"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(3_000);
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

  test("waitForAttachmentCompletion rejects a count-only label without exact attachment evidence", async () => {
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
            fileCount: 3,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-feature.txt"]);
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
