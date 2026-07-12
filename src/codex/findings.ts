import type { CodexFinding, CodexFindingSeverity, CodexFindingsPageCounter } from "./types.js";

const SEVERITIES: CodexFindingSeverity[] = ["critical", "high", "medium", "low"];
const COUNTER_RE = /(\d[\d,]*)\s*[-–—]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/u;

export function parseSeverity(label: unknown): CodexFindingSeverity {
  const lower = String(label ?? "")
    .trim()
    .toLowerCase();
  return (
    SEVERITIES.find((s) => lower === s || lower.startsWith(s) || lower.includes(s)) ?? "unknown"
  );
}

export function parseFindingsCounter(
  text: string | null | undefined,
): CodexFindingsPageCounter | null {
  if (!text) {
    return null;
  }
  const match = COUNTER_RE.exec(text);
  if (!match) {
    return null;
  }
  const num = (raw: string) => Number.parseInt(raw.replace(/,/gu, ""), 10);
  return { from: num(match[1]), to: num(match[2]), total: num(match[3]) };
}

// Raw list item captured from the page DOM.
export interface RawFindingItem {
  innerText: string; // `{title}\n{repo}\n·\nCommitted Nd ago`
  severityLabel: string | null; // e.g. "High severity" (from the item's severity icon)
}

export function parseFindingItem(raw: RawFindingItem, index: number): CodexFinding {
  const lines = raw.innerText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "·");
  const title = lines[0] ?? "(untitled finding)";
  // Finding titles can contain path-like text (for example `/work`). Only treat a
  // standalone owner/name line as repository metadata.
  const repo = lines.find((line) => /^[^/\s]+\/[^/\s]+$/u.test(line));
  const status = lines.find((line) => /^committed/iu.test(line));
  const severity = parseSeverity(raw.severityLabel ?? "");
  const id = `${title}|${repo ?? ""}`;
  return { id, title, severity, repo, status, index };
}

// Dedupe by id across pages (page boundaries can overlap) and re-index sequentially.
export function aggregateFindingPages(pages: CodexFinding[][]): CodexFinding[] {
  const byId = new Map<string, CodexFinding>();
  for (const page of pages) {
    for (const finding of page) {
      if (!byId.has(finding.id)) {
        byId.set(finding.id, finding);
      }
    }
  }
  return Array.from(byId.values()).map((finding, index) => ({ ...finding, index }));
}

// Stop paging when the counter is unparseable (loud/safe) or the last visible row is the total.
export function shouldStopPaging(
  counter: CodexFindingsPageCounter | undefined,
  pagesVisited: number,
): boolean {
  if (!counter) {
    return true;
  }
  return pagesVisited >= 1 && counter.to >= counter.total;
}

export function evidencePath(url: string): string | null {
  const match = /\/blob\/[a-f0-9]{7,64}\/(.+?)(?:#|$)/iu.exec(url);
  return match?.[1] ?? null;
}

function matchesEvidencePrefix(path: string, prefix: string): boolean {
  const normalized = prefix.trim().replace(/^\/+|\/+$/gu, "");
  if (!normalized) return false;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function isEvidencePathAllowed(
  url: string,
  {
    includePrefixes = [],
    excludePrefixes = [],
  }: { includePrefixes?: string[]; excludePrefixes?: string[] } = {},
): boolean {
  const path = evidencePath(url);
  if (!path) return false;
  if (excludePrefixes.some((prefix) => matchesEvidencePrefix(path, prefix))) return false;
  return (
    includePrefixes.length === 0 ||
    includePrefixes.some((prefix) => matchesEvidencePrefix(path, prefix))
  );
}

export function githubRepoFromUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:commit|blob)\//u.exec(url);
  return match?.[1] ?? null;
}
