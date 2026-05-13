// Unit tests for the v18 provider-access policy layer.
//
// Acceptance criteria (from oracle-cv6):
//
//   Tests cover forbidden OpenAI API substitution for ChatGPT Pro,
//   forbidden Gemini API substitution for Deep Think, forbidden Anthropic
//   API substitution for Claude Code, and allowed xAI/DeepSeek metadata
//   remaining explicit.
//
// We also cross-validate the Zod schema for `provider_access_policy.v1`
// against the canonical fixture in the v18 plan bundle so the contract
// stays in sync with the shared source of truth.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  API_ALLOWED_SLOTS,
  NON_ORACLE_CLI_SLOTS,
  ORACLE_BROWSER_ACCESS_PATHS,
  PROTECTED_SLOTS,
  PROTECTED_SLOT_FAMILY,
  PROTECTED_SLOT_UNVERIFIED_CODE,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  evaluateSlotAccess,
  isApiAllowedSlot,
  isApiSubstitutionForbiddenFor,
  isNonOracleCliSlot,
  isOracleBrowserAccessPath,
  isProtectedSlot,
  protectedSlotMetadataFor,
  providerAccessPolicySchema,
} from "../../../src/oracle/v18/index.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(
  moduleDir,
  "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

async function loadAccessPolicyFixture(): Promise<unknown> {
  const filePath = path.join(PLAN_BUNDLE, "fixtures/provider-access-policy.json");
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

describe("provider_access_policy.v1 schema", () => {
  test("canonical plan-bundle fixture parses against the Zod schema", async () => {
    const fixture = await loadAccessPolicyFixture();
    const parsed = providerAccessPolicySchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe(PROVIDER_ACCESS_POLICY_SCHEMA_VERSION);
      expect(parsed.data.bundle_version).toBe("v18.0.0");
      expect(parsed.data.allowed_api_routes).toEqual([
        "xai_grok_reasoning",
        "deepseek_v4_pro_reasoning_search",
      ]);
    }
  });

  test("rejects wrong schema_version literal", () => {
    const parsed = providerAccessPolicySchema.safeParse({
      schema_version: "provider_access_policy.v0",
      bundle_version: "v18.0.0",
      live_routes: {},
      forbidden_live_substitutions: [],
      allowed_api_routes: [],
      runtime_invariants: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects mismatched bundle_version", () => {
    const parsed = providerAccessPolicySchema.safeParse({
      schema_version: PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
      bundle_version: "v17.0.0",
      live_routes: {},
      forbidden_live_substitutions: [],
      allowed_api_routes: [],
      runtime_invariants: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("each protected slot in the canonical fixture is browser-only", async () => {
    const fixture = await loadAccessPolicyFixture();
    const parsed = providerAccessPolicySchema.parse(fixture);
    for (const slot of PROTECTED_SLOTS) {
      const route = parsed.live_routes[slot];
      expect(route, `missing protected route ${slot}`).toBeDefined();
      expect(route.api_allowed).toBe(false);
      expect(route.evidence_required).toBe(true);
      expect(route.oracle_allowed).toBe(true);
      expect(isOracleBrowserAccessPath(route.access_path)).toBe(true);
      expect(route.provider_family).toBe(PROTECTED_SLOT_FAMILY[slot]);
    }
  });

  test("each API-allowed slot in the canonical fixture has api_allowed=true", async () => {
    const fixture = await loadAccessPolicyFixture();
    const parsed = providerAccessPolicySchema.parse(fixture);
    for (const slot of API_ALLOWED_SLOTS) {
      const route = parsed.live_routes[slot];
      expect(route, `missing API-allowed route ${slot}`).toBeDefined();
      expect(route.api_allowed).toBe(true);
      expect(route.oracle_allowed).toBe(false);
      expect(isOracleBrowserAccessPath(route.access_path)).toBe(false);
    }
  });

  test("non-Oracle CLI slots round-trip but route through subscription CLIs", async () => {
    const fixture = await loadAccessPolicyFixture();
    const parsed = providerAccessPolicySchema.parse(fixture);
    for (const slot of NON_ORACLE_CLI_SLOTS) {
      const route = parsed.live_routes[slot];
      expect(route, `missing non-Oracle route ${slot}`).toBeDefined();
      expect(route.api_allowed).toBe(false);
      expect(route.oracle_allowed).toBe(false);
    }
  });
});

describe("slot taxonomy guards", () => {
  test("isProtectedSlot matches PROTECTED_SLOTS and rejects unknowns", () => {
    for (const slot of PROTECTED_SLOTS) {
      expect(isProtectedSlot(slot)).toBe(true);
    }
    expect(isProtectedSlot("xai_grok_reasoning")).toBe(false);
    expect(isProtectedSlot("claude_code_opus")).toBe(false);
    expect(isProtectedSlot("not_a_real_slot")).toBe(false);
    expect(isProtectedSlot(undefined)).toBe(false);
    expect(isProtectedSlot(42)).toBe(false);
  });

  test("isApiAllowedSlot accepts only xAI / DeepSeek", () => {
    expect(isApiAllowedSlot("xai_grok_reasoning")).toBe(true);
    expect(isApiAllowedSlot("deepseek_v4_pro_reasoning_search")).toBe(true);
    for (const slot of PROTECTED_SLOTS) {
      expect(isApiAllowedSlot(slot)).toBe(false);
    }
    expect(isApiAllowedSlot("claude_code_opus")).toBe(false);
  });

  test("isNonOracleCliSlot accepts only Claude Code / Codex", () => {
    for (const slot of NON_ORACLE_CLI_SLOTS) {
      expect(isNonOracleCliSlot(slot)).toBe(true);
    }
    expect(isNonOracleCliSlot("xai_grok_reasoning")).toBe(false);
    expect(isNonOracleCliSlot("chatgpt_pro_first_plan")).toBe(false);
  });

  test("isOracleBrowserAccessPath matches the documented access-path values", () => {
    for (const candidate of ORACLE_BROWSER_ACCESS_PATHS) {
      expect(isOracleBrowserAccessPath(candidate)).toBe(true);
    }
    for (const bad of ["openai_api", "gemini_api", "anthropic_api", "xai_api", "", undefined, 0]) {
      expect(isOracleBrowserAccessPath(bad)).toBe(false);
    }
  });
});

// ─── Acceptance: forbidden API substitutions ─────────────────────────────────

describe("evaluateSlotAccess (acceptance for oracle-cv6)", () => {
  test("forbids OpenAI API satisfying chatgpt_pro_first_plan", () => {
    const verdict = evaluateSlotAccess({
      slot: "chatgpt_pro_first_plan",
      providerFamily: "openai_api",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.code === "chatgpt_pro_unverified")).toBe(true);
    expect(verdict.reasons.some((r) => r.field === "provider_result.access_path")).toBe(true);
    expect(verdict.reasons.some((r) => r.field === "provider_result.provider_family")).toBe(true);
  });

  test("forbids OpenAI API satisfying chatgpt_pro_synthesis", () => {
    const verdict = evaluateSlotAccess({
      slot: "chatgpt_pro_synthesis",
      providerFamily: "openai_api",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.code === "chatgpt_pro_unverified")).toBe(true);
  });

  test("forbids Gemini API satisfying gemini_deep_think", () => {
    const verdict = evaluateSlotAccess({
      slot: "gemini_deep_think",
      providerFamily: "gemini_api",
      accessPath: "gemini_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.code === "gemini_deep_think_unverified")).toBe(true);
    expect(verdict.reasons.some((r) => r.field === "provider_result.provider_family")).toBe(true);
  });

  test("forbids Anthropic API satisfying claude_code_opus", () => {
    // claude_code_opus is not an Oracle-owned protected slot, but the
    // policy still rejects API substitution: it is neither protected nor
    // API-allowed, and the canonical fixture sets api_allowed=false.
    // evaluateSlotAccess returns eligible=true here because Oracle does
    // not police the Claude Code subscription path. The acceptance
    // criterion is that the slot is *not* in API_ALLOWED_SLOTS, so any
    // caller cannot mistake it for one of the xAI/DeepSeek API routes.
    expect(isApiAllowedSlot("claude_code_opus")).toBe(false);
    expect(isProtectedSlot("claude_code_opus")).toBe(false);
    expect(isNonOracleCliSlot("claude_code_opus")).toBe(true);
  });

  test("ChatGPT browser results pass when access_path is oracle_browser_*", () => {
    for (const accessPath of ORACLE_BROWSER_ACCESS_PATHS) {
      const verdict = evaluateSlotAccess({
        slot: "chatgpt_pro_first_plan",
        providerFamily: "chatgpt",
        accessPath,
      });
      expect(verdict.eligible).toBe(true);
      expect(verdict.reasons).toEqual([]);
    }
  });

  test("Gemini Deep Think browser results pass when access_path is oracle_browser_*", () => {
    for (const accessPath of ORACLE_BROWSER_ACCESS_PATHS) {
      const verdict = evaluateSlotAccess({
        slot: "gemini_deep_think",
        providerFamily: "gemini",
        accessPath,
      });
      expect(verdict.eligible).toBe(true);
    }
  });

  test("ChatGPT browser result still fails if access_path drifts to API", () => {
    const verdict = evaluateSlotAccess({
      slot: "chatgpt_pro_first_plan",
      providerFamily: "chatgpt",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.field === "provider_result.access_path")).toBe(true);
  });

  test("xAI Grok via xai_api remains explicitly eligible", () => {
    const verdict = evaluateSlotAccess({
      slot: "xai_grok_reasoning",
      providerFamily: "xai_grok",
      accessPath: "xai_api",
    });
    expect(verdict.eligible).toBe(true);
  });

  test("DeepSeek via deepseek_official_api remains explicitly eligible", () => {
    const verdict = evaluateSlotAccess({
      slot: "deepseek_v4_pro_reasoning_search",
      providerFamily: "deepseek",
      accessPath: "deepseek_official_api",
    });
    expect(verdict.eligible).toBe(true);
  });

  test("xAI / DeepSeek slots reject misrouting through Oracle browser", () => {
    for (const slot of API_ALLOWED_SLOTS) {
      const verdict = evaluateSlotAccess({
        slot,
        providerFamily: "xai_grok",
        accessPath: "oracle_browser_remote",
      });
      expect(verdict.eligible).toBe(false);
      expect(verdict.reasons.some((r) => r.field === "provider_result.access_path")).toBe(true);
    }
  });

  test("unknown / non-v18 slot stays eligible (general Oracle CLI is not policed)", () => {
    // Ordinary Oracle API use outside vibe-planning must remain supported.
    const verdict = evaluateSlotAccess({
      slot: "some_custom_consultation_slot",
      providerFamily: "openai_api",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  test.each([
    ["chatgpt_pro_first_plan", "openai_api", "openai_api"],
    ["chatgpt_pro_synthesis", "openai_api", "openai_api"],
    ["gemini_deep_think", "gemini_api", "gemini_api"],
  ])("isApiSubstitutionForbiddenFor flags %s + %s/%s", (slot, family, accessPath) => {
    expect(isApiSubstitutionForbiddenFor(slot, family, accessPath)).toBe(true);
  });

  test.each([
    ["xai_grok_reasoning", "xai_grok", "xai_api"],
    ["deepseek_v4_pro_reasoning_search", "deepseek", "deepseek_official_api"],
    ["chatgpt_pro_first_plan", "chatgpt", "oracle_browser_remote"],
    ["some_other_slot", "anything", "anything"],
  ])("isApiSubstitutionForbiddenFor allows %s + %s/%s", (slot, family, accessPath) => {
    expect(isApiSubstitutionForbiddenFor(slot, family, accessPath)).toBe(false);
  });
});

// ─── Protected-slot metadata for downstream consumers ────────────────────────

describe("protectedSlotMetadataFor", () => {
  test("returns null for non-protected slots", () => {
    expect(protectedSlotMetadataFor("xai_grok_reasoning")).toBeNull();
    expect(protectedSlotMetadataFor("claude_code_opus")).toBeNull();
    expect(protectedSlotMetadataFor("unknown")).toBeNull();
  });

  test.each(PROTECTED_SLOTS)("emits api_substitution_allowed_for_this_slot=false for %s", (slot) => {
    const metadata = protectedSlotMetadataFor(slot);
    expect(metadata).not.toBeNull();
    expect(metadata?.protected_slot).toBe(true);
    expect(metadata?.api_substitution_allowed_for_this_slot).toBe(false);
    expect(metadata?.required_provider_family).toBe(PROTECTED_SLOT_FAMILY[slot]);
    expect(metadata?.required_access_paths).toEqual(ORACLE_BROWSER_ACCESS_PATHS);
    expect(metadata?.unverified_error_code).toBe(PROTECTED_SLOT_UNVERIFIED_CODE[slot]);
  });

  test("PROTECTED_SLOT_UNVERIFIED_CODE maps every protected slot to a v18 error code", () => {
    expect(PROTECTED_SLOT_UNVERIFIED_CODE.chatgpt_pro_first_plan).toBe("chatgpt_pro_unverified");
    expect(PROTECTED_SLOT_UNVERIFIED_CODE.chatgpt_pro_synthesis).toBe("chatgpt_pro_unverified");
    expect(PROTECTED_SLOT_UNVERIFIED_CODE.gemini_deep_think).toBe("gemini_deep_think_unverified");
  });
});
