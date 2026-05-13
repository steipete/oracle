// Unit tests for the ChatGPT selector manifest (oracle-hcs).

import { describe, expect, test } from "vitest";

import {
  CHATGPT_SELECTOR_MANIFEST,
  SELECTOR_MANIFEST_LAST_VERIFIED,
  SELECTOR_MANIFEST_VERSION,
  chatgptManifestFingerprint,
  chatgptSelector,
  chatgptSelectorFingerprint,
  chatgptSelectorList,
  type ChatGptSelectorPurpose,
} from "../../../src/browser/selectors/chatgpt/index.js";

describe("CHATGPT_SELECTOR_MANIFEST shape", () => {
  test("manifest version is pinned and last-verified date parses as ISO", () => {
    expect(SELECTOR_MANIFEST_VERSION).toMatch(/^chatgpt-selectors\.v\d+$/);
    expect(SELECTOR_MANIFEST_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(SELECTOR_MANIFEST_LAST_VERIFIED))).toBe(false);
  });

  test("every entry carries provider/purpose/primary/fallback/confidence/rank/lastVerified", () => {
    for (const entry of CHATGPT_SELECTOR_MANIFEST) {
      expect(entry.provider).toBe("chatgpt");
      expect(typeof entry.purpose).toBe("string");
      expect(Array.isArray(entry.primary) && entry.primary.length).toBeTruthy();
      expect(Array.isArray(entry.fallback)).toBe(true);
      expect(["high", "medium", "low"]).toContain(entry.confidence);
      expect(Number.isInteger(entry.rank)).toBe(true);
      expect(entry.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("purposes are unique across the manifest", () => {
    const purposes = CHATGPT_SELECTOR_MANIFEST.map((e) => e.purpose);
    expect(new Set(purposes).size).toBe(purposes.length);
  });

  test("ranks are strictly increasing and globally unique", () => {
    const ranks = CHATGPT_SELECTOR_MANIFEST.map((e) => e.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  test("covers the critical purposes documented in oracle-hcs", () => {
    const purposes = new Set(CHATGPT_SELECTOR_MANIFEST.map((e) => e.purpose));
    for (const required of [
      "assistant_turn",
      "answer_now_cta",
      "thinking_state",
      "model_picker_button",
      "effort_picker_button",
      "composer_textarea",
      "send_button",
    ] as const) {
      expect(purposes.has(required), `manifest missing purpose ${required}`).toBe(true);
    }
  });

  test("Answer Now selector entry documents the 'do not click' constraint via fixtureRefs", () => {
    const entry = chatgptSelector("answer_now_cta");
    expect(entry).not.toBeNull();
    expect(entry?.labelExpectations?.text).toContain("Answer now");
    // The fixture ref points at the manual-tests doc that records the
    // AGENTS.md "never click Answer now" rule.
    expect(entry?.fixtureRefs?.some((ref) => /pro-thinking-do-not-click/.test(ref))).toBe(true);
  });
});

describe("manifest accessors", () => {
  test("chatgptSelector returns null for unknown purposes", () => {
    expect(chatgptSelector("not_a_purpose" as ChatGptSelectorPurpose)).toBeNull();
  });

  test("chatgptSelectorList returns primary + fallback in evaluation order", () => {
    const entry = chatgptSelector("composer_textarea");
    expect(entry).not.toBeNull();
    const list = chatgptSelectorList("composer_textarea");
    expect(list.slice(0, entry!.primary.length)).toEqual([...entry!.primary]);
    expect(list.slice(entry!.primary.length)).toEqual([...entry!.fallback]);
  });

  test("chatgptSelectorFingerprint is stable across calls", () => {
    const a = chatgptSelectorFingerprint("composer_textarea");
    const b = chatgptSelectorFingerprint("composer_textarea");
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("two different purposes produce different fingerprints", () => {
    expect(chatgptSelectorFingerprint("composer_textarea")).not.toBe(
      chatgptSelectorFingerprint("send_button"),
    );
  });

  test("manifest fingerprint is stable and sha256-shaped", () => {
    const fp = chatgptManifestFingerprint();
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chatgptManifestFingerprint()).toBe(fp);
  });
});
