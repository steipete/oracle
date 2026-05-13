// v18 normalizer for Gemini Deep Think provider results.
//
// Pure contract layer: takes browser evidence + capture/effort summaries and
// emits a schema-valid provider_result.v1 that APR can consume without Gemini
// DOM internals.

import {
  PROVIDER_RESULT_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  providerResultSchema,
  type BrowserEvidence,
  type ProviderResult,
} from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";
import {
  PROTECTED_SLOT_UNVERIFIED_CODE,
  isOracleBrowserAccessPath,
} from "./provider_access_policy.js";

export type GeminiDeepThinkSlot = "gemini_deep_think";

export interface GeminiCaptureSummary {
  readonly status: "captured" | "empty" | "unverified" | "timeout";
  readonly outputTextSha256: `sha256:${string}` | null;
  readonly captureConfidence: "high" | "medium" | "low";
  readonly captureMethod?: string | null;
}

export interface GeminiEffortSummary {
  readonly status: "verified" | "unverified" | "ui_drift_suspected";
  readonly observedReasoningEffortLabel: string | null;
  readonly selectedIsHighestVisible: boolean;
  readonly thinkingLevelIfExposed?: string | null;
  readonly thinkingLevelVerified?: boolean | null;
}

export interface BuildGeminiProviderResultInput {
  readonly slot: GeminiDeepThinkSlot;
  readonly providerResultId: string;
  readonly accessPath: string;
  readonly evidence: BrowserEvidence | null;
  readonly capture: GeminiCaptureSummary;
  readonly effort: GeminiEffortSummary;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly evidencePath?: string | null;
  readonly resultPath?: string | null;
  readonly model?: string;
  readonly statusOverride?: ProviderResult["status"];
  readonly degradationReason?: string | null;
  readonly error?: Record<string, unknown> | null;
}

export interface GeminiBlockedReason {
  readonly code: V18ErrorCode | null;
  readonly field: string;
  readonly message: string;
}

export interface GeminiProviderResultBuild {
  readonly result: ProviderResult;
  readonly blockedReasons: readonly GeminiBlockedReason[];
  readonly synthesisDowngraded: boolean;
}

