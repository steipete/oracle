import { describe, expect, test } from "vitest";
import {
  PROJECT_SOURCES_MAX_UPLOAD_BATCH,
  buildProjectSourcesUploadPlan,
  diffAddedProjectSources,
} from "../../src/projectSources/plan.js";

describe("project sources plan helpers", () => {
  test("plans uploads in batches of ten", () => {
    const files = Array.from({ length: 11 }, (_, index) => ({
      path: `/tmp/source-${index + 1}.md`,
      displayPath: `source-${index + 1}.md`,
      sizeBytes: 10,
    }));
    expect(PROJECT_SOURCES_MAX_UPLOAD_BATCH).toBe(10);
    expect(buildProjectSourcesUploadPlan(files).map((entry) => entry.batch)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2,
    ]);
  });

  test("diffs duplicate source names by count instead of set membership", () => {
    expect(
      diffAddedProjectSources(
        [
          { name: "architecture.md", index: 0 },
          { name: "notes.md", index: 1 },
        ],
        [
          { name: "architecture.md", index: 0 },
          { name: "notes.md", index: 1 },
          { name: "architecture.md", index: 2 },
        ],
      ),
    ).toEqual([{ name: "architecture.md", index: 2 }]);
  });
});
