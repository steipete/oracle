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
  const repo = lines.find((line) => /\//u.test(line) && !/^committed/iu.test(line));
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

const MODAL_RUNTIME_ROOTS = ["harp/", "deploy.sh", "pyproject.toml"] as const;
const NON_MODAL_PATHS = new Set(["harp/sandbox_local.py", "harp/serve_local.py"]);

export function modalEvidencePath(url: string): string | null {
  const match = /\/blob\/[a-f0-9]{7,64}\/(.+?)(?:#|$)/iu.exec(url);
  return match?.[1] ?? null;
}

export function isModalRuntimeEvidence(url: string): boolean {
  const path = modalEvidencePath(url);
  if (!path || NON_MODAL_PATHS.has(path) || path.startsWith("harp/evals/")) return false;
  if (path.startsWith("tests/") || path.startsWith("tests_harp/")) return false;
  return MODAL_RUNTIME_ROOTS.some((root) => path === root || path.startsWith(root));
}

export function githubRepoFromUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:commit|blob)\//u.exec(url);
  return match?.[1] ?? null;
}