const GEMINI_UNVERIFIED_CODE = PROTECTED_SLOT_UNVERIFIED_CODE.gemini_deep_think;
const EMPTY_TEXT_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export function buildGeminiProviderResult(
  input: BuildGeminiProviderResultInput,
): GeminiProviderResultBuild {
  const blockedReasons: GeminiBlockedReason[] = [];
  const evidence = input.evidence;

  if (input.slot !== "gemini_deep_think") {
    blockedReasons.push(
      blocker(
        "provider_result.provider_slot",
        `slot "${String(input.slot)}" is not handled by the Gemini Deep Think normalizer`,
        GEMINI_UNVERIFIED_CODE,
      ),
    );
  }

  if (!isOracleBrowserAccessPath(input.accessPath)) {
    blockedReasons.push(
      blocker(
        "provider_result.access_path",
        `slot gemini_deep_think forbids API substitution; access_path "${input.accessPath}" must be oracle_browser_*`,
        GEMINI_UNVERIFIED_CODE,
      ),
    );
  }

  if (!evidence) {
    blockedReasons.push(
      blocker(
        "provider_result.evidence",
        "Gemini Deep Think result is missing browser evidence",
        GEMINI_UNVERIFIED_CODE,
      ),
      blocker(
        "provider_result.evidence_id",
        "Gemini Deep Think result is missing evidence_id",
        GEMINI_UNVERIFIED_CODE,
      ),
    );
  } else {
    if (evidence.provider !== "gemini") {
      blockedReasons.push(
        blocker(
          "browser_evidence.provider",
          `evidence.provider "${evidence.provider}" does not match Gemini`,
          GEMINI_UNVERIFIED_CODE,
        ),
      );
    }
    if (evidence.provider_slot !== input.slot) {
      blockedReasons.push(
        blocker(
          "browser_evidence.provider_slot",
          `evidence.provider_slot "${evidence.provider_slot}" does not match result slot "${input.slot}"`,
          GEMINI_UNVERIFIED_CODE,
        ),
      );
    }
    if (evidence.provider_result_id !== input.providerResultId) {
      blockedReasons.push(
        blocker(
          "browser_evidence.provider_result_id",
          `evidence.provider_result_id "${evidence.provider_result_id}" does not match result id "${input.providerResultId}"`,
          "output_capture_unverified",
        ),
      );
    }
    if (!evidence.mode_verified) {
      blockedReasons.push(
        blocker(
          "browser_evidence.mode_verified",
          "must be true for Gemini Deep Think",
          GEMINI_UNVERIFIED_CODE,
        ),
      );
    }
    if (!evidence.verified_before_prompt_submit) {
      blockedReasons.push(
        blocker(
          "browser_evidence.verified_before_prompt_submit",
          "must be true before Gemini prompt submission",
          "prompt_submitted_before_verification",
        ),
      );
    }
    if (!evidence.reasoning_effort_verified) {
      blockedReasons.push(
        blocker(
          "browser_evidence.reasoning_effort_verified",
          "Gemini Deep Think effort verification is missing",
          GEMINI_UNVERIFIED_CODE,
        ),
      );
    }
    if (!evidence.selected_effort_is_highest_visible) {
      blockedReasons.push(
        blocker(
          "browser_evidence.selected_effort_is_highest_visible",
          "Gemini Deep Think must select highest visible effort when exposed",
          GEMINI_UNVERIFIED_CODE,
        ),
      );
    }
  }

  if (input.capture.status !== "captured") {
    blockedReasons.push(
      input.capture.status === "empty"
        ? blocker(
            "provider_result.result_text_sha256",
            "output capture is empty",
            "output_capture_empty",
          )
        : blocker(
            "provider_result.result_text_sha256",
            `Gemini output capture is ${input.capture.status}`,
            "output_capture_unverified",
          ),
    );
  }

  if (!input.capture.outputTextSha256 && input.capture.status !== "empty") {
    blockedReasons.push(
      blocker(
        "provider_result.result_text_sha256",
        "no Gemini result text hash is available",
        "output_capture_unverified",
      ),
    );
  } else if (evidence && input.capture.outputTextSha256 !== evidence.output_text_sha256) {
    blockedReasons.push(
      blocker(
        "provider_result.result_text_sha256",
        "Gemini result text hash does not match browser evidence output_text_sha256",
        "output_capture_unverified",
      ),
    );
  }

  if (input.effort.status !== "verified") {
    blockedReasons.push(
      blocker(
        "provider_result.reasoning_effort_verified",
        input.effort.status === "ui_drift_suspected"
          ? "Gemini Deep Think selector drift suspected"
          : "Gemini Deep Think effort is unverified",
        input.effort.status === "ui_drift_suspected"
          ? "ui_drift_suspected"
          : GEMINI_UNVERIFIED_CODE,
      ),
    );
  }
  if (!input.effort.observedReasoningEffortLabel?.trim()) {
    blockedReasons.push(
      blocker(
        "provider_result.observed_reasoning_effort_label",
        "Gemini Deep Think requires a non-empty observed effort label",
        GEMINI_UNVERIFIED_CODE,
      ),
    );
  }
  if (!input.effort.selectedIsHighestVisible) {
    blockedReasons.push(
      blocker(
        "provider_result.selected_effort_is_highest_visible",
        "Gemini Deep Think selected effort is not highest visible",
        GEMINI_UNVERIFIED_CODE,
      ),
    );
  }

  const status =
    input.statusOverride ??
    (input.degradationReason ? "degraded" : deriveStatus(input.capture, input.effort, evidence));
  const synthesisDowngraded = blockedReasons.length > 0;
  const synthesisEligible = !synthesisDowngraded && status === "success";
  const resultTextSha256 =
    input.capture.outputTextSha256 ?? evidence?.output_text_sha256 ?? EMPTY_TEXT_SHA256;
  const thinkingLevel =
    input.effort.thinkingLevelIfExposed ?? evidence?.thinking_level_if_exposed ?? null;
  const observedLabel =
    input.effort.observedReasoningEffortLabel ?? evidence?.observed_reasoning_effort_label ?? null;

  const draft: Record<string, unknown> = {
    schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    provider_slot: input.slot,
    provider_family: "gemini",
    access_path: input.accessPath,
    status,
    synthesis_eligible: synthesisEligible,
    evidence: evidence ? summariseEvidence(evidence, input.evidencePath) : null,
    evidence_id: evidence?.evidence_id ?? null,
    prompt_manifest_sha256: input.promptManifestSha256,
    source_baseline_sha256: input.sourceBaselineSha256,
    provider_result_id: input.providerResultId,
    result_text_sha256: resultTextSha256,
    model: input.model ?? "gemini-3.1-pro-deep-think",
    reasoning_effort: "deep_think_highest_available",
    reasoning_effort_verified: input.effort.status === "verified",
    reasoning_config: buildReasoningConfig(input.effort, observedLabel, thinkingLevel),
    degradation_reason: input.degradationReason ?? null,
    error: input.error ?? null,
  };

  if (input.resultPath !== undefined) {
    draft.result_path = input.resultPath;
  }
  if (thinkingLevel) {
    draft.thinking_level_if_exposed = thinkingLevel;
  }

  return {
    result: providerResultSchema.parse(draft),
    blockedReasons,
    synthesisDowngraded,
  };
}

function deriveStatus(
  capture: GeminiCaptureSummary,
  effort: GeminiEffortSummary,
  evidence: BrowserEvidence | null,
): ProviderResult["status"] {
  if (capture.status === "empty") return "failed";
  if (capture.status === "unverified" || capture.status === "timeout") return "failed";
  if (!evidence) return "degraded";
  if (!evidence.mode_verified || !evidence.verified_before_prompt_submit) return "degraded";
  if (!evidence.reasoning_effort_verified || effort.status !== "verified") return "degraded";
  if (!evidence.selected_effort_is_highest_visible || !effort.selectedIsHighestVisible) {
    return "degraded";
  }
  return "success";
}

function buildReasoningConfig(
  effort: GeminiEffortSummary,
  observedLabel: string | null,
  thinkingLevel: string | null,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    browser_mode: "Deep Think",
    effort_rank: "deep_think_selected_and_highest_visible",
    observed_reasoning_effort_label: observedLabel ?? "",
    provider_nomenclature: "Gemini browser Deep Think plus highest thinking level if exposed",
    requested_reasoning_effort: "deep_think_highest_available",
    selected_effort_is_highest_visible: effort.selectedIsHighestVisible,
  };
  if (thinkingLevel) {
    config.api_equivalent_thinking_level = thinkingLevel;
  }
  return config;
}

function summariseEvidence(
  evidence: BrowserEvidence,
  evidencePath?: string | null,
): Record<string, unknown> {
  return {
    evidence_id: evidence.evidence_id,
    mode_verified: evidence.mode_verified,
    ...(evidencePath ? { path: evidencePath } : {}),
    verified_before_prompt_submit: evidence.verified_before_prompt_submit,
  };
}

function blocker(field: string, message: string, code: V18ErrorCode | null): GeminiBlockedReason {
  return { code, field, message };
}
