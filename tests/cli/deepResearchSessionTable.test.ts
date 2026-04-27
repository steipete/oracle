import { describe, expect, test } from "vitest";
import { formatSessionTableRow } from "../../src/cli/sessionTable.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function makeSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "test-session",
    createdAt: new Date().toISOString(),
    status: "completed",
    mode: "browser",
    model: "gpt-5.2-pro",
    ...overrides,
  } as SessionMetadata;
}

describe("formatSessionTableRow — Deep Research label", () => {
  test("shows browser/dr for Deep Research sessions", () => {
    const meta = makeSession({
      browser: { config: { deepResearch: true } },
    });
    const row = formatSessionTableRow(meta, { rich: false });
    expect(row).toContain("browser/dr");
  });

  test("shows regular browser for non-Deep Research sessions", () => {
    const meta = makeSession({
      browser: { config: { deepResearch: false } },
    });
    const row = formatSessionTableRow(meta, { rich: false });
    expect(row).toContain("browser");
    expect(row).not.toContain("browser/dr");
  });

  test("shows regular browser when browser config is absent", () => {
    const meta = makeSession();
    const row = formatSessionTableRow(meta, { rich: false });
    expect(row).toContain("browser");
    expect(row).not.toContain("browser/dr");
  });
});
