import path from "node:path";
import type { BrowserAttachment } from "../browser/types.js";
import type { ProjectSourceEntry, ProjectSourceUploadPlan } from "./types.js";

export const PROJECT_SOURCES_MAX_UPLOAD_BATCH = 10;

export function buildProjectSourcesUploadPlan(
  files: BrowserAttachment[],
): ProjectSourceUploadPlan[] {
  return files.map((file, index) => ({
    path: file.path,
    displayPath: file.displayPath,
    name: path.basename(file.path),
    sizeBytes: file.sizeBytes,
    batch: Math.floor(index / PROJECT_SOURCES_MAX_UPLOAD_BATCH) + 1,
  }));
}

export function diffAddedProjectSources(
  before: ProjectSourceEntry[],
  after: ProjectSourceEntry[],
): ProjectSourceEntry[] {
  const remainingBefore = new Map<string, number>();
  for (const source of before) {
    remainingBefore.set(source.name, (remainingBefore.get(source.name) ?? 0) + 1);
  }
  const added: ProjectSourceEntry[] = [];
  for (const source of after) {
    const count = remainingBefore.get(source.name) ?? 0;
    if (count > 0) {
      remainingBefore.set(source.name, count - 1);
      continue;
    }
    added.push(source);
  }
  return added;
}
