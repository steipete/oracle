import { describe, expect, test } from "vitest";
import {
  normalizeProjectSourcesUrl,
  resolveProjectSourceDeleteNames,
  PROJECT_SOURCES_MAX_UPLOAD_BATCH,
} from "../../src/browser/actions/projectSources.js";

describe("project sources helpers", () => {
  test("forces the sources tab in project URLs", () => {
    expect(
      normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-123/project"),
    ).toBe("https://chatgpt.com/g/g-p-123/project?tab=sources");
    expect(
      normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-123/project?tab=chats"),
    ).toBe("https://chatgpt.com/g/g-p-123/project?tab=sources");
  });

  test("replace defaults deletions to incoming file basenames", () => {
    expect(
      resolveProjectSourceDeleteNames({
        operation: "replace",
        attachments: [
          { path: "/tmp/a.txt", displayPath: "a.txt" },
          { path: "/tmp/b.txt", displayPath: "b.txt" },
        ],
        beforeNames: ["a.txt", "legacy.txt"],
      }),
    ).toEqual(["a.txt", "b.txt"]);
  });

  test("sync deletes all current sources", () => {
    expect(
      resolveProjectSourceDeleteNames({
        operation: "sync",
        attachments: [{ path: "/tmp/a.txt", displayPath: "a.txt" }],
        beforeNames: ["legacy.txt", "a.txt"],
      }),
    ).toEqual(["legacy.txt", "a.txt"]);
  });

  test("keeps project source uploads capped per batch", () => {
    expect(PROJECT_SOURCES_MAX_UPLOAD_BATCH).toBe(10);
  });
});
