import { describe, expect, it } from "vitest";
import {
  aggregateFindingPages,
  githubRepoFromUrl,
  isModalRuntimeEvidence,
  parseFindingItem,
  parseFindingsCounter,
  parseSeverity,
  shouldStopPaging,
} from "../../src/codex/findings.js";
import {
  buildFindingDetailUrl,
  buildFindingsDataUrl,
  normalizeCodexFindingsUrl,
} from "../../src/codex/url.js";
import { CODEX_FINDINGS_URL } from "../../src/browser/constants.js";

const ID_A = "ec67666608e481919bfa195fe60fa36e";

describe("parseSeverity", () => {
  it("normalizes severity labels (incl. 'High severity')", () => {
    expect(parseSeverity("High severity")).toBe("high");
    expect(parseSeverity("CRITICAL")).toBe("critical");
    expect(parseSeverity("Medium")).toBe("medium");
  });
  it("falls back to unknown", () => {
    expect(parseSeverity("n/a")).toBe("unknown");
    expect(parseSeverity(undefined)).toBe("unknown");
  });
});

describe("parseFindingsCounter", () => {
  it("parses 'N-M of T' with commas and en-dash", () => {
    expect(parseFindingsCounter("1-20 of 120")).toEqual({ from: 1, to: 20, total: 120 });
    expect(parseFindingsCounter("21-40 of 120")).toEqual({ from: 21, to: 40, total: 120 });
    expect(parseFindingsCounter("1–20 of 1,137")).toEqual({ from: 1, to: 20, total: 1137 });
  });
  it("returns null for garbage/empty", () => {
    expect(parseFindingsCounter("garbage")).toBeNull();
    expect(parseFindingsCounter(null)).toBeNull();
  });
});

describe("parseFindingItem", () => {
  it("splits the row innerText and reads severity from the icon label", () => {
    const finding = parseFindingItem(
      {
        innerText: "Background bash can leak host files\numgbhalla/harp\n·\nCommitted 1d ago",
        severityLabel: "High severity",
      },
      0,
    );
    expect(finding).toMatchObject({
      title: "Background bash can leak host files",
      repo: "umgbhalla/harp",
      status: "Committed 1d ago",
      severity: "high",
      index: 0,
    });
    expect(finding.id).toBe("Background bash can leak host files|umgbhalla/harp");
  });
  it("defaults severity to unknown when no icon label", () => {
    const finding = parseFindingItem({ innerText: "Some title\nacme/x", severityLabel: null }, 3);
    expect(finding.severity).toBe("unknown");
    expect(finding.repo).toBe("acme/x");
  });
});

describe("aggregateFindingPages", () => {
  it("dedupes overlapping rows across pages and re-indexes", () => {
    const p1 = [
      parseFindingItem({ innerText: "A\nr/a", severityLabel: "High severity" }, 0),
      parseFindingItem({ innerText: "B\nr/b", severityLabel: "Low severity" }, 1),
    ];
    const p2 = [
      parseFindingItem({ innerText: "B\nr/b", severityLabel: "Low severity" }, 0),
      parseFindingItem({ innerText: "C\nr/c", severityLabel: "Critical severity" }, 1),
    ];
    const merged = aggregateFindingPages([p1, p2]);
    expect(merged.map((f) => f.title)).toEqual(["A", "B", "C"]);
    expect(merged.map((f) => f.index)).toEqual([0, 1, 2]);
  });
});

describe("shouldStopPaging", () => {
  it("stops on unparseable counter or last page", () => {
    expect(shouldStopPaging(undefined, 1)).toBe(true);
    expect(shouldStopPaging({ from: 21, to: 40, total: 40 }, 2)).toBe(true);
  });
  it("continues while more rows remain", () => {
    expect(shouldStopPaging({ from: 1, to: 20, total: 120 }, 1)).toBe(false);
  });
});

describe("normalizeCodexFindingsUrl", () => {
  it("defaults when empty and keeps sev", () => {
    expect(normalizeCodexFindingsUrl("")).toBe(CODEX_FINDINGS_URL);
    expect(normalizeCodexFindingsUrl(`${CODEX_FINDINGS_URL}?sev=high`)).toBe(
      `${CODEX_FINDINGS_URL}?sev=high`,
    );
  });
  it("rejects non-findings path and foreign host", () => {
    expect(() => normalizeCodexFindingsUrl("https://chatgpt.com/c/abc")).toThrow();
    expect(() =>
      normalizeCodexFindingsUrl("https://example.com/codex/cloud/security/findings"),
    ).toThrow();
  });
});

describe("buildFindingDetailUrl / buildFindingsDataUrl", () => {
  it("appends a validated 32-hex id", () => {
    expect(buildFindingDetailUrl(CODEX_FINDINGS_URL, ID_A)).toBe(
      `${CODEX_FINDINGS_URL}/${ID_A}?sev=`,
    );
  });
  it("rejects a non-hex id (blocks traversal/injection)", () => {
    expect(() => buildFindingDetailUrl(CODEX_FINDINGS_URL, "../../evil")).toThrow();
    expect(() => buildFindingDetailUrl(CODEX_FINDINGS_URL, "short")).toThrow();
  });
  it("suffixes .data (kept for parity, unused by list)", () => {
    expect(buildFindingsDataUrl(CODEX_FINDINGS_URL)).toBe(`${CODEX_FINDINGS_URL}.data?sev=`);
  });
});

describe("Modal runtime finding scope", () => {
  it("recognizes Harp Modal evidence and rejects local/frontend surfaces", () => {
    expect(
      isModalRuntimeEvidence(
        "https://github.com/umgbhalla/harp/blob/abcdef1/harp/serve_modal.py#L1-L10",
      ),
    ).toBe(true);
    expect(
      isModalRuntimeEvidence(
        "https://github.com/umgbhalla/harp/blob/abcdef1/harp/sandbox_local.py#L1-L10",
      ),
    ).toBe(false);
    expect(
      isModalRuntimeEvidence(
        "https://github.com/umgbhalla/harp/blob/abcdef1/apps/web/app/page.tsx#L1-L10",
      ),
    ).toBe(false);
  });

  it("extracts the repository from report evidence links", () => {
    expect(githubRepoFromUrl("https://github.com/umgbhalla/harp/commit/abcdef1234567890")).toBe(
      "umgbhalla/harp",
    );
    expect(githubRepoFromUrl("https://example.com/nope")).toBeNull();
  });
});
