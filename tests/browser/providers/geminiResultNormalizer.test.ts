import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  geminiCaptureToSummary,
  geminiDeepThinkToEffortSummary,
  normalizeGeminiRun,
} from "../../../src/browser/providers/geminiResultNormalizer.js";
import { verifyGeminiDeepThinkCandidate } from "../../../src/browser/providers/geminiDeepThink_verification.js";
import { browserEvidenceSchema, type BrowserEvidence } from "../../../src/oracle/v18/contracts.js";
import type { GeminiStreamCaptureSummary } from "../../../src/gemini-web/streamSafeguards.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(moduleDir, "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0");
const PROMPT_MANIFEST_HASH =
  "sha256:69223c8fae80b46ec663079168f541e9308eb835d7720212f8222bf1f239cb18" as const;
const SOURCE_BASELINE_HASH =
  "sha256:b91d369c3f7250980878f782559b0c4ccc00a829603c88cf555c0b23bdd12ee6" as const;
const EVIDENCE_PATH = ".apr/runs/demo/evidence/gemini_deep_think/evidence.json";
const RESULT_PATH = ".apr/runs/demo/plans/gemini_deep_think/output.md";

async function loadFixture<T = unknown>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")) as T;
}

async function loadGeminiEvidence(): Promise<BrowserEvidence> {
  return browserEvidenceSchema.parse(
    await loadFixture("fixtures/gemini-deep-think-evidence.json"),
  ) as BrowserEvidence;
}

function capturedSummary(
  outputTextSha256: `sha256:${string}`,
  overrides: Partial<GeminiStreamCaptureSummary> = {},
): GeminiStreamCaptureSummary {
  return {
    capture_method: "stream_generate_latest_non_empty_candidate",
    confidence: "high",
    result_text_sha256: outputTextSha256,
    output_bytes: 4096,
    current_prompt_sha256: null,
    current_session_id: "gemini-session",
    observed_response_candidate_id: "rcid-gemini",
    expected_response_candidate_id: "rcid-gemini",
    chunk_count: 3,
    non_empty_candidate_count: 1,
    ...overrides,
  };
}

function verifiedDeepThink() {
  return verifyGeminiDeepThinkCandidate({
    deepThinkLabel: "Deep Think",
    observedThinkingLevelLabels: ["standard", "high"],
    selectedThinkingLevel: "high",
    thinkingLevelControlExposed: true,
  });
}

describe("normalizeGeminiRun — happy path", () => {
  test("emits the canonical v18 Gemini provider_result fixture", async () => {
    const evidence = await loadGeminiEvidence();
    const expected = await loadFixture("fixtures/provider-result.gemini.json");

    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: "provider-result-demo-gemini_deep_think",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
      evidencePath: EVIDENCE_PATH,
      resultPath: RESULT_PATH,
    });

    expect(build.blockedReasons).toEqual([]);
    expect(build.synthesisDowngraded).toBe(false);
    expect(build.result).toEqual(expected);
  });

  test("links provider_result ids and hashes back to browser evidence", async () => {
    const evidence = await loadGeminiEvidence();
    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: evidence.provider_result_id,
      accessPath: "oracle_browser_local",
      evidence,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.provider_family).toBe("gemini");
    expect(build.result.provider_slot).toBe(evidence.provider_slot);
    expect(build.result.provider_result_id).toBe(evidence.provider_result_id);
    expect(build.result.evidence_id).toBe(evidence.evidence_id);
    expect(build.result.result_text_sha256).toBe(evidence.output_text_sha256);
    expect(build.result.reasoning_effort).toBe("deep_think_highest_available");
    expect(build.result.reasoning_effort_verified).toBe(true);
    expect(build.result.synthesis_eligible).toBe(true);
  });
});

