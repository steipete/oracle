// Browser-layer wrapper around the v18 Gemini Deep Think provider_result normalizer.

import type { BrowserEvidence } from "../../oracle/v18/contracts.js";
import {
  buildGeminiProviderResult,
  type BuildGeminiProviderResultInput,
  type GeminiBlockedReason,
  type GeminiCaptureSummary,
  type GeminiDeepThinkSlot,
  type GeminiEffortSummary,
  type GeminiProviderResultBuild,
} from "../../oracle/v18/gemini_provider_result.js";
import type { GeminiStreamCaptureSummary } from "../../gemini-web/streamSafeguards.js";
import type { GeminiDeepThinkVerificationResult } from "./geminiDeepThink_verification.js";

export {
  buildGeminiProviderResult,
  type BuildGeminiProviderResultInput,
  type GeminiBlockedReason,
  type GeminiCaptureSummary,
  type GeminiDeepThinkSlot,
  type GeminiEffortSummary,
  type GeminiProviderResultBuild,
};

export function geminiCaptureToSummary(capture: GeminiStreamCaptureSummary): GeminiCaptureSummary {
  const hasOutput = capture.output_bytes > 0 && capture.result_text_sha256 !== null;
  return {
    status: hasOutput ? "captured" : "empty",
    outputTextSha256: capture.result_text_sha256,
    captureConfidence: capture.confidence,
    captureMethod: capture.capture_method,
  };
}

export function geminiDeepThinkToEffortSummary(
  verdict: GeminiDeepThinkVerificationResult,
): GeminiEffortSummary {
  return {
    status: verdict.status,
    observedReasoningEffortLabel: verdict.deepThinkLabel ?? verdict.selected,
    selectedIsHighestVisible: verdict.selectedIsHighestVisible,
    thinkingLevelIfExposed: verdict.thinkingLevelControlExposed ? verdict.selected : null,
    thinkingLevelVerified: verdict.thinkingLevelVerified,
  };
}

export interface NormalizeGeminiRunInput {
  readonly slot: GeminiDeepThinkSlot;
  readonly providerResultId: string;
  readonly accessPath: string;
  readonly evidence: BrowserEvidence | null;
  readonly capture: GeminiStreamCaptureSummary;
  readonly deepThink: GeminiDeepThinkVerificationResult;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly evidencePath?: string | null;
  readonly resultPath?: string | null;
  readonly model?: string;
  readonly degradationReason?: string | null;
  readonly error?: Record<string, unknown> | null;
}

export function normalizeGeminiRun(input: NormalizeGeminiRunInput): GeminiProviderResultBuild {
  return buildGeminiProviderResult({
    slot: input.slot,
    providerResultId: input.providerResultId,
    accessPath: input.accessPath,
    evidence: input.evidence,
    capture: geminiCaptureToSummary(input.capture),
    effort: geminiDeepThinkToEffortSummary(input.deepThink),
    promptManifestSha256: input.promptManifestSha256,
    sourceBaselineSha256: input.sourceBaselineSha256,
    evidencePath: input.evidencePath,
    resultPath: input.resultPath,
    model: input.model,
    degradationReason: input.degradationReason,
    error: input.error,
  });
}
