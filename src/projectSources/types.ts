import type { BrowserAutomationConfig, BrowserAttachment } from "../browser/types.js";

export type ProjectSourcesOperation = "list" | "add";

export interface ProjectSourceEntry {
  name: string;
  index: number;
  status?: "ready" | "processing" | "unknown";
}

export interface ProjectSourceUploadPlan {
  path: string;
  displayPath: string;
  name: string;
  sizeBytes?: number;
  batch: number;
}

export interface ProjectSourcesRequest {
  operation: ProjectSourcesOperation;
  chatgptUrl: string;
  files?: BrowserAttachment[];
  dryRun?: boolean;
  config?: BrowserAutomationConfig;
  log?: (message: string) => void;
}

export interface ProjectSourcesResult {
  status: "ok" | "dry-run";
  operation: ProjectSourcesOperation;
  projectUrl: string;
  dryRun: boolean;
  sourcesBefore?: ProjectSourceEntry[];
  sourcesAfter?: ProjectSourceEntry[];
  plannedUploads?: ProjectSourceUploadPlan[];
  added?: ProjectSourceEntry[];
  warnings: string[];
  tookMs: number;
}
