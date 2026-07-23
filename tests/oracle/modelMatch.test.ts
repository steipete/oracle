import { describe, expect, test } from "vitest";
import { buildInventoryFromRawItems, type RawMenuItem } from "../../src/oracle/modelInventory.js";
import { matchModelToInventory, parseRequest } from "../../src/oracle/modelMatch.js";

// Live GPT-5.6 "Sol" inventory (see modelInventory.test.ts for provenance).
const SOL_RAW: RawMenuItem[] = [
  { text: "Instant5.5", role: "menuitemradio", scope: "top" },
  { text: "Medium", role: "menuitemradio", scope: "top" },
  { text: "High", role: "menuitemradio", scope: "top" },
  { text: "Extra High", role: "menuitemradio", scope: "top" },
  { text: "Pro", role: "menuitemradio", ariaChecked: "true", scope: "top" },
  { text: "GPT-5.6 Sol", role: "menuitem", ariaHaspopup: "menu", scope: "top" },
  { text: "GPT-5.6 Sol", role: "menuitemradio", ariaChecked: "true", scope: "submenu" },
  { text: "GPT-5.5", role: "menuitemradio", scope: "submenu" },
  { text: "GPT-5.4Leaving on July 23", role: "menuitemradio", scope: "submenu" },
  { text: "GPT-5.3", role: "menuitemradio", scope: "submenu" },
  { text: "o3", role: "menuitemradio", scope: "submenu" },
];
const SOL = buildInventoryFromRawItems(SOL_RAW);

describe("parseRequest", () => {
  test("splits version and effort", () => {
    expect(parseRequest("gpt-5.6-pro")).toMatchObject({ versionKey: "5.6", effort: "pro" });
    expect(parseRequest("gpt-5.6-sol")).toMatchObject({ versionKey: "5.6" });
    expect(parseRequest("GPT-5.6 Sol")).toMatchObject({ versionKey: "5.6" });
    expect(parseRequest("5.5 thinking")).toMatchObject({ versionKey: "5.5", bareThinking: true });
    expect(parseRequest("o3")).toMatchObject({ versionKey: "o3", family: "o" });
    expect(parseRequest("Pro")).toMatchObject({ effort: "pro" });
    expect(parseRequest("Pro").versionKey).toBeUndefined();
  });

  test("effort synonyms canonicalize", () => {
    expect(parseRequest("gpt-5.6 xhigh").effort).toBe("extra-high");
    expect(parseRequest("gpt-5.6 heavy").effort).toBe("extra-high");
    expect(parseRequest("gpt-5.6 standard").effort).toBe("medium");
    expect(parseRequest("gpt-5.6 extended").effort).toBe("high");
    expect(parseRequest("gpt-5.6 instant").effort).toBe("instant");
  });
});

describe("matchModelToInventory — the cases oracle 0.15.2 got wrong", () => {
  test("gpt-5.6-sol resolves to the real version (was: collapsed to GPT-5.2)", () => {
    const r = matchModelToInventory("gpt-5.6-sol", SOL);
    expect(r.status).toBe("matched");
    if (r.status === "matched") expect(r.version?.text).toBe("GPT-5.6 Sol");
  });

  test("gpt-5.6-pro resolves version 5.6 + effort Pro", () => {
    const r = matchModelToInventory("gpt-5.6-pro", SOL);
    expect(r.status).toBe("matched");
    if (r.status === "matched") {
      expect(r.version?.text).toBe("GPT-5.6 Sol");
      expect(r.effort?.text).toBe("Pro");
      expect(r.confidence).toBe(1);
    }
  });

  test('literal UI label "GPT-5.6 Sol" resolves', () => {
    const r = matchModelToInventory("GPT-5.6 Sol", SOL);
    expect(r.status).toBe("matched");
    if (r.status === "matched") expect(r.version?.text).toBe("GPT-5.6 Sol");
  });

  test("o3 resolves to the o3 version, not effort", () => {
    const r = matchModelToInventory("o3", SOL);
    expect(r.status).toBe("matched");
    if (r.status === "matched") expect(r.version?.text).toBe("o3");
  });
});

describe("matchModelToInventory — robustness properties", () => {
  test("version-agnostic '-m Pro' keeps current version, switches effort", () => {
    const r = matchModelToInventory("Pro", SOL);
    expect(r.status).toBe("matched");
    if (r.status === "matched") {
      expect(r.version).toBeUndefined();
      expect(r.effort?.text).toBe("Pro");
    }
  });

  test("a FUTURE model works with zero code change IF ChatGPT lists it", () => {
    // Same picker, but ChatGPT has added GPT-5.7 to the version submenu.
    const future = buildInventoryFromRawItems([
      ...SOL_RAW,
      { text: "GPT-5.7", role: "menuitemradio", scope: "submenu" },
    ]);
    const r = matchModelToInventory("gpt-5.7-pro", future);
    expect(r.status).toBe("matched");
    if (r.status === "matched") {
      expect(r.version?.text).toBe("GPT-5.7");
      expect(r.effort?.text).toBe("Pro");
    }
  });

  test("unavailable version fails LOUD with real candidates (was: silent GPT-5.2)", () => {
    const r = matchModelToInventory("gpt-9.9", SOL);
    expect(r.status).toBe("not-found");
    if (r.status !== "matched") {
      expect(r.candidates).toContain("GPT-5.6 Sol");
      expect(r.candidates).not.toContain("GPT-5.2");
    }
  });

  test("unavailable effort fails loud with real effort candidates", () => {
    const bare = buildInventoryFromRawItems([
      { text: "GPT-5.6 Sol", role: "menuitemradio", ariaChecked: "true", scope: "submenu" },
      { text: "Instant", role: "menuitemradio", scope: "top" },
      { text: "Pro", role: "menuitemradio", scope: "top" },
    ]);
    const r = matchModelToInventory("gpt-5.6 medium", bare);
    expect(r.status).toBe("not-found");
    if (r.status !== "matched") expect(r.candidates).toEqual(["Instant", "Pro"]);
  });

  test("bare 'thinking' with no level is flagged ambiguous (candidate for LLM fallback)", () => {
    const r = matchModelToInventory("thinking", SOL);
    expect(r.status).toBe("ambiguous");
  });
});
