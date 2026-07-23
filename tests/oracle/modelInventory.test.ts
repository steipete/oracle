import { describe, expect, test } from "vitest";
import {
  buildInventoryFromRawItems,
  cleanEffortLabel,
  cleanVersionLabel,
  looksLikeVersion,
  type RawMenuItem,
} from "../../src/oracle/modelInventory.js";

// Verbatim from a live GPT-5.6 "Sol" era picker, captured via CDP on 2026-07-12.
// Top intelligence menu + the opened version submenu. Note: no data-testids.
const REAL_RAW: RawMenuItem[] = [
  { text: "Instant5.5", role: "menuitemradio", ariaChecked: "false", scope: "top" },
  { text: "Medium", role: "menuitemradio", ariaChecked: "false", scope: "top" },
  { text: "High", role: "menuitemradio", ariaChecked: "false", scope: "top" },
  { text: "Extra High", role: "menuitemradio", ariaChecked: "false", scope: "top" },
  { text: "Pro", role: "menuitemradio", ariaChecked: "true", dataState: "checked", scope: "top" },
  { text: "GPT-5.6 Sol", role: "menuitem", ariaHaspopup: "menu", scope: "top" },
  // version submenu
  { text: "GPT-5.6 Sol", role: "menuitemradio", ariaChecked: "true", dataState: "checked", scope: "submenu" },
  { text: "GPT-5.5", role: "menuitemradio", ariaChecked: "false", scope: "submenu" },
  { text: "GPT-5.4Leaving on July 23", role: "menuitemradio", ariaChecked: "false", scope: "submenu" },
  { text: "GPT-5.3", role: "menuitemradio", ariaChecked: "false", scope: "submenu" },
  { text: "o3", role: "menuitemradio", ariaChecked: "false", scope: "submenu" },
];

describe("label cleaning", () => {
  test("strips glued version subscript from effort labels", () => {
    expect(cleanEffortLabel("Instant5.5")).toBe("Instant");
    expect(cleanEffortLabel("Extra High")).toBe("Extra High");
    expect(cleanEffortLabel("Pro")).toBe("Pro");
  });

  test("strips deprecation note but keeps version numbers", () => {
    expect(cleanVersionLabel("GPT-5.4Leaving on July 23")).toBe("GPT-5.4");
    expect(cleanVersionLabel("GPT-5.6 Sol")).toBe("GPT-5.6 Sol");
  });

  test("classifies versions vs efforts (o3 is a version, not effort 'o')", () => {
    expect(looksLikeVersion("GPT-5.6 Sol")).toBe(true);
    expect(looksLikeVersion("o3")).toBe(true);
    expect(looksLikeVersion("GPT-5.6 Sol", "menu")).toBe(true);
    expect(looksLikeVersion("Extra High")).toBe(false);
    expect(looksLikeVersion("Pro")).toBe(false);
    // o3 is a version, so it's cleaned as one (never subjected to effort-subscript stripping).
    expect(cleanVersionLabel("o3")).toBe("o3");
  });
});

describe("buildInventoryFromRawItems (real DOM)", () => {
  const inv = buildInventoryFromRawItems(REAL_RAW);

  test("extracts the version list, de-duping the trigger+submenu entry", () => {
    expect(inv.versions.map((v) => v.text)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.3",
      "o3",
    ]);
  });

  test("extracts the effort list", () => {
    expect(inv.efforts.map((e) => e.text)).toEqual([
      "Instant",
      "Medium",
      "High",
      "Extra High",
      "Pro",
    ]);
  });

  test("reads current selection from aria-checked (5.6 Sol · Pro)", () => {
    expect(inv.currentVersion?.text).toBe("GPT-5.6 Sol");
    expect(inv.currentEffort?.text).toBe("Pro");
  });
});
