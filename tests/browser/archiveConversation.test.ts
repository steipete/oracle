import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  buildArchiveConversationExpressionForTest,
  buildTrustedArchiveConfirmationPointExpressionForTest,
  buildTrustedArchiveMenuPointExpressionForTest,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";

describe("browser conversation archive policy", () => {
  test("archives successful non-project one-shots in auto mode", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "off",
        followUpCount: 0,
      }),
    ).toMatchObject({
      mode: "auto",
      shouldArchive: true,
      reason: "successful-one-shot",
    });
  });

  test("does not auto-archive project, Temporary Chat, Deep Research, multi-turn, or missing-url runs", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "temporary-chat" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "deep-research" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 1,
      }),
    ).toMatchObject({ shouldArchive: false, reason: "multi-turn" });
    expect(resolveBrowserArchiveDecision({ mode: "auto" })).toMatchObject({
      shouldArchive: false,
      reason: "missing-conversation-url",
    });
  });

  test("honors explicit always and never modes", () => {
    expect(resolveBrowserArchiveDecision({ mode: "never", conversationUrl: "x" })).toMatchObject({
      shouldArchive: false,
      reason: "disabled",
    });
    expect(
      resolveBrowserArchiveDecision({
        mode: "always",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
        followUpCount: 2,
      }),
    ).toMatchObject({ shouldArchive: true, reason: "forced" });
  });

  test("detects ChatGPT project URLs", () => {
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project?model=gpt-5")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("archiveChatGptConversation", () => {
  test("selects only a visible Archive confirmation button inside a dialog", () => {
    class FakeElement {
      constructor(
        readonly innerText: string,
        readonly visible = true,
      ) {}
      getAttribute() {
        return null;
      }
      getBoundingClientRect() {
        return { left: 20, top: 30, width: this.visible ? 40 : 0, height: 20 };
      }
    }
    const candidates = [
      new FakeElement("Unarchive"),
      new FakeElement("Archive", false),
      new FakeElement("Archive"),
    ];
    const expression = buildTrustedArchiveConfirmationPointExpressionForTest();
    const point = Function(
      "document",
      "HTMLElement",
      "getComputedStyle",
      `return ${expression};`,
    )({ querySelectorAll: () => candidates }, FakeElement, () => ({
      display: "block",
      visibility: "visible",
    }));
    expect(point).toEqual({ x: 40, y: 40 });
  });

  test("never chooses another chat menu when the current row has no actions button", () => {
    class FakeElement {
      getBoundingClientRect() {
        return { left: 40, top: 20, width: 20, height: 20 };
      }
      scrollIntoView() {}
    }
    const otherChatButton = new FakeElement();
    const row = {
      querySelectorAll: () => [currentLink],
      querySelector: () => null,
    };
    const currentLink = {
      getAttribute: () => "/c/current",
      closest: () => row,
    };
    const document = {
      querySelectorAll: (selector: string) =>
        selector === "a[href]" ? [currentLink] : [otherChatButton],
    };
    const expression = buildTrustedArchiveMenuPointExpressionForTest(
      "https://chatgpt.com/c/current",
    );
    const point = Function(
      "document",
      "location",
      "HTMLElement",
      "URL",
      `return ${expression};`,
    )(document, { href: "https://chatgpt.com/c/current" }, FakeElement, URL);
    expect(point).toBeNull();
  });

  test("returns archived result when the DOM action succeeds", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "archived", conversationUrl: "https://chatgpt.com/c/abc" } },
      }),
    };
    const logger = vi.fn();

    await expect(
      archiveChatGptConversation(runtime as never, logger as never, {
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "auto",
      attempted: true,
      archived: true,
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );
  });

  test("returns a non-archived result when the DOM action is not confirmed", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "archive-not-confirmed",
            conversationUrl: "https://chatgpt.com/c/abc",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: true,
      archived: false,
      reason: "archive-not-confirmed",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
  });

  test("does not claim an archive from a successful PATCH without exact detail readback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes('button[aria-label="Chat actions"]')) {
            return { result: { value: { x: 50, y: 50 } } };
          }
          if (expression.includes("const roots = Array.from")) {
            return { result: { value: { x: 60, y: 60 } } };
          }
          if (expression.includes("return { sidebarLinkPresent, saved: resources.some")) {
            return { result: { value: { sidebarLinkPresent: false, saved: true } } };
          }
          return { result: { value: 0 } };
        }),
      };
      const page = { bringToFront: vi.fn(), navigate: vi.fn(), reload: vi.fn() };
      const input = { dispatchMouseEvent: vi.fn(async () => {}) };
      const result = archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
        input: input as never,
        page: page as never,
      });
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({
        archived: false,
        reason: "archive-readback-pending",
      });
      expect(page.navigate).toHaveBeenCalledWith({ url: "https://chatgpt.com/" });
      expect(page.reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    [true, true, "GET", true, undefined, false],
    [true, true, "GET", true, undefined, true],
    [false, false, "GET", false, "archive-readback-detail-not-archived", false],
    [true, true, "PATCH", false, "archive-readback-pending", false],
  ] as const)(
    "uses the authenticated detail readback when sidebar present=%s and archive state=%s via %s (dialog=%s)",
    async (
      sidebarPresent,
      detailArchived,
      requestMethod,
      expectedArchived,
      expectedReason,
      confirmation,
    ) => {
      vi.useFakeTimers();
      try {
        let onRequest:
          | ((event: { requestId: string; request: { url: string; method: string } }) => void)
          | undefined;
        let onResponse:
          | ((event: { requestId: string; response: { url: string; status: number } }) => void)
          | undefined;
        let onFinished: ((event: { requestId: string }) => void) | undefined;
        const runtime = {
          evaluate: vi.fn(async ({ expression }: { expression: string }) => {
            if (expression.includes('button[aria-label="Chat actions"]')) {
              return { result: { value: { x: 50, y: 50 } } };
            }
            if (expression.includes("const roots = Array.from")) {
              return { result: { value: { x: 60, y: 60 } } };
            }
            if (expression.includes('[role="dialog"] button')) {
              return { result: { value: confirmation ? { x: 70, y: 70 } : null } };
            }
            if (expression.includes("return { sidebarLinkPresent, saved: resources.some")) {
              return { result: { value: { sidebarLinkPresent: sidebarPresent, saved: true } } };
            }
            if (expression.includes("performance.getEntriesByType('resource').filter")) {
              return { result: { value: 0 } };
            }
            return {
              result: { value: { recentCount: 5, currentPresent: sidebarPresent, onHome: true } },
            };
          }),
        };
        const input = { dispatchMouseEvent: vi.fn(async (_event: { type: string }) => {}) };
        const page = {
          bringToFront: vi.fn(),
          reload: vi.fn(async () => {}),
          navigate: vi.fn(async ({ url }: { url: string }) => {
            if (!url.endsWith("/c/abc")) return;
            onRequest?.({
              requestId: "detail-1",
              request: {
                url: "https://chatgpt.com/backend-api/conversations/abc",
                method: requestMethod,
              },
            });
            onResponse?.({
              requestId: "detail-1",
              response: { url: "https://chatgpt.com/backend-api/conversations/abc", status: 200 },
            });
            onFinished?.({ requestId: "detail-1" });
          }),
        };
        const client = {
          Network: {
            enable: vi.fn(async () => {}),
            requestWillBeSent: vi.fn((listener: typeof onRequest) => {
              onRequest = listener;
              return () => {};
            }),
            responseReceived: vi.fn((listener: typeof onResponse) => {
              onResponse = listener;
              return () => {};
            }),
            loadingFinished: vi.fn((listener: typeof onFinished) => {
              onFinished = listener;
              return () => {};
            }),
            getResponseBody: vi.fn(async () => ({
              body: JSON.stringify({ is_archived: detailArchived }),
              base64Encoded: false,
            })),
          },
        };
        const result = archiveChatGptConversation(runtime as never, vi.fn() as never, {
          mode: "always",
          conversationUrl: "https://chatgpt.com/c/abc",
          input: input as never,
          page: page as never,
          client: client as never,
        });
        await vi.runAllTimersAsync();
        await expect(result).resolves.toMatchObject(
          expectedReason
            ? { archived: expectedArchived, reason: expectedReason }
            : { archived: expectedArchived },
        );
        if (requestMethod === "GET") {
          expect(client.Network.getResponseBody).toHaveBeenCalledWith({ requestId: "detail-1" });
        } else {
          expect(client.Network.getResponseBody).not.toHaveBeenCalled();
        }
        expect(
          input.dispatchMouseEvent.mock.calls.filter(([event]) => event.type === "mouseReleased"),
        ).toHaveLength(confirmation ? 3 : 2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("keeps the archive expression scoped to Archive actions", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("findConversationMenuButton");
    expect(expression).toContain("visibleMenuCandidates");
    expect(expression).toContain("findArchiveMenuItem");
    expect(expression).toContain("findArchiveConfirmationButton");
    expect(expression).toContain("hasUnarchiveMenuItem");
    expect(expression).toContain("PointerEvent");
    expect(expression).toContain("waitForArchiveConfirmation");
    expect(expression).toContain("archive-not-confirmed");
    expect(expression).toContain("archive");
    expect(expression).not.toContain("delete");
  });

  test("recognizes Japanese ChatGPT archive controls", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("その他");
    expect(expression).toContain("会話オプション");
    expect(expression).toContain("アーカイブ");
    expect(expression).toContain("アーカイブを解除");
    expect(expression).toContain("アーカイブしました");
  });
});

