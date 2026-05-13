// v18 normalizer for ChatGPT provider results (oracle-e8u).
//
// Takes the evidence ledger + capture verdict + auxiliary hashes that
// Oracle's ChatGPT browser path produces, and emits a strict
// `provider_result.v1` object the upstream APR layer can consume
// without knowing anything about DOM selectors or browser internals.
//
// The normalizer is a pure function. It does NOT side-effect (no disk,
// no network, no env reads). All inputs are plain values; the output is
// the parsed ProviderResult plus a `BlockedReason[]` list explaining
// every eligibility downgrade.

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
  isProtectedSlot,
  type OracleBrowserAccessPath,
} from "./provider_access_policy.js";

// ─── Slot taxonomy ───────────────────────────────────────────────────────────

/** ChatGPT-Pro protected slots this normalizer handles. */
export type ChatGptProSlot = "chatgpt_pro_first_plan" | "chatgpt_pro_synthesis";

const CHATGPT_PRO_SLOTS: readonly ChatGptProSlot[] = Object.freeze([
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
]);

export function isChatGptProSlot(value: unknown): value is ChatGptProSlot {
  return typeof value === "string" && CHATGPT_PRO_SLOTS.includes(value as ChatGptProSlot);
}

// ─── Shared types ────────────────────────────────────────────────────────────

export interface NormalizerCaptureSummary {
  /** Capture status from oracle-qfl `CaptureVerdict`. */
  readonly status: "captured" | "partial" | "empty" | "stale_turn" | "background_pending" | "needs_reattach";
  /** sha256 of captured text bytes (null when nothing was captured). */
  readonly outputTextSha256: `sha256:${string}` | null;
  /** Whether markdown structure was preserved in the capture. */
  readonly markdownPreserved: boolean;
  /** Confidence tier from `CaptureVerdict`. */
  readonly captureConfidence: "high" | "medium" | "low";
}

export interface NormalizerEffortSummary {
  /** Whether the highest-visible effort strategy verified the picker. */
  readonly status: "verified" | "unverified" | "ui_drift_suspected";
  /** sha256 of sorted observed labels — pinned on the result via reasoning_config. */
  readonly availableEffortLabelsHash: `sha256:${string}`;
  /** Selected canonical tier (e.g. "heavy"); null on unverified/drift. */
  readonly tier: string | null;
  /** Observed verbatim label that was selected; null on failure. */
  readonly selected: string | null;
  /** Selector manifest version (chatgpt-selectors.v1). */
  readonly selectorManifestVersion: string;
  /** True iff the verified selection was the highest visible. */
  readonly selectedIsHighestVisible: boolean;
}

export interface BuildChatGptProviderResultInput {
  readonly slot: ChatGptProSlot;
  readonly providerResultId: string;
  readonly accessPath: OracleBrowserAccessPath;
  readonly evidence: BrowserEvidence;
  readonly capture: NormalizerCaptureSummary;
  readonly effort: NormalizerEffortSummary;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  /** Optional on-disk path; appears on `result_path`. */
  readonly resultPath?: string;
  /** Model identifier — defaults to "chatgpt-pro-latest". */
  readonly model?: string;
  /**
   * Optional override for `status`. The normalizer derives this from
   * capture + effort + evidence by default; callers only need this for
   * explicit degradation / failure surfaces.
   */
  readonly statusOverride?: ProviderResult["status"];
  /**
   * Optional degradation reason. When provided, status is forced to
   * "degraded" unless `statusOverride` also names a different status.
   */
  readonly degradationReason?: string;
  /**
   * Optional error envelope payload (e.g. a json_envelope.v1 errors[]
   * entry). When provided, the normalizer downgrades synthesis
   * eligibility to false but still emits the parsed result so callers
   * can hand the artifact to APR for human review.
   */
  readonly error?: Record<string, unknown>;
}

export interface BlockedReason {
  /** v18 error code, when one applies. */
  code: V18ErrorCode | null;
  /** Dotted field path (e.g. `provider_result.synthesis_eligible`). */
  field: string;
  message: string;
}

