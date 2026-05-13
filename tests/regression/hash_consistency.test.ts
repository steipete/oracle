// Regression: provider_result + browser_evidence hash consistency
// must hold across the full slot matrix from oracle-hbn — ChatGPT
// first-plan, ChatGPT synthesis, Gemini Deep Think, xAI, Claude,
// DeepSeek — using the canonical plan-bundle fixtures as the
// ground truth.
//
// Negative cases drive the same checker through API substitution,
// unverified evidence, and on-disk hash drift to confirm the verifier
// rejects every documented failure mode.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  computeSha256,
  consistencyCodes,
  verifyHashConsistency,
} from "../../src/oracle/v18/hash_consistency.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(
  moduleDir,
  "../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

async function loadFixture<T = unknown>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")) as T;
}

describe("plan-bundle fixtures: positive matrix", () => {
  test("ChatGPT first-plan: provider_result ↔ evidence", async () => {
    const result = await loadFixture("fixtures/provider-result.chatgpt.json");
    const evidence = await loadFixture("fixtures/chatgpt-pro-evidence.json");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });

  test("ChatGPT synthesis: provider_result ↔ same evidence (slot drift via override)", async () => {
    // The plan bundle does not ship a synthesis-specific evidence
    // fixture; the synthesis result references the same selector
    // manifest with its own slot. We rebind both sides to the synthesis
    // slot and confirm the verifier accepts the pair.
    const baseResult = await loadFixture<Record<string, unknown>>(
      "fixtures/provider-result.chatgpt-synthesis.json",
    );
    const baseEvidence = await loadFixture<Record<string, unknown>>(
      "fixtures/chatgpt-pro-evidence.json",
    );
    const evidence = {
      ...baseEvidence,
      evidence_id: baseResult.evidence_id,
      provider_result_id: baseResult.provider_result_id,
      provider_slot: "chatgpt_pro_synthesis",
      output_text_sha256: baseResult.result_text_sha256,
    };
    const verdict = verifyHashConsistency({ result: baseResult, evidence });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });

  test("Gemini Deep Think: provider_result ↔ evidence", async () => {
    const result = await loadFixture("fixtures/provider-result.gemini.json");
    const evidence = await loadFixture("fixtures/gemini-deep-think-evidence.json");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });

  test("xAI Grok: API path is consistent without evidence", async () => {
    const result = await loadFixture("fixtures/provider-result.xai.json");
    const verdict = verifyHashConsistency({ result });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });

  test("Claude Code Opus: subscription CLI path is consistent without evidence", async () => {
    const result = await loadFixture("fixtures/provider-result.claude.json");
    const verdict = verifyHashConsistency({ result });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });

  test("DeepSeek V4 Pro: official API path is consistent without evidence", async () => {
    const result = await loadFixture("fixtures/provider-result.deepseek.json");
    const verdict = verifyHashConsistency({ result });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });
});

