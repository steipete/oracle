// Unit tests for verifyHashConsistency (oracle-hbn).

import { describe, expect, test } from "vitest";

import {
  assertHashConsistency,
  computeSha256,
  consistencyCodes,
  verifyHashConsistency,
} from "../../../src/oracle/v18/hash_consistency.js";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  PROVIDER_RESULT_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
} from "../../../src/oracle/v18/contracts.js";
import { ARTIFACT_INDEX_SCHEMA_VERSION } from "../../../src/oracle/v18/contracts.js";

const HASHES = {
  prompt: `sha256:${"a".repeat(64)}` as const,
  output: `sha256:${"b".repeat(64)}` as const,
  baseline: `sha256:${"c".repeat(64)}` as const,
  session: `sha256:${"d".repeat(64)}` as const,
  transition: `sha256:${"e".repeat(64)}` as const,
  labels: `sha256:${"f".repeat(64)}` as const,
};

function buildEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: HASHES.labels,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-13T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-test-1",
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    mode_verified: true,
    next_command: null,
    observed_reasoning_effort_label: "Heavy",
    output_text_sha256: HASHES.output,
    prompt_sha256: HASHES.prompt,
    prompt_submitted_at: "2026-05-13T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "provider-result-test-1",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "run-test",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: HASHES.session,
    transition_log_sha256: HASHES.transition,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-13T00:00:00Z",
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

function buildResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_path: "oracle_browser_remote",
    bundle_version: V18_BUNDLE_VERSION,
    evidence: {
      evidence_id: "evidence-test-1",
      mode_verified: true,
      verified_before_prompt_submit: true,
    },
    evidence_id: "evidence-test-1",
    model: "chatgpt-pro-latest",
    prompt_manifest_sha256: HASHES.prompt,
    provider_family: "chatgpt",
    provider_result_id: "provider-result-test-1",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort: "max_browser_available",
    reasoning_effort_verified: true,
    result_text_sha256: HASHES.output,
    schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
    source_baseline_sha256: HASHES.baseline,
    status: "success",
    synthesis_eligible: true,
    ...overrides,
  };
}

describe("verifyHashConsistency — clean pairs", () => {
  test("matched evidence + result is consistent", () => {
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence(),
    });
    expect(verdict.consistent).toBe(true);
    expect(verdict.mismatches).toEqual([]);
  });

  test("API-allowed slot without evidence is consistent", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        access_path: "xai_api",
        provider_slot: "xai_grok_reasoning",
        provider_family: "xai_grok",
        evidence: null,
        evidence_id: null,
        model: "grok-4.3",
        reasoning_effort: "high",
      }),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("DeepSeek API slot without evidence is consistent", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        access_path: "deepseek_official_api",
        provider_slot: "deepseek_v4_pro_reasoning_search",
        provider_family: "deepseek",
        evidence: null,
        evidence_id: null,
        model: "deepseek-v4-pro",
        reasoning_effort: "max",
      }),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("Claude Code subscription path is consistent without evidence", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        access_path: "claude_code_subscription_cli",
        provider_slot: "claude_code_opus",
        provider_family: "claude",
        evidence: null,
        evidence_id: null,
        model: "claude-opus-4-7",
        reasoning_effort: "max",
      }),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("Gemini Deep Think browser slot is consistent with matching evidence", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        provider_slot: "gemini_deep_think",
        provider_family: "gemini",
        evidence: { evidence_id: "evidence-gemini-1" },
        evidence_id: "evidence-gemini-1",
      }),
      evidence: buildEvidence({
        provider: "gemini",
        provider_slot: "gemini_deep_think",
        evidence_id: "evidence-gemini-1",
        browser_effort_strategy: "select_deep_think_and_highest_thinking_level_if_exposed",
      }),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("ChatGPT synthesis slot is consistent", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        provider_slot: "chatgpt_pro_synthesis",
        provider_family: "chatgpt",
        evidence: { evidence_id: "evidence-syn-1" },
        evidence_id: "evidence-syn-1",
      }),
      evidence: buildEvidence({
        evidence_id: "evidence-syn-1",
        provider_slot: "chatgpt_pro_synthesis",
      }),
    });
    expect(verdict.consistent).toBe(true);
  });
});

