import { describe, expect, test } from "vitest";
import {
  buildInstallCompletionAnnouncementExpression,
  buildReadCompletionAnnouncementExpression,
} from "../../src/browser/actions/completionAnnouncement.js";

function makePage(initialComplete: boolean, announcement = "Response complete") {
  const status = { textContent: announcement };
  const user = {
    getAttribute: (name: string) =>
      name === "data-content-search-unit-key" ? "fallback-turn-0:0:user" : null,
  };
  const assistant = {
    getAttribute: (name: string) =>
      name === "data-content-search-unit-key" ? "fallback-turn-0:1:assistant" : null,
  };
  let statuses = initialComplete ? [status] : [];
  const turns: Array<{ getAttribute: (name: string) => string | null }> = [user];
  let onMutation = () => {};
  const window = {};
  const document = {
    body: {},
    querySelectorAll: (selector: string) =>
      selector.startsWith('[role="status"]') ? statuses : turns,
  };
  class MutationObserver {
    constructor(callback: () => void) {
      onMutation = callback;
    }
    observe() {}
    disconnect() {}
  }
  Function(
    "window",
    "document",
    "MutationObserver",
    `return ${buildInstallCompletionAnnouncementExpression(1)};`,
  )(window, document, MutationObserver);
  const completed = (index: number) =>
    Function("window", `return ${buildReadCompletionAnnouncementExpression(index)};`)(window);
  return {
    addAssistant: () => turns.push(assistant),
    setComplete: (complete: boolean) => {
      statuses = complete ? [status] : [];
      onMutation();
    },
    notify: () => onMutation(),
    completed,
  };
}

describe("current-turn completion announcement", () => {
  test("ignores an earlier completed status while a new answer is incomplete", () => {
    const page = makePage(true);
    page.addAssistant();
    page.notify();
    expect(page.completed(1)).toBe(false);
    page.setComplete(false);
    page.setComplete(true);
    expect(page.completed(1)).toBe(true);
    expect(page.completed(0)).toBe(false);
  });

  // ja-JP announces 回答が完了しました (observed 2026-10-03 on the Chat/Work layout).
  test.each(["Response complete", "回答が完了しました"])(
    "records a fast answer that completes before polling begins (%s)",
    (announcement) => {
      const page = makePage(false, announcement);
      page.addAssistant();
      page.setComplete(true);
      expect(page.completed(1)).toBe(true);
    },
  );

  test("does not treat an unrelated polite status as completion", () => {
    const page = makePage(false, "チャットを読み込み中");
    page.addAssistant();
    page.setComplete(true);
    expect(page.completed(1)).toBe(false);
  });
});