describe("plan-bundle fixtures: negative matrix (drift detection)", () => {
  async function corruptChatGpt(
    field: string,
    value: unknown,
  ): Promise<{ result: Record<string, unknown>; evidence: Record<string, unknown> }> {
    const result = (await loadFixture("fixtures/provider-result.chatgpt.json")) as Record<
      string,
      unknown
    >;
    const evidence = (await loadFixture(
      "fixtures/chatgpt-pro-evidence.json",
    )) as Record<string, unknown>;
    if (field.startsWith("evidence.")) {
      const key = field.slice("evidence.".length);
      evidence[key] = value;
    } else {
      result[field] = value;
    }
    return { result, evidence };
  }

  test("tampering with provider_result.evidence_id is detected", async () => {
    const { result, evidence } = await corruptChatGpt("evidence_id", "evil-evidence");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field === "provider_result.evidence_id")).toBe(true);
  });

  test("tampering with result.result_text_sha256 is detected", async () => {
    const { result, evidence } = await corruptChatGpt(
      "result_text_sha256",
      `sha256:${"d".repeat(64)}`,
    );
    const verdict = verifyHashConsistency({ result, evidence });
    expect(consistencyCodes(verdict)).toContain("output_capture_unverified");
  });

  test("tampering with result.provider_result_id is detected", async () => {
    const { result, evidence } = await corruptChatGpt(
      "provider_result_id",
      "tampered-result-id",
    );
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent).toBe(false);
    expect(
      verdict.mismatches.some((m) => m.field === "provider_result.provider_result_id"),
    ).toBe(true);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
  });

  test("API substitution attempt for ChatGPT Pro is rejected", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.chatgpt.json",
    )) as Record<string, unknown>;
    // Swap the access path for an OpenAI API call.
    result.access_path = "openai_api";
    result.provider_family = "openai_api";
    const evidence = await loadFixture("fixtures/chatgpt-pro-evidence.json");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent).toBe(false);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
    expect(verdict.mismatches.some((m) => m.field === "provider_result.access_path")).toBe(true);
  });

  test("API substitution attempt for Gemini Deep Think is rejected", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.gemini.json",
    )) as Record<string, unknown>;
    result.access_path = "gemini_api";
    result.provider_family = "gemini_api";
    const evidence = await loadFixture("fixtures/gemini-deep-think-evidence.json");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(consistencyCodes(verdict)).toContain("gemini_deep_think_unverified");
    expect(verdict.mismatches.some((m) => m.field === "provider_result.access_path")).toBe(true);
  });

  test("unverified evidence cannot back synthesis_eligible=true", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.chatgpt.json",
    )) as Record<string, unknown>;
    const evidence = (await loadFixture(
      "fixtures/chatgpt-pro-evidence.json",
    )) as Record<string, unknown>;
    evidence.mode_verified = false;
    const verdict = verifyHashConsistency({ result, evidence });
    expect(
      verdict.mismatches.some((m) => m.field === "provider_result.synthesis_eligible"),
    ).toBe(true);
  });

  test("prompt-submitted-before-verification flag flips evidence trust", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.chatgpt.json",
    )) as Record<string, unknown>;
    const evidence = (await loadFixture(
      "fixtures/chatgpt-pro-evidence.json",
    )) as Record<string, unknown>;
    evidence.verified_before_prompt_submit = false;
    const verdict = verifyHashConsistency({ result, evidence });
    expect(consistencyCodes(verdict)).toContain("prompt_submitted_before_verification");
  });

  test("a ChatGPT result that lacks an evidence ledger entirely is rejected", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.chatgpt.json",
    )) as Record<string, unknown>;
    result.evidence = null;
    result.evidence_id = null;
    const verdict = verifyHashConsistency({ result });
    expect(verdict.consistent).toBe(false);
    expect(consistencyCodes(verdict)).toContain("chatgpt_pro_unverified");
  });

  test("xAI slot pretending to carry browser evidence is flagged", async () => {
    const result = (await loadFixture(
      "fixtures/provider-result.xai.json",
    )) as Record<string, unknown>;
    // Smuggle in evidence material.
    result.evidence_id = "evidence-demo-chatgpt_pro_first_plan";
    result.evidence = {
      evidence_id: "evidence-demo-chatgpt_pro_first_plan",
      mode_verified: true,
      verified_before_prompt_submit: true,
    };
    const evidence = await loadFixture("fixtures/chatgpt-pro-evidence.json");
    const verdict = verifyHashConsistency({ result, evidence });
    expect(verdict.consistent).toBe(false);
    expect(
      verdict.mismatches.some((m) => m.message.includes("API-allowed slot")),
    ).toBe(true);
  });
});

describe("plan-bundle fixtures: artifact-index tamper detection", () => {
  test("rejects on-disk bytes that no longer match the indexed sha256", async () => {
    const result = await loadFixture("fixtures/provider-result.chatgpt.json");
    const evidence = await loadFixture("fixtures/chatgpt-pro-evidence.json");
    // Realistic index pointing at the on-disk evidence fixture.
    const index = {
      schema_version: "artifact_index.v1",
      artifacts: [
        {
          artifact_id: (evidence as Record<string, unknown>).evidence_id,
          kind: "browser_evidence",
          path: "evidence.json",
          // Wrong hash — pretend the bytes were tampered after writing.
          sha256: `sha256:${"0".repeat(64)}`,
        },
      ],
    };
    const verdict = verifyHashConsistency({
      result,
      evidence,
      artifactIndex: index,
      artifactBytes: { "evidence.json": JSON.stringify(evidence) },
    });
    expect(
      verdict.mismatches.some(
        (m) => m.field === "artifact_index.evidence.json.sha256",
      ),
    ).toBe(true);
  });

  test("accepts on-disk bytes whose hash matches the index", async () => {
    const result = await loadFixture("fixtures/provider-result.chatgpt.json");
    const evidence = await loadFixture("fixtures/chatgpt-pro-evidence.json");
    const bytes = JSON.stringify(evidence);
    const realHash = computeSha256(bytes);
    const index = {
      schema_version: "artifact_index.v1",
      artifacts: [
        {
          artifact_id: (evidence as Record<string, unknown>).evidence_id,
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: realHash,
        },
      ],
    };
    const verdict = verifyHashConsistency({
      result,
      evidence,
      artifactIndex: index,
      artifactBytes: { "evidence.json": bytes },
    });
    expect(verdict.consistent, JSON.stringify(verdict.mismatches, null, 2)).toBe(true);
  });
});