describe("verifyHashConsistency — mismatches", () => {
  test("evidence_id mismatch flags the field", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ evidence_id: "evidence-X" }),
      evidence: buildEvidence({ evidence_id: "evidence-Y" }),
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field === "provider_result.evidence_id")).toBe(true);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
  });

  test("provider_slot mismatch flags the field", () => {
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence({ provider_slot: "chatgpt_pro_synthesis" }),
    });
    expect(verdict.mismatches.some((m) => m.field === "provider_result.provider_slot")).toBe(true);
  });

  test("provider family mismatch flags the field", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ provider_family: "gemini" }),
      evidence: buildEvidence(),
    });
    expect(verdict.mismatches.some((m) => m.field === "provider_result.provider_family")).toBe(true);
  });

  test("result_text_sha256 mismatch maps to output_capture_unverified", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ result_text_sha256: `sha256:${"9".repeat(64)}` }),
      evidence: buildEvidence(),
    });
    expect(consistencyCodes(verdict)).toContain("output_capture_unverified");
  });

  test("provider_result_id mismatch is detected (primary cross-artifact rule)", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ provider_result_id: "result-A" }),
      evidence: buildEvidence({ provider_result_id: "result-B" }),
    });
    expect(verdict.consistent).toBe(false);
    expect(
      verdict.mismatches.some((m) => m.field === "provider_result.provider_result_id"),
    ).toBe(true);
  });

  test("prompt_manifest_sha256 differs from evidence.prompt_sha256 by design (no mismatch)", () => {
    // prompt_manifest_sha256 hashes the MANIFEST document; prompt_sha256
    // hashes the raw prompt TEXT bytes. They are intentionally distinct
    // artifacts, so the verifier must not flag the difference.
    const verdict = verifyHashConsistency({
      result: buildResult({ prompt_manifest_sha256: `sha256:${"8".repeat(64)}` }),
      evidence: buildEvidence(),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("protected slot without evidence flags the missing ledger", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ evidence: null, evidence_id: null }),
    });
    expect(verdict.mismatches.some((m) => m.field === "provider_result.evidence")).toBe(true);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
  });

  test("protected slot with unverified evidence blocks synthesis_eligible=true", () => {
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence({ mode_verified: false }),
    });
    expect(
      verdict.mismatches.some((m) => m.field === "provider_result.synthesis_eligible"),
    ).toBe(true);
  });

  test("protected slot with API access_path is rejected even when evidence is verified", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ access_path: "openai_api" }),
      evidence: buildEvidence(),
    });
    expect(verdict.mismatches.some((m) => m.field === "provider_result.access_path")).toBe(true);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
  });

  test("API-allowed slot carrying browser evidence is flagged (no v18 code)", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({
        provider_slot: "xai_grok_reasoning",
        provider_family: "xai_grok",
        access_path: "xai_api",
        evidence: { evidence_id: "smuggled-evidence" },
        evidence_id: "smuggled-evidence",
      }),
      evidence: buildEvidence({
        evidence_id: "smuggled-evidence",
        provider_slot: "xai_grok_reasoning",
        provider: "chatgpt", // mismatched family further confirms drift
      }),
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("API-allowed slot"))).toBe(true);
  });

  test("schema-invalid result yields parse errors, never silently passes", () => {
    const verdict = verifyHashConsistency({ result: { not: "valid" } });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field.startsWith("provider_result"))).toBe(true);
  });
});

describe("verifyHashConsistency — artifact index", () => {
  function buildIndex(entries: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
      artifacts: entries,
    };
  }

  test("flags missing evidence_id in the index", () => {
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence(),
      artifactIndex: buildIndex([
        { artifact_id: "something-else", kind: "browser_evidence", path: "x.json", sha256: HASHES.output },
      ]),
    });
    expect(verdict.mismatches.some((m) => m.field === "artifact_index.artifacts")).toBe(true);
  });

  test("detects on-disk hash drift (partial write / tamper)", () => {
    const bytes = JSON.stringify({ hello: "world" });
    const realHash = computeSha256(bytes);
    const stale = `sha256:${"0".repeat(64)}` as const;
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence(),
      artifactIndex: buildIndex([
        { artifact_id: "evidence-test-1", kind: "browser_evidence", path: "evidence-test-1.json", sha256: stale },
      ]),
      artifactBytes: { "evidence-test-1.json": bytes },
    });
    expect(
      verdict.mismatches.some(
        (m) => m.field === "artifact_index.evidence-test-1.json.sha256",
      ),
    ).toBe(true);
    // Sanity: the computed hash is non-trivial.
    expect(realHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("clean on-disk bytes match the recorded sha256", () => {
    const bytes = JSON.stringify({ ok: true });
    const realHash = computeSha256(bytes);
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence(),
      artifactIndex: buildIndex([
        { artifact_id: "evidence-test-1", kind: "browser_evidence", path: "evidence.json", sha256: realHash },
      ]),
      artifactBytes: { "evidence.json": bytes },
    });
    expect(verdict.consistent).toBe(true);
  });

  test("flags missing bytes for an indexed entry", () => {
    const verdict = verifyHashConsistency({
      result: buildResult(),
      evidence: buildEvidence(),
      artifactIndex: buildIndex([
        { artifact_id: "evidence-test-1", kind: "browser_evidence", path: "evidence.json", sha256: HASHES.output },
      ]),
      artifactBytes: {},
    });
    expect(
      verdict.mismatches.some((m) => m.message.includes("missing bytes")),
    ).toBe(true);
  });
});

describe("assertHashConsistency", () => {
  test("returns silently on a consistent pair", () => {
    expect(() =>
      assertHashConsistency({ result: buildResult(), evidence: buildEvidence() }),
    ).not.toThrow();
  });

  test("throws a summarised error on inconsistency", () => {
    expect(() =>
      assertHashConsistency({
        result: buildResult({ evidence_id: "X" }),
        evidence: buildEvidence({ evidence_id: "Y" }),
      }),
    ).toThrow(/Hash consistency failed/);
  });
});

describe("consistencyCodes", () => {
  test("deduplicates and orders codes deterministically per insertion", () => {
    const verdict = verifyHashConsistency({
      result: buildResult({ evidence_id: "X", access_path: "openai_api" }),
      evidence: buildEvidence({ evidence_id: "Y", mode_verified: false }),
    });
    const codes = consistencyCodes(verdict);
    // We expect chatgpt_pro_unverified to fire, plus prompt/output codes
    // depending on hash drift configuration. Deduped — no repeats.
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("chatgpt_pro_unverified");
  });
});
