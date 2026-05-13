import { describe, expect, test } from "vitest";

import {
  EXPLORATORY_PROFILES,
  FAIL_CLOSED_PROFILES,
  NON_WAIVABLE_PROTECTED_SLOTS,
  assessProtectedSlot,
  detectSilentDowngrade,
  isExploratoryProfile,
  isNonWaivableSlot,
  profileFailsClosed,
  type DowngradeInspectionInput,
} from "@src/oracle/v18/protected_slot_boundaries.ts";

describe("NON_WAIVABLE_PROTECTED_SLOTS canonical list", () => {
  test("matches the v18 fixture's non_waivable_slots", () => {
    expect([...NON_WAIVABLE_PROTECTED_SLOTS]).toEqual([
      "chatgpt_pro_first_plan",
      "chatgpt_pro_synthesis",
      "gemini_deep_think",
    ]);
  });

  test.each(NON_WAIVABLE_PROTECTED_SLOTS)("isNonWaivableSlot recognizes %s", (slot) => {
    expect(isNonWaivableSlot(slot)).toBe(true);
  });

  test.each(["xai_grok_reasoning", "deepseek_v4_pro_reasoning_search", "claude_code_opus", ""])(
    "isNonWaivableSlot returns false for %s",
    (slot) => {
      expect(isNonWaivableSlot(slot)).toBe(false);
    },
  );
});

describe("profile semantics", () => {
  test.each(FAIL_CLOSED_PROFILES)("profile %s fails closed", (profile) => {
    expect(profileFailsClosed(profile)).toBe(true);
    expect(isExploratoryProfile(profile)).toBe(false);
  });

  test.each(EXPLORATORY_PROFILES)("profile %s is exploratory", (profile) => {
    expect(profileFailsClosed(profile)).toBe(false);
    expect(isExploratoryProfile(profile)).toBe(true);
  });

  test("unknown profile defaults to fail-closed (no surprise downgrades)", () => {
    expect(profileFailsClosed("brand-new-profile")).toBe(true);
    expect(isExploratoryProfile("brand-new-profile")).toBe(false);
  });
});

describe("detectSilentDowngrade — non-protected slots pass through", () => {
  test("non-protected slot is never marked degraded by this detector", () => {
    const verdict = detectSilentDowngrade({
      slot: "xai_grok_reasoning",
      synthesis_eligible: true,
      evidence: null,
      evidence_id: null,
      reasoning_effort_verified: false,
    });
    expect(verdict.degraded).toBe(false);
    expect(verdict.synthesis_eligible).toBe(true);
  });
});

describe("detectSilentDowngrade — happy path for protected slots", () => {
  test.each([
    ["chatgpt_pro_first_plan", "oracle_browser_remote", "Heavy"],
    ["chatgpt_pro_synthesis", "oracle_browser_local", "Heavy"],
    ["gemini_deep_think", "oracle_browser_remote_or_local", "Deep Think"],
  ])("verified %s with %s + %s is not degraded", (slot, accessPath, label) => {
    const verdict = detectSilentDowngrade({
      slot,
      synthesis_eligible: true,
      evidence: { evidence_id: "ev-1" },
      evidence_id: "ev-1",
      reasoning_effort_verified: true,
      observed_reasoning_effort_label: label,
      selected_effort_is_highest_visible: true,
      access_path: accessPath,
      result_text_length: 1024,
    });
    expect(verdict.degraded).toBe(false);
    expect(verdict.synthesis_eligible).toBe(true);
    expect(verdict.next_command).toBeNull();
  });
});

describe("detectSilentDowngrade — no silent downgrade for protected slots", () => {
  type ProtectedProviderFixture = Omit<DowngradeInspectionInput, "slot" | "synthesis_eligible">;

  const happy = {
    evidence: { evidence_id: "ev-1" },
    evidence_id: "ev-1",
    reasoning_effort_verified: true,
    observed_reasoning_effort_label: "Heavy",
    selected_effort_is_highest_visible: true,
    access_path: "oracle_browser_remote",
    result_text_length: 1024,
  } as const satisfies ProtectedProviderFixture;

  test("missing evidence flips synthesis_eligible to false even when caller claims true", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      ...happy,
      evidence: null,
      evidence_id: null,
    });
    expect(verdict.degraded).toBe(true);
    expect(verdict.synthesis_eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.field === "provider_result.evidence")).toBe(true);
  });

  test("reasoning_effort_verified=false is rejected with chatgpt_pro_unverified", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      ...happy,
      reasoning_effort_verified: false,
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.find((r) => r.field === "provider_result.reasoning_effort_verified")?.code,
    ).toBe("chatgpt_pro_unverified");
  });

  test("missing picker label is rejected (no hidden lower mode)", () => {
    const verdict = detectSilentDowngrade({
      slot: "gemini_deep_think",
      synthesis_eligible: true,
      ...happy,
      observed_reasoning_effort_label: "",
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.find(
        (r) => r.field === "provider_result.observed_reasoning_effort_label",
      )?.code,
    ).toBe("gemini_deep_think_unverified");
  });

  test("selected_effort_is_highest_visible=false is rejected", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_synthesis",
      synthesis_eligible: true,
      ...happy,
      selected_effort_is_highest_visible: false,
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.some(
        (r) => r.field === "provider_result.selected_effort_is_highest_visible",
      ),
    ).toBe(true);
  });

  test("API access_path is rejected as a silent downgrade attempt", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      ...happy,
      access_path: "openai_api",
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.some(
        (r) => r.field === "provider_result.access_path" && r.message.includes("API substitution"),
      ),
    ).toBe(true);
    // Recovery surfaces are populated for degraded results.
    expect(verdict.next_command).toBe("oracle doctor chatgpt --json");
    expect(verdict.fix_command).toMatch(/re-run.*chatgpt browser evidence/);
  });

  test("missing access_path is rejected (Oracle cannot infer the route)", () => {
    const partial = {
      evidence: happy.evidence,
      evidence_id: happy.evidence_id,
      reasoning_effort_verified: happy.reasoning_effort_verified,
      observed_reasoning_effort_label: happy.observed_reasoning_effort_label,
      selected_effort_is_highest_visible: happy.selected_effort_is_highest_visible,
      result_text_length: happy.result_text_length,
    } satisfies Omit<ProtectedProviderFixture, "access_path">;
    const verdict = detectSilentDowngrade({
      slot: "gemini_deep_think",
      synthesis_eligible: true,
      ...partial,
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.find(
        (r) => r.field === "provider_result.access_path" && r.message.includes("explicit"),
      ),
    ).toBeTruthy();
  });

  test("empty output flags output_capture_empty", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      ...happy,
      result_text_length: 0,
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.find((r) => r.field === "provider_result.result_text")?.code,
    ).toBe("output_capture_empty");
  });
});

