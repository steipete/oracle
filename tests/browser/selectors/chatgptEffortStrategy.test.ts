// Unit tests for the ChatGPT highest-visible effort strategy (oracle-hcs).
//
// Acceptance criteria (from the bead):
//
//   - Heavy as an observed top label
//   - changed labels still ranked correctly
//   - missing effort controls return typed unverified errors
//   - UI drift returns ui_drift_suspected

import { describe, expect, test } from "vitest";

import {
  CHATGPT_EFFORT_TIERS,
  SELECTOR_MANIFEST_VERSION,
  availableEffortLabelsHash,
  highestKnownLabel,
  pickHighestVisibleEffort,
  tierForLabel,
} from "../../../src/browser/selectors/chatgpt/index.js";

describe("CHATGPT_EFFORT_TIERS table", () => {
  test("tiers are listed in strictly increasing rank order", () => {
    for (let i = 1; i < CHATGPT_EFFORT_TIERS.length; i++) {
      expect(CHATGPT_EFFORT_TIERS[i].rank).toBeGreaterThan(CHATGPT_EFFORT_TIERS[i - 1].rank);
    }
  });

  test("tier names are unique across the table", () => {
    const names = CHATGPT_EFFORT_TIERS.map((t) => t.tier);
    expect(new Set(names).size).toBe(names.length);
  });

  test("aliases are unique across the entire table (no overlapping label routes)", () => {
    const seen = new Map<string, string>();
    for (const tier of CHATGPT_EFFORT_TIERS) {
      for (const alias of tier.aliases) {
        const norm = alias.trim().replace(/\s+/g, " ").toLowerCase();
        const prior = seen.get(norm);
        expect(prior ?? tier.tier).toBe(tier.tier);
        seen.set(norm, tier.tier);
      }
    }
  });

  test("contains the documented top tiers (pro_extended, heavy, ultra)", () => {
    const names = new Set(CHATGPT_EFFORT_TIERS.map((t) => t.tier));
    expect(names.has("pro_extended")).toBe(true);
    expect(names.has("heavy")).toBe(true);
    expect(names.has("ultra")).toBe(true);
  });
});

describe("tierForLabel", () => {
  test("matches Heavy and Pro Extended verbatim", () => {
    expect(tierForLabel("Heavy")?.tier).toBe("heavy");
    expect(tierForLabel("Pro Extended")?.tier).toBe("pro_extended");
  });

  test("is case-insensitive and whitespace-tolerant", () => {
    expect(tierForLabel("  HEAVY ")?.tier).toBe("heavy");
    expect(tierForLabel("pro\textended")?.tier).toBe("pro_extended");
  });

  test("resolves rename synonyms — Thinking Heavy aliases to heavy", () => {
    expect(tierForLabel("Thinking Heavy")?.tier).toBe("heavy");
    expect(tierForLabel("Pro Heavy")?.tier).toBe("heavy");
  });

  test("returns null for unknown labels (no false-positive mapping)", () => {
    expect(tierForLabel("Unobtainium")).toBeNull();
    expect(tierForLabel("")).toBeNull();
    expect(tierForLabel("   ")).toBeNull();
  });
});

describe("availableEffortLabelsHash", () => {
  test("returns a sha256:<64-hex> digest", () => {
    const hash = availableEffortLabelsHash(["Heavy", "Pro Extended"]);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is order-insensitive", () => {
    const a = availableEffortLabelsHash(["Pro Extended", "Heavy"]);
    const b = availableEffortLabelsHash(["Heavy", "Pro Extended"]);
    expect(a).toBe(b);
  });

  test("normalises whitespace before hashing", () => {
    const a = availableEffortLabelsHash(["  Heavy ", "Pro\tExtended"]);
    const b = availableEffortLabelsHash(["Heavy", "Pro Extended"]);
    expect(a).toBe(b);
  });

  test("empty / whitespace-only entries are filtered out", () => {
    expect(availableEffortLabelsHash(["", "  "])).toBe(availableEffortLabelsHash([]));
  });

  test("different label sets produce different digests", () => {
    expect(availableEffortLabelsHash(["Heavy"])).not.toBe(
      availableEffortLabelsHash(["Heavy", "Pro Extended"]),
    );
  });
});

