import { describe, expect, test } from "vitest";
import { normalizeProjectSourcesUrl } from "../../src/projectSources/url.js";

describe("normalizeProjectSourcesUrl", () => {
  test("forces ChatGPT project URLs to the Sources tab", () => {
    expect(normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-123/project")).toBe(
      "https://chatgpt.com/g/g-p-123/project?tab=sources",
    );
    expect(
      normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-123/project?tab=chats&foo=bar"),
    ).toBe("https://chatgpt.com/g/g-p-123/project?tab=sources&foo=bar");
  });

  test("rejects non-project URLs", () => {
    expect(() => normalizeProjectSourcesUrl("https://chatgpt.com/c/abc")).toThrow(/project URL/i);
    expect(() => normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-123/project/foo")).toThrow(
      /ending in \/project/i,
    );
    expect(() => normalizeProjectSourcesUrl("https://example.com/g/g-p-123/project")).toThrow(
      /ChatGPT URL/i,
    );
  });
});
