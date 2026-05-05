import { describe, expect, test } from "vitest";
import {
  buildMarkProjectSourcesUploadInputExpression,
  buildOpenProjectSourcesTabExpression,
  buildOpenProjectSourcesAddDialogExpression,
  buildProjectSourcesConfirmationButtonExpression,
  buildProjectSourcesListExpression,
  buildProjectSourcesReadyExpression,
  hasUploadedProjectSourceBatchForTest,
} from "../../src/browser/actions/projectSources.js";

describe("Project Sources browser expressions", () => {
  test("recognizes English and Polish Project Sources UI labels", () => {
    const ready = buildProjectSourcesReadyExpression();
    expect(ready).toContain("sources");
    expect(ready).toContain("źródła");
    expect(ready).toContain("dodaj źródła");
  });

  test("targets Sources controls without relying only on one English label", () => {
    const openTab = buildOpenProjectSourcesTabExpression();
    expect(openTab).toContain("sources");
    expect(openTab).toContain("źródła");

    const openDialog = buildOpenProjectSourcesAddDialogExpression();
    expect(openDialog).toContain("add sources");
    expect(openDialog).toContain("dodaj źródła");
    expect(openDialog).toContain('[role="tabpanel"][id*="source" i]');
  });

  test("marks only file inputs scoped through the Sources dialog/panel search", () => {
    const expression = buildMarkProjectSourcesUploadInputExpression(
      "data-oracle-project-sources-input",
    );
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain("data-oracle-project-sources-input");
    expect(expression).toContain("dialog");
    expect(expression).not.toContain("document.body");
  });

  test("keeps source rows distinct while filtering duplicated metadata labels", () => {
    const expression = buildProjectSourcesListExpression();
    expect(expression).toContain("sources.push");
    expect(expression).toContain("hasMetadata");
    expect(expression).toContain("row.top");
  });

  test("supports localized upload confirmation labels", () => {
    const expression = buildProjectSourcesConfirmationButtonExpression();
    expect(expression).toContain("upload anyway");
    expect(expression).toContain("prześlij");
  });

  test("requires all duplicate basenames in an upload batch to appear", () => {
    const before = [{ name: "context.md", index: 0 }];
    expect(
      hasUploadedProjectSourceBatchForTest(
        before,
        [
          { name: "context.md", index: 0 },
          { name: "context.md", index: 1 },
        ],
        ["context.md", "context.md"],
      ),
    ).toBe(false);
    expect(
      hasUploadedProjectSourceBatchForTest(
        before,
        [
          { name: "context.md", index: 0 },
          { name: "context.md", index: 1 },
          { name: "context.md", index: 2 },
        ],
        ["context.md", "context.md"],
      ),
    ).toBe(true);
  });
});
