import { describe, expect, test } from "vitest";
import { formatSessionTableRow } from "../../src/cli/sessionTable.js";

describe("formatSessionTableRow", () => {
  test("shows a verified browser label instead of the requested model key", () => {
    const row = formatSessionTableRow(
      {
        id: "browser-session",
        createdAt: "2026-07-12T00:00:00.000Z",
        status: "completed",
        mode: "browser",
        model: "gpt-5.6",
        options: {},
        browser: {
          modelSelection: {
            requestedModel: "GPT-5.6 Sol",
            resolvedLabel: "GPT-5.6 Sol",
            strategy: "select",
            status: "already-selected",
            verified: true,
            source: "chatgpt-model-picker",
            capturedAt: "2026-07-12T00:00:00.000Z",
          },
        },
      },
      { rich: false },
    );

    expect(row).toContain("GPT-5.6 Sol");
    expect(row).not.toContain("gpt-5.6 ");
  });
});