// Every locale label this matcher relies on, one line per literal, checked against the
// SPECIFIC matcher function that consumes it (not the whole serialized expression) — a
// global `expression.toContain(label)` would still pass if a label were deleted from one
// matcher while an identical label happened to survive in a sibling matcher, since several
// of these labels (e.g. "archive", "アーカイブ") are deliberately repeated across matchers.
// Labels are matched as quoted literals (`'label'`), not bare substrings: "アーカイブ" is
// itself a substring of "アーカイブする", so a bare check would stay green even after the
// standalone "アーカイブ" literal is deleted, as long as "アーカイブする" still exists.
// A future PR that silently drops or renames a label now fails here instead of only
// showing up as a live-account regression report — see docs/browser-mode.md's "self check"
// ask and the localized-controls history in #407/#405.
describe("archive expression locale label inventory", () => {
  const expression = buildArchiveConversationExpressionForTest();
  const quoted = (label: string) => `'${label}'`;

  // Slice out one matcher function's own source, bounded by the next function's start,
  // so an assertion against the slice can only be satisfied by that matcher's own labels.
  const matcherSlice = (startMarker: string, endMarker: string): string => {
    const start = expression.indexOf(startMarker);
    if (start === -1) {
      throw new Error(`matcher start marker not found in expression: ${startMarker}`);
    }
    const end = expression.indexOf(endMarker, start + startMarker.length);
    if (end === -1) {
      throw new Error(`matcher end marker not found in expression: ${endMarker}`);
    }
    return expression.slice(start, end);
  };

  const menuButtonSlice = matcherSlice("findConversationMenuButton", "visibleMenuCandidates");
  const archiveItemSlice = matcherSlice("findArchiveMenuItem", "findArchiveConfirmationButton");
  const confirmButtonSlice = matcherSlice("findArchiveConfirmationButton", "hasUnarchiveMenuItem");
  const unarchiveMenuSlice = matcherSlice("hasUnarchiveMenuItem", "hasArchiveConfirmation");
  const confirmationToastSlice = matcherSlice(
    "hasArchiveConfirmation",
    "waitForArchiveConfirmation",
  );

  test("conversation menu ('more options') labels are present", () => {
    for (const label of [
      "more",
      "conversation options",
      "open menu",
      "więcej",
      "opcje",
      "その他",
      "会話オプション",
    ]) {
      expect(menuButtonSlice).toContain(quoted(label));
    }
  });

  test("archive menu-item labels are present", () => {
    for (const label of ["archive", "archiwizuj", "アーカイブ", "アーカイブする"]) {
      expect(archiveItemSlice).toContain(quoted(label));
    }
  });

  test("archive confirmation-button labels are present", () => {
    for (const label of [
      "archive",
      "archiwizuj",
      "アーカイブ",
      "アーカイブする",
      "archive conversation",
    ]) {
      expect(confirmButtonSlice).toContain(quoted(label));
    }
  });

  test("unarchive/restore exclusion labels are present in every matcher that excludes them", () => {
    for (const label of ["unarchive", "restore", "アーカイブを解除"]) {
      expect(archiveItemSlice).toContain(quoted(label));
      expect(confirmButtonSlice).toContain(quoted(label));
      expect(unarchiveMenuSlice).toContain(quoted(label));
    }
    // Polish restore/unarchive words only appear in the standalone unarchive-detection matcher.
    for (const label of ["przywróć", "przywroc"]) {
      expect(unarchiveMenuSlice).toContain(quoted(label));
    }
  });

  test("post-archive confirmation toast labels are present", () => {
    for (const label of [
      "archived",
      "conversation archived",
      "chat archived",
      "zarchiwizowano",
      "archiwum",
      "アーカイブしました",
      "アーカイブされました",
    ]) {
      expect(confirmationToastSlice).toContain(quoted(label));
    }
  });
});
