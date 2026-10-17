import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  buildArchiveConversationExpressionForTest,
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
      expect(confirmationToastSlice).toContain(quoted(label));
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

// The expression sleeps on real timers. This clock advances on each sleep so a
// rejected archive finishes without waiting out the three-second confirmation.
const ARCHIVE_PAGE_HARNESS = `
class HTMLElement {
  constructor(tag, attrs, rect, text, children) {
    this.tag = tag;
    this.attrs = attrs || {};
    this.rect = rect;
    this.ownText = text || "";
    this.children = children || [];
    for (const child of this.children) child.parent = this;
  }
  get textContent() {
    return [this.ownText].concat(this.children.map((child) => child.textContent)).join(" ").trim();
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
  dispatchEvent(event) {
    if (!event || event.type !== "click") return;
    globalThis.clicks.push(this.attrs["data-id"] || this.ownText || this.tag);
    if (this.attrs["data-nav"]) globalThis.location.href = "https://chatgpt.com/";
  }
}
function splitSelectors(selector) {
  return selector.split(",").map((part) => part.trim()).filter(Boolean);
}
function matchesAttr(element, spec) {
  if (!spec.startsWith("[") || !spec.endsWith("]")) return false;
  const body = spec.slice(1, -1);
  const containsAt = body.indexOf("*=");
  if (containsAt !== -1) {
    const name = body.slice(0, containsAt);
    const value = body.slice(containsAt + 2).replace(/^"/, "").replace(/"$/, "");
    return (element.attrs[name] || "").includes(value);
  }
  const equalsAt = body.indexOf("=");
  if (equalsAt !== -1) {
    const name = body.slice(0, equalsAt);
    const value = body.slice(equalsAt + 1).replace(/^"/, "").replace(/"$/, "");
    return (element.attrs[name] || "") === value;
  }
  return Object.prototype.hasOwnProperty.call(element.attrs, body);
}
function matchesSimple(element, spec) {
  if (spec.startsWith("[")) return matchesAttr(element, spec);
  const bracket = spec.indexOf("[");
  const tag = bracket === -1 ? spec : spec.slice(0, bracket);
  if (element.tag !== tag) return false;
  return bracket === -1 ? true : matchesAttr(element, spec.slice(bracket));
}
function matchesSelector(element, selector) {
  return splitSelectors(selector).some((alternative) => {
    const parts = alternative.split(" ").filter(Boolean);
    const last = parts[parts.length - 1];
    if (!matchesSimple(element, last)) return false;
    if (parts.length === 1) return true;
    const ancestor = parts.slice(0, -1).join(" ");
    let parent = element.parent;
    while (parent) {
      if (matchesSelector(parent, ancestor)) return true;
      parent = parent.parent;
    }
    return false;
  });
}
function queryAll(root, selector) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesSelector(child, selector)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}
function box(top, left, width, height) {
  return { top, left, right: left + width, bottom: top + height, width, height };
}
function el(tag, attrs, rect, text, children) {
  return new HTMLElement(tag, attrs, rect, text, children);
}
function buildPage(kind) {
  const header = box(24, 1124, 36, 36);
  const side = box(400, 16, 36, 36);
  const item = box(70, 1000, 160, 28);
  const toast = box(700, 400, 240, 32);
  const menuBox = box(60, 980, 200, 80);
  const archiveItem = (nav) => el("div", nav ? { role: "menuitem", "data-nav": "1" } : { role: "menuitem" }, item, "Archive");
  const menu = (nav) => el("div", { role: "menu" }, menuBox, "", [archiveItem(nav)]);
  const headerMore = () => el("button", { "aria-label": "More" }, header, "More");
  let children = [];
  if (kind === "unarchive-toast") {
    children = [headerMore(), menu(false), el("div", { role: "status" }, toast, "Chat unarchived")];
  } else if (kind === "both-toasts") {
    children = [
      headerMore(),
      menu(false),
      el("div", { role: "status" }, toast, "Chat unarchived"),
      el("div", { role: "status" }, box(740, 400, 240, 32), "Chat archived"),
    ];
  } else if (kind === "page-restore") {
    children = [
      headerMore(),
      el("button", { "data-id": "archive-button" }, box(120, 400, 90, 28), "Archive"),
      el("button", { "data-id": "restore-button" }, box(160, 400, 90, 28), "Restore"),
    ];
  } else if (kind === "sidebar-more") {
    children = [
      el("button", { "aria-label": "More", "data-id": "sidebar-more" }, side, "More"),
      menu(false),
      el("div", { role: "status" }, toast, "Chat archived"),
    ];
  } else if (kind === "header-archived") {
    children = [headerMore(), menu(false), el("div", { role: "status" }, toast, "Chat archived")];
  } else if (kind === "url-change") {
    children = [headerMore(), menu(true)];
  } else {
    throw new Error("unknown archive page " + kind);
  }
  globalThis.clicks = [];
  globalThis.window = { innerWidth: 1200 };
  globalThis.location = { href: "https://chatgpt.com/c/open-chat" };
  globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  globalThis.MouseEvent = class MouseEvent {
    constructor(type) { this.type = type; }
  };
  globalThis.KeyboardEvent = class KeyboardEvent {
    constructor(type) { this.type = type; }
  };
  globalThis.document = el("div", {}, box(0, 0, 1200, 800), "", children);
}
`;

async function runArchivePage(kind: string): Promise<{
  result: { status: string; reason?: string; conversationUrl?: string | null };
  clicks: string[];
}> {
  const expression = buildArchiveConversationExpressionForTest();
  let now = 1_000_000;
  let sleeps = 0;
  const sandbox: {
    clicks?: string[];
    Date: { now: () => number };
    setTimeout: (fn: () => void, ms?: number) => number;
  } = {
    Date: {
      now: () => now,
    },
    setTimeout: (fn, ms) => {
      sleeps += 1;
      if (sleeps > 80) throw new Error("archive expression slept too many times");
      now += typeof ms === "number" ? ms : 0;
      fn();
      return 0;
    },
  };
  const result = (await vm.runInNewContext(
    `${ARCHIVE_PAGE_HARNESS}\nbuildPage(${JSON.stringify(kind)});\n${expression}`,
    sandbox,
  )) as { status: string; reason?: string; conversationUrl?: string | null };
  return { result, clicks: sandbox.clicks ?? [] };
}

describe("archive expression page behavior", () => {
  test("does not treat an unarchive toast as a finished archive", async () => {
    const { result } = await runArchivePage("unarchive-toast");
    expect(result).toMatchObject({ status: "skipped", reason: "archive-not-confirmed" });
  });

  test("keeps a real archived toast when another toast says the chat was unarchived", async () => {
    const { result } = await runArchivePage("both-toasts");
    expect(result).toMatchObject({ status: "archived" });
  });

  test("does not treat a page-wide Restore control as this chat's archive", async () => {
    const { result } = await runArchivePage("page-restore");
    expect(result).toMatchObject({ status: "skipped", reason: "archive-not-confirmed" });
  });

  test("does not archive through a More button outside the header", async () => {
    const { result, clicks } = await runArchivePage("sidebar-more");
    expect(result).toMatchObject({ status: "skipped", reason: "conversation-menu-not-found" });
    expect(clicks).toEqual([]);
  });

  test("accepts a header Archive click when the toast says the chat was archived", async () => {
    const { result } = await runArchivePage("header-archived");
    expect(result).toMatchObject({ status: "archived" });
  });

  test("accepts a conversation URL change as archive confirmation", async () => {
    const { result } = await runArchivePage("url-change");
    expect(result).toMatchObject({ status: "archived" });
  });
});
