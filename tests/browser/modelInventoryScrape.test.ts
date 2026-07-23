import { describe, expect, test } from "vitest";
import {
  applyInventorySelection,
  buildApplySelectionExpression,
  buildInventoryScrapeExpression,
  buildReadCurrentSelectionExpression,
  enumerateModelInventory,
  readCurrentSelection,
  type RuntimeLike,
} from "../../src/browser/actions/modelInventoryScrape.js";

/** A RuntimeLike that returns a canned Runtime.evaluate value. */
const mockRuntime = (value: unknown): RuntimeLike => ({
  evaluate: async () => ({ result: { value } }),
});

describe("browser expressions parse as valid JS", () => {
  // Catches template-literal escaping bugs (\\d, \\s, JSON interpolation) without a browser.
  test("scrape expression is a syntactically valid IIFE", () => {
    const expr = buildInventoryScrapeExpression();
    expect(expr.startsWith("(async () =>")).toBe(true);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });

  test("apply expression embeds targets and parses", () => {
    const expr = buildApplySelectionExpression("GPT-5.6 Sol", "Pro");
    expect(expr).toContain(JSON.stringify("GPT-5.6 Sol"));
    expect(expr).toContain(JSON.stringify("Pro"));
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });

  test("apply expression handles null axes", () => {
    expect(() => new Function(`return ${buildApplySelectionExpression(null, "Pro")}`)).not.toThrow();
    expect(() => new Function(`return ${buildApplySelectionExpression("o3", null)}`)).not.toThrow();
  });

  test("read-current-selection expression parses", () => {
    const expr = buildReadCurrentSelectionExpression();
    expect(expr.startsWith("(async () =>")).toBe(true);
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});

describe("readCurrentSelection (mock Runtime)", () => {
  test("passes through the read result", async () => {
    const res = await readCurrentSelection(mockRuntime({ ok: true, version: "GPT-5.5", effort: "Pro" }));
    expect(res.ok).toBe(true);
    expect(res.version).toBe("GPT-5.5");
    expect(res.effort).toBe("Pro");
  });
});

describe("enumerateModelInventory (mock Runtime)", () => {
  test("parses scraped items into a structured inventory", async () => {
    const inv = await enumerateModelInventory(
      mockRuntime({
        items: [
          { text: "Pro", role: "menuitemradio", ariaChecked: "true", scope: "top" },
          { text: "Instant5.5", role: "menuitemradio", scope: "top" },
          { text: "GPT-5.6 Sol", role: "menuitemradio", ariaChecked: "true", scope: "submenu" },
          { text: "GPT-5.5", role: "menuitemradio", scope: "submenu" },
        ],
      }),
    );
    expect(inv.versions.map((v) => v.text)).toEqual(["GPT-5.6 Sol", "GPT-5.5"]);
    expect(inv.efforts.map((e) => e.text)).toEqual(["Pro", "Instant"]);
    expect(inv.currentVersion?.text).toBe("GPT-5.6 Sol");
    expect(inv.currentEffort?.text).toBe("Pro");
  });

  test("empty/failed scrape yields an empty inventory (caller falls back)", async () => {
    const inv = await enumerateModelInventory(mockRuntime({ error: "trigger-not-found", items: [] }));
    expect(inv.versions).toHaveLength(0);
    expect(inv.efforts).toHaveLength(0);
  });
});

describe("applyInventorySelection (mock Runtime)", () => {
  test("passes through the apply result", async () => {
    const res = await applyInventorySelection(
      mockRuntime({ ok: true, currentVersion: "GPT-5.5", currentEffort: "Pro", actions: ["version:gpt 5 5"] }),
      "GPT-5.5",
      "Pro",
    );
    expect(res.ok).toBe(true);
    expect(res.currentVersion).toBe("GPT-5.5");
  });

  test("missing result is reported as a failure", async () => {
    const res = await applyInventorySelection(mockRuntime(undefined), "GPT-5.5", null);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no-result");
  });
});