describe("pickHighestVisibleEffort — verified path", () => {
  test("selects Heavy when it is the only label", () => {
    const verdict = pickHighestVisibleEffort({ observedLabels: ["Heavy"] });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Heavy");
    expect(verdict.tier).toBe("heavy");
    expect(verdict.rank).toBe(60);
    expect(verdict.selectedIsHighestVisible).toBe(true);
    expect(verdict.errorCode).toBeNull();
    expect(verdict.selectorManifestVersion).toBe(SELECTOR_MANIFEST_VERSION);
  });

  test("Heavy ranks above Pro Extended when both are visible", () => {
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["Pro Extended", "Heavy", "Thinking"],
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Heavy");
    expect(verdict.tier).toBe("heavy");
  });

  test("Ultra ranks above Heavy when ChatGPT exposes the ultra tier", () => {
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["Heavy", "Ultra", "Pro Extended"],
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Ultra");
    expect(verdict.tier).toBe("ultra");
  });

  test("survives a rename: Thinking Heavy alias still resolves to heavy", () => {
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["Pro Extended", "Thinking Heavy", "Standard"],
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Thinking Heavy");
    expect(verdict.tier).toBe("heavy");
  });

  test("ignores empty labels and trailing whitespace", () => {
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["", "Heavy   ", "  ", "Standard"],
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Heavy");
    expect(verdict.observedLabels).toEqual(["Heavy", "Standard"]);
  });

  test("availableEffortLabelsHash on verdict matches the helper", () => {
    const labels = ["Heavy", "Pro Extended"];
    const verdict = pickHighestVisibleEffort({ observedLabels: labels });
    expect(verdict.availableEffortLabelsHash).toBe(availableEffortLabelsHash(labels));
  });
});

describe("pickHighestVisibleEffort — failure paths", () => {
  test("empty observedLabels → unverified + output_capture_unverified", () => {
    const verdict = pickHighestVisibleEffort({ observedLabels: [] });
    expect(verdict.status).toBe("unverified");
    expect(verdict.selected).toBeNull();
    expect(verdict.tier).toBeNull();
    expect(verdict.rank).toBeNull();
    expect(verdict.selectedIsHighestVisible).toBe(false);
    expect(verdict.errorCode).toBe("output_capture_unverified");
    expect(verdict.reason).toMatch(/effort.+control/i);
  });

  test("only whitespace labels → unverified (treated as empty)", () => {
    const verdict = pickHighestVisibleEffort({ observedLabels: ["", "   ", "\t"] });
    expect(verdict.status).toBe("unverified");
    expect(verdict.errorCode).toBe("output_capture_unverified");
  });

  test("only unknown labels → ui_drift_suspected with the matching error code", () => {
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["Unobtainium", "Vibranium Plus"],
    });
    expect(verdict.status).toBe("ui_drift_suspected");
    expect(verdict.errorCode).toBe("ui_drift_suspected");
    expect(verdict.selected).toBeNull();
    expect(verdict.tier).toBeNull();
    expect(verdict.reason).toMatch(/Unobtainium/);
    // Even on drift, we still record the available_effort_labels_hash
    // so browser_evidence.v1 can pin what the UI actually offered.
    expect(verdict.availableEffortLabelsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("partial drift: at least one known label means we still verify", () => {
    // Bead: "changed labels still ranked correctly". If ChatGPT renames
    // the top tier to "Vibranium" but keeps "Heavy" as a lower option,
    // we pick Heavy and report verified — we never silently downgrade
    // to a drift outcome when a known tier is still present.
    const verdict = pickHighestVisibleEffort({
      observedLabels: ["Heavy", "Standard", "Vibranium"],
    });
    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Heavy");
  });
});

describe("highestKnownLabel helper", () => {
  test("returns the highest-rank known label", () => {
    expect(highestKnownLabel(["Standard", "Heavy", "Thinking"])).toBe("Heavy");
  });

  test("returns null when no label is known", () => {
    expect(highestKnownLabel(["Unobtainium", "Vibranium"])).toBeNull();
  });

  test("returns null when given an empty list", () => {
    expect(highestKnownLabel([])).toBeNull();
  });

  test("tolerates a single known label", () => {
    expect(highestKnownLabel(["Thinking"])).toBe("Thinking");
  });
});