export interface ChatGptProviderResultBuild {
  /** The parsed v18 provider_result.v1 object. */
  readonly result: ProviderResult;
  /** Every blocker the normalizer detected. Empty when fully eligible. */
  readonly blockedReasons: readonly BlockedReason[];
  /** True when synthesis_eligible was forced false by a blocker. */
  readonly synthesisDowngraded: boolean;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function blocker(
  field: string,
  message: string,
  code: V18ErrorCode | null = null,
): BlockedReason {
  return { code, field, message };
}

function deriveStatus(
  capture: NormalizerCaptureSummary,
  effort: NormalizerEffortSummary,
  evidence: BrowserEvidence,
): ProviderResult["status"] {
  if (capture.status === "empty") return "failed";
  if (capture.status === "stale_turn") return "failed";
  if (capture.status === "needs_reattach") return "degraded";
  if (capture.status === "partial" || capture.status === "background_pending") return "degraded";
  if (capture.status === "captured") {
    if (effort.status !== "verified") return "degraded";
    if (!evidence.mode_verified) return "degraded";
    if (!evidence.verified_before_prompt_submit) return "degraded";
    return "success";
  }
  return "failed";
}

// ─── Public normalizer ───────────────────────────────────────────────────────

/**
 * Build a v18 `provider_result.v1` from typed inputs. Returns the
 * parsed result plus the blocker list explaining any eligibility
 * downgrade.
 *
 * Synthesis eligibility rules (encoded here, matching oracle-cv6 +
 * oracle-hbn):
 *
 *   1. provider_slot must be a known ChatGPT-Pro slot.
 *   2. access_path must be one of `oracle_browser_*` — never an API path.
 *   3. evidence.provider_slot must match the result's provider_slot.
 *   4. evidence.evidence_id must match the result's evidence_id.
 *   5. capture.status must be "captured".
 *   6. effort.status must be "verified" AND selectedIsHighestVisible.
 *   7. evidence.mode_verified === true.
 *   8. evidence.verified_before_prompt_submit === true.
 *
 * Any violation forces `synthesis_eligible = false` and records a
 * blocker with the appropriate v18 error code. Even when ineligible,
 * the normalizer still emits a schema-valid result so APR can route it
 * to a human review packet.
 */
export function buildChatGptProviderResult(
  input: BuildChatGptProviderResultInput,
): ChatGptProviderResultBuild {
  const blockedReasons: BlockedReason[] = [];
  const slot = input.slot;
  const protectedCode = isProtectedSlot(slot) ? PROTECTED_SLOT_UNVERIFIED_CODE[slot] : null;

  // Rule 1: slot whitelist.
  if (!isChatGptProSlot(slot)) {
    blockedReasons.push(
      blocker(
        "provider_result.provider_slot",
        `slot "${String(slot)}" is not a ChatGPT-Pro slot this normalizer handles`,
        protectedCode,
      ),
    );
  }

  // Rule 2: access_path whitelist.
  if (!isOracleBrowserAccessPath(input.accessPath)) {
    blockedReasons.push(
      blocker(
        "provider_result.access_path",
        `slot ${slot} forbids API substitution; access_path "${input.accessPath}" must be one of oracle_browser_*`,
        protectedCode,
      ),
    );
  }

  // Rule 3 + 4: evidence linkage.
  if (input.evidence.provider_slot !== slot) {
    blockedReasons.push(
      blocker(
        "browser_evidence.provider_slot",
        `evidence.provider_slot "${input.evidence.provider_slot}" does not match result slot "${slot}"`,
        protectedCode,
      ),
    );
  }

  // Rule 5: capture status.
  if (input.capture.status !== "captured") {
    if (input.capture.status === "empty") {
      blockedReasons.push(
        blocker("provider_result.result_text_sha256", "output capture is empty", "output_capture_empty"),
      );
    } else if (input.capture.status === "stale_turn") {
      blockedReasons.push(
        blocker(
          "provider_result.result_text_sha256",
          "output capture matched a stale assistant turn",
          "output_capture_unverified",
        ),
      );
    } else {
      blockedReasons.push(
        blocker(
          "provider_result.synthesis_eligible",
          `capture status "${input.capture.status}" is not eligible for synthesis`,
          "output_capture_unverified",
        ),
      );
    }
  }

  // Rule 6: effort verification.
  if (input.effort.status !== "verified") {
    if (input.effort.status === "ui_drift_suspected") {
      blockedReasons.push(
        blocker("provider_result.reasoning_effort_verified", input.effort.status, "ui_drift_suspected"),
      );
    } else {
      blockedReasons.push(
        blocker(
          "provider_result.reasoning_effort_verified",
          "effort verdict is unverified",
          "chatgpt_extended_reasoning_unverified",
        ),
      );
    }
  } else if (!input.effort.selectedIsHighestVisible) {
    blockedReasons.push(
      blocker(
        "provider_result.reasoning_config",
        "effort verdict was verified but not highest-visible",
        "chatgpt_extended_reasoning_unverified",
      ),
    );
  }

  // Rule 7 + 8: evidence verification booleans.
  if (!input.evidence.mode_verified) {
    blockedReasons.push(
      blocker("browser_evidence.mode_verified", "must be true for protected slot", protectedCode),
    );
  }
  if (!input.evidence.verified_before_prompt_submit) {
    blockedReasons.push(
      blocker(
        "browser_evidence.verified_before_prompt_submit",
        "must be true to avoid prompt_submitted_before_verification",
        "prompt_submitted_before_verification",
      ),
    );
  }

  // Result text hash — must be present when capture succeeded.
  const resultTextSha = input.capture.outputTextSha256;
  if (!resultTextSha) {
    blockedReasons.push(
      blocker(
        "provider_result.result_text_sha256",
        "no output text hash available — capture did not complete",
        "output_capture_unverified",
      ),
    );
  }

  const status: ProviderResult["status"] =
    input.statusOverride ??
    (input.degradationReason ? "degraded" : deriveStatus(input.capture, input.effort, input.evidence));
  const synthesisDowngraded = blockedReasons.length > 0;
  const synthesis_eligible = !synthesisDowngraded && status === "success";

  const reasoningConfig: Record<string, unknown> = {
    effort_rank: "highest_visible",
    model_selector: "Pro",
    normalized_effort: "max_browser_available",
    requested_reasoning_effort: "max_browser_available",
    selected_effort_is_highest_visible: input.effort.selectedIsHighestVisible,
    available_effort_labels_hash: input.effort.availableEffortLabelsHash,
    selector_manifest_version: input.effort.selectorManifestVersion,
    provider_nomenclature: "ChatGPT browser model-picker highest visible thinking effort",
  };
  if (input.effort.tier) reasoningConfig.canonical_effort_tier = input.effort.tier;
  if (input.effort.selected) reasoningConfig.observed_reasoning_effort_label = input.effort.selected;

  const draft: Record<string, unknown> = {
    schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    provider_slot: slot,
    provider_family: "chatgpt",
    access_path: input.accessPath,
    status,
    synthesis_eligible,
    evidence: summariseEvidence(input.evidence),
    evidence_id: input.evidence.evidence_id,
    prompt_manifest_sha256: input.promptManifestSha256,
    source_baseline_sha256: input.sourceBaselineSha256,
    provider_result_id: input.providerResultId,
    result_text_sha256: resultTextSha ?? input.evidence.output_text_sha256,
    model: input.model ?? "chatgpt-pro-latest",
    reasoning_effort: "max_browser_available",
    reasoning_effort_verified: input.effort.status === "verified",
    reasoning_config: reasoningConfig,
    degradation_reason: input.degradationReason ?? null,
    error: input.error ?? null,
  };
  if (input.resultPath !== undefined) {
    draft.result_path = input.resultPath;
  }

  const parsed = providerResultSchema.parse(draft);
  return {
    result: parsed,
    blockedReasons,
    synthesisDowngraded,
  };
}

/**
 * Compact view of the evidence ledger Oracle attaches to the
 * provider_result. Matches the shape of the canonical plan-bundle
 * fixture (`fixtures/provider-result.chatgpt.json`).
 */
function summariseEvidence(evidence: BrowserEvidence): Record<string, unknown> {
  return {
    evidence_id: evidence.evidence_id,
    mode_verified: evidence.mode_verified,
    verified_before_prompt_submit: evidence.verified_before_prompt_submit,
  };
}