describe("assessProtectedSlot — fail-closed vs exploratory semantics", () => {
  test("balanced + protected slot absent → blocks synthesis", () => {
    const status = assessProtectedSlot({
      slot: "chatgpt_pro_first_plan",
      profile: "balanced",
      present: false,
    });
    expect(status.presence).toBe("absent");
    expect(status.blocks_synthesis).toBe(true);
    expect(status.non_waivable).toBe(true);
    expect(
      status.reasons.find((r) => r.code === "chatgpt_pro_unverified"),
    ).toBeTruthy();
  });

  test("audit + protected slot absent → blocks synthesis", () => {
    const status = assessProtectedSlot({
      slot: "gemini_deep_think",
      profile: "audit",
      present: false,
    });
    expect(status.blocks_synthesis).toBe(true);
    expect(
      status.reasons.find((r) => r.code === "gemini_deep_think_unverified"),
    ).toBeTruthy();
  });

  test("fast + optional non-protected slot absent → absent_optional, does not block", () => {
    const status = assessProtectedSlot({
      slot: "xai_grok_reasoning",
      profile: "fast",
      present: false,
      optional: true,
    });
    expect(status.presence).toBe("absent_optional");
    expect(status.blocks_synthesis).toBe(false);
    expect(status.non_waivable).toBe(false);
  });

  test("present + verified protected slot → present_verified, does not block", () => {
    const verified = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      evidence: { evidence_id: "ev-1" },
      evidence_id: "ev-1",
      reasoning_effort_verified: true,
      observed_reasoning_effort_label: "Heavy",
      selected_effort_is_highest_visible: true,
      access_path: "oracle_browser_remote",
      result_text_length: 4096,
    });
    const status = assessProtectedSlot({
      slot: "chatgpt_pro_first_plan",
      profile: "balanced",
      present: true,
      downgrade: verified,
    });
    expect(status.presence).toBe("present_verified");
    expect(status.blocks_synthesis).toBe(false);
  });

  test("present + degraded protected slot → present_degraded, blocks synthesis (non-waivable)", () => {
    const degraded = detectSilentDowngrade({
      slot: "gemini_deep_think",
      synthesis_eligible: true,
      evidence: null,
      evidence_id: null,
      reasoning_effort_verified: false,
      observed_reasoning_effort_label: "",
      selected_effort_is_highest_visible: false,
      access_path: "gemini_api",
      result_text_length: 0,
    });
    const status = assessProtectedSlot({
      slot: "gemini_deep_think",
      profile: "balanced",
      present: true,
      downgrade: degraded,
    });
    expect(status.presence).toBe("present_degraded");
    expect(status.blocks_synthesis).toBe(true);
    expect(status.non_waivable).toBe(true);
    expect(status.reasons.length).toBeGreaterThan(0);
  });
});

describe("integration — optional-route absence metadata vs protected-route failure", () => {
  test("optional route absence is visible but does not block in exploratory profile", () => {
    const status = assessProtectedSlot({
      slot: "deepseek_v4_pro_reasoning_search",
      profile: "fast",
      present: false,
      optional: true,
    });
    expect(status.presence).toBe("absent_optional");
    expect(status.blocks_synthesis).toBe(false);
  });

  test("optional route absence in balanced is still surfaced even if not protected", () => {
    const status = assessProtectedSlot({
      slot: "deepseek_v4_pro_reasoning_search",
      profile: "balanced",
      present: false,
      optional: true,
    });
    // Not protected so non_waivable=false, but the absence is recorded.
    expect(status.presence).toBe("absent");
    expect(status.non_waivable).toBe(false);
  });
});