describe("normalizeGeminiRun — protected route failures", () => {
  test("rejects Gemini API substitution for gemini_deep_think", async () => {
    const evidence = await loadGeminiEvidence();
    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: evidence.provider_result_id,
      accessPath: "gemini_api",
      evidence,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.synthesisDowngraded).toBe(true);
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toContainEqual(
      expect.objectContaining({
        field: "provider_result.access_path",
        code: "gemini_deep_think_unverified",
      }),
    );
  });

  test("missing evidence produces schema-valid but ineligible result", async () => {
    const evidence = await loadGeminiEvidence();
    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: "provider-result-no-evidence",
      accessPath: "oracle_browser_remote",
      evidence: null,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.evidence).toBeNull();
    expect(build.result.evidence_id).toBeNull();
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "provider_result.evidence" }),
        expect.objectContaining({ field: "provider_result.evidence_id" }),
      ]),
    );
  });

  test("unverified evidence blocks synthesis eligibility", async () => {
    const evidence = await loadGeminiEvidence();
    const unverified = browserEvidenceSchema.parse({
      ...evidence,
      mode_verified: false,
      reasoning_effort_verified: false,
    }) as BrowserEvidence;

    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: unverified.provider_result_id,
      accessPath: "oracle_browser_remote",
      evidence: unverified,
      capture: capturedSummary(unverified.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.status).toBe("degraded");
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "browser_evidence.mode_verified",
          code: "gemini_deep_think_unverified",
        }),
        expect.objectContaining({
          field: "browser_evidence.reasoning_effort_verified",
          code: "gemini_deep_think_unverified",
        }),
      ]),
    );
  });

  test("prompt-before-verify evidence blocks with the typed v18 code", async () => {
    const evidence = await loadGeminiEvidence();
    const tainted = browserEvidenceSchema.parse({
      ...evidence,
      verified_before_prompt_submit: false,
    }) as BrowserEvidence;

    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: tainted.provider_result_id,
      accessPath: "oracle_browser_remote",
      evidence: tainted,
      capture: capturedSummary(tainted.output_text_sha256 as `sha256:${string}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toContainEqual(
      expect.objectContaining({
        field: "browser_evidence.verified_before_prompt_submit",
        code: "prompt_submitted_before_verification",
      }),
    );
  });
});

describe("normalizeGeminiRun — output and effort failures", () => {
  test("output hash mismatch blocks as output_capture_unverified", async () => {
    const evidence = await loadGeminiEvidence();
    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: evidence.provider_result_id,
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedSummary(`sha256:${"9".repeat(64)}`),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toContainEqual(
      expect.objectContaining({
        field: "provider_result.result_text_sha256",
        code: "output_capture_unverified",
      }),
    );
  });

  test("empty output capture fails loudly and marks result failed", async () => {
    const evidence = await loadGeminiEvidence();
    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: evidence.provider_result_id,
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`, {
        result_text_sha256: null,
        output_bytes: 0,
        confidence: "low",
        non_empty_candidate_count: 0,
      }),
      deepThink: verifiedDeepThink(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.status).toBe("failed");
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toContainEqual(
      expect.objectContaining({
        field: "provider_result.result_text_sha256",
        code: "output_capture_empty",
      }),
    );
  });

  test("unknown Deep Think effort blocks synthesis", async () => {
    const evidence = await loadGeminiEvidence();
    const unverified = verifyGeminiDeepThinkCandidate({
      deepThinkLabel: "",
      observedThinkingLevelLabels: [],
    });

    const build = normalizeGeminiRun({
      slot: "gemini_deep_think",
      providerResultId: evidence.provider_result_id,
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: unverified,
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.result.reasoning_effort_verified).toBe(false);
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.blockedReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "provider_result.reasoning_effort_verified",
          code: "gemini_deep_think_unverified",
        }),
        expect.objectContaining({
          field: "provider_result.observed_reasoning_effort_label",
          code: "gemini_deep_think_unverified",
        }),
      ]),
    );
  });
});

describe("normalizeGeminiRun — projection helpers", () => {
  test("capture and effort helpers preserve browser-layer provenance", async () => {
    const evidence = await loadGeminiEvidence();
    const capture = geminiCaptureToSummary(
      capturedSummary(evidence.output_text_sha256 as `sha256:${string}`),
    );
    const effort = geminiDeepThinkToEffortSummary(verifiedDeepThink());

    expect(capture).toMatchObject({
      status: "captured",
      outputTextSha256: evidence.output_text_sha256,
      captureConfidence: "high",
    });
    expect(effort).toMatchObject({
      status: "verified",
      observedReasoningEffortLabel: "Deep Think",
      selectedIsHighestVisible: true,
      thinkingLevelIfExposed: "high",
      thinkingLevelVerified: true,
    });
  });
});
