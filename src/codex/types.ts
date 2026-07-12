import type { BrowserAutomationConfig } from "../browser/types.js";

export type CodexFindingsOperation = "list" | "detail" | "action";
export type CodexFindingAction =
  | "create-pr"
  | "chat"
  | "close"
  | "adjust"
  | "copy-content"
  | "copy-link"
  | "copy-patch"
  | "copy-git-apply";
export type CodexFindingSeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type CodexFindingDetailSectionId = "summary" | "validation" | "evidence" | "attack-path";

export interface CodexFinding {
  id: string; // = selectionId when present, else `${title}|${repo ?? ""}`
  selectionId?: string; // 32-char hex from the loader payload; feeds --finding + detail URL
  title: string;
  severity: CodexFindingSeverity;
  repo?: string; // parsed from payload, NEVER hardcoded
  status?: string;
  detailHref?: string;
  index: number; // 0-based position after client-side severity filter + limit
}

export interface CodexFindingsPageCounter {
  from: number;
  to: number;
  total: number;
}

export interface CodexFindingDetailSection {
  id: CodexFindingDetailSectionId;
  heading: string;
  text: string; // normalized innerText of the section (read-only)
}

export interface CodexFindingDetail {
  finding: CodexFinding; // finding.id/selectionId stamped from request.findingId
  title: string; // main h1/h2 text
  repo: string | null; // github commit permalink, parsed (never hardcoded)
  sections: CodexFindingDetailSection[];
  files: string[]; // github /blob/ evidence permalinks, deduped
  validationArtifact: string | null; // signed oaiusercontent SAS link (captured, NEVER fetched)
}

export interface CodexFindingsRequest {
  operation: CodexFindingsOperation;
  chatgptUrl: string; // already normalized by caller; runner re-normalizes
  findingId?: string; // 32-hex; required when operation === "detail"
  action?: CodexFindingAction;
  actionText?: string;
  confirm?: boolean;
  severity?: CodexFindingSeverity | string; // optional client-side filter
  repo?: string;
  evidencePrefixes?: string[];
  evidenceExcludes?: string[];
  limit?: number; // max findings returned (client cap); default = all
  config?: BrowserAutomationConfig;
  log?: (message: string) => void;
}

export interface CodexFindingsResult {
  status: "ok";
  operation: CodexFindingsOperation;
  findingsUrl: string; // detail mode: the resolved detail URL
  findings?: CodexFinding[]; // list mode: mapped from loader, filtered + capped
  counter?: CodexFindingsPageCounter; // {from, to: findings.length, total: loader total}
  detail?: CodexFindingDetail; // detail mode
  action?: CodexFindingAction;
  actionResult?: { status: string; message?: string; url?: string; text?: string };
  warnings: string[];
  tookMs: number;
}
