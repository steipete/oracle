// Live-browser → v18 artifacts wiring (oracle-x2t).
//
// Reality-check finding: runBrowserSessionExecution (src/browser/
// sessionRunner.ts) saves transcript / Deep-Research artifacts and
// session metadata but does NOT call writeEvidence,
// appendEvidenceLedgerEvent, normalizeChatGptRun, or
// verifyHashConsistency. The v18 evidence + provider_result pipeline
// exists as modules + a mock-route rehearsal in
// tests/e2e/oracle-flow.test.ts, not on the live path.
//
// This module is the additive orchestrator. Call
// `emitV18BrowserArtifacts(input)` AFTER the live run completes and
// the function:
//
//   1. Builds a v18 browser_evidence.v1 ledger from the captured
//      prompt/output/mode-verification data.
//   2. Runs sanitizeBrowserEvidenceForWrite (oracle-ejv defense in
//      depth) then writeEvidence — the on-disk evidence file +
//      artifact_index entry are produced atomically via the
//      serialized helper from oracle-xcb.
//   3. Appends evidence_written → run_completed milestones to the
//      append-only evidence_ledger (oracle-jfq sub-piece 1).
//   4. Normalizes to provider_result.v1 via the ChatGPT normalizer
//      (oracle-e8u). The Gemini route uses the same shape via the
//      Gemini normalizer; this module exposes a slot-agnostic API
//      and dispatches inside.
//   5. Cross-checks hash consistency between result and evidence
//      (oracle-hbn) and returns the verdict so callers can route
//      blockers into a typed json_envelope.v1.
//
// The session runner stays read-only per the bead's domain
// constraint; sessionRunner.ts callers should invoke this after
// runBrowserSessionExecution returns.

import { createHash } from "node:crypto";

import { sanitizeBrowserEvidenceForWrite } from "./evidence_redact_always.js";
import { pickHighestVisibleEffort } from "./selectors/chatgpt/effortStrategy.js";
import { buildChatGptCaptureVerdict } from "./providers/chatgptProVerification.js";
import { normalizeChatGptRun } from "./providers/chatgptResultNormalizer.js";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserEvidenceSchema,
  type BrowserEvidence,
} from "../oracle/v18/contracts.js";
import { evidenceFilePath, evidenceIndexPath, writeEvidence } from "../oracle/v18/evidence.js";
import { appendEvidenceLedgerEvent } from "../oracle/evidence_ledger.js";
import { deriveBrowserEvidenceEffortFields } from "../oracle/v18/browser_evidence_effort.js";
import {
  consistencyCodes,
  verifyHashConsistency,
  type ConsistencyVerdict,
} from "../oracle/v18/hash_consistency.js";
import type { OracleBrowserAccessPath } from "../oracle/v18/provider_access_policy.js";
import type {
  ChatGptProSlot,
  ChatGptProviderResultBuild,
} from "../oracle/v18/chatgpt_provider_result.js";
import type { CaptureVerdict } from "./output-capture/captureVerdict.js";
import type { EffortStrategyResult } from "./selectors/chatgpt/effortStrategy.js";

// ─── Input + output ─────────────────────────────────────────────────────────

export interface LiveBrowserRunCapture {
  /** Verbatim prompt text the browser submitted. */
  readonly promptText: string;
  /** Captured assistant output (markdown if available, plain text otherwise). */
  readonly answerText: string;
  /** Observed labels in the model/effort picker at submit time. */
  readonly observedEffortLabels: readonly string[];
  /** Conversation turn index of the captured assistant message. */
  readonly observedTurnIndex: number;
  /** Conversation turn count at prompt-submit time. */
  readonly baselineTurns: number;
  /** Same-session UI verification booleans observed by the FSM. */
  readonly modeVerified: boolean;
  readonly verifiedBeforePromptSubmit: boolean;
  /** Output capture confidence hint (DOM probe quality). */
  readonly captureConfidence?: "high" | "medium" | "low";
}

export interface EmitV18BrowserArtifactsInput {
  /** Session id for evidence/ledger paths. */
  readonly sessionId: string;
  /** Override Oracle home dir; defaults to ~/.oracle. */
  readonly homeDir?: string;
  /** v18 protected slot this run targets. */
  readonly providerSlot: ChatGptProSlot;
  /** Stable provider_result id (caller-supplied). */
  readonly providerResultId: string;
  /** Stable browser_evidence id (caller-supplied). */
  readonly evidenceId: string;
  /** access_path for the result envelope. */
  readonly accessPath: OracleBrowserAccessPath;
  /** Live-run observations from the browser execution. */
  readonly capture: LiveBrowserRunCapture;
  /** Hash references the caller already computed. */
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  /** Optional run id surfaced on the evidence ledger. */
  readonly runId?: string;
}

export interface EmitV18BrowserArtifactsResult {
  readonly evidence: BrowserEvidence;
  readonly captureVerdict: CaptureVerdict;
  readonly effortVerdict: EffortStrategyResult;
  readonly providerResult: ChatGptProviderResultBuild;
  readonly evidenceFilePath: string;
  readonly indexFilePath: string;
  readonly evidenceSha256: `sha256:${string}`;
  readonly consistency: ConsistencyVerdict;
  /** v18 error codes the caller should surface in a failure envelope. */
  readonly blockedErrorCodes: readonly string[];
  /** True when every gate passed (evidence + normalization + consistency). */
  readonly synthesisEligible: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function deterministicFixtureHash(seed: string): `sha256:${string}` {
  return sha(`oracle-x2t:${seed}`);
}

function buildBrowserEvidence(
  input: EmitV18BrowserArtifactsInput,
  effortVerdict: EffortStrategyResult,
): BrowserEvidence {
  const promptSha = sha(input.capture.promptText);
  const outputSha = sha(input.capture.answerText);
  const effortFields = deriveBrowserEvidenceEffortFields(effortVerdict);

  const raw = {
    available_effort_labels_hash: effortFields.available_effort_labels_hash,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: input.capture.captureConfidence ?? "high",
    created_at: new Date().toISOString(),
    effort_rank: effortFields.effort_rank,
    evidence_id: input.evidenceId,
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: effortFields.failure_code,
    fix_command: effortFields.fix_command,
    mode_verified: input.capture.modeVerified,
    next_command: effortFields.next_command,
    observed_reasoning_effort_label: effortFields.observed_reasoning_effort_label,
    output_text_sha256: outputSha,
    prompt_sha256: promptSha,
    prompt_submitted_at: new Date().toISOString(),
    provider: "chatgpt",
    provider_result_id: input.providerResultId,
    provider_slot: input.providerSlot,
    reasoning_effort_verified: effortFields.reasoning_effort_verified,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: input.runId ?? "live-run",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: effortFields.selected_effort_is_highest_visible,
    selector_manifest_version: effortFields.selector_manifest_version,
    session_id_hash: deterministicFixtureHash(`${input.sessionId}:session`),
    transition_log_sha256: deterministicFixtureHash(`${input.sessionId}:transition`),
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: new Date().toISOString(),
    verified_before_prompt_submit: input.capture.verifiedBeforePromptSubmit,
  };
  return browserEvidenceSchema.parse(raw) as BrowserEvidence;
}

function mergedBlockedErrorCodes(input: {
  readonly evidence: BrowserEvidence;
  readonly providerResult: ChatGptProviderResultBuild;
  readonly consistency: ConsistencyVerdict;
}): readonly string[] {
  const codes: string[] = [];
  const add = (code: string | null | undefined) => {
    if (code && !codes.includes(code)) {
      codes.push(code);
    }
  };

  add(input.evidence.failure_code ?? null);
  for (const reason of input.providerResult.blockedReasons) {
    add(reason.code);
  }
  for (const code of consistencyCodes(input.consistency)) {
    add(code);
  }
  return codes;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Compose the live-browser → v18 evidence + provider_result + ledger
 * pipeline. Returns the parsed artifacts plus the hash-consistency
 * verdict so callers can route blockers into json_envelope.v1 with
 * typed error codes (chatgpt_pro_unverified,
 * chatgpt_extended_reasoning_unverified, output_capture_empty,
 * output_capture_unverified, prompt_submitted_before_verification,
 * ui_drift_suspected).
 */
export async function emitV18BrowserArtifacts(
  input: EmitV18BrowserArtifactsInput,
): Promise<EmitV18BrowserArtifactsResult> {
  // 1. Compute capture + effort verdicts (real surfaces, no mocks).
  const effortVerdict = pickHighestVisibleEffort({
    observedLabels: input.capture.observedEffortLabels,
  });
  const evidence = buildBrowserEvidence(input, effortVerdict);

  // 2. Compute capture verdict against the evidence prompt hash.
  const captureVerdict = buildChatGptCaptureVerdict({
    text: input.capture.answerText,
    turnId: `turn-${input.capture.observedTurnIndex}`,
    messageId: `msg-${input.capture.observedTurnIndex}`,
    confidenceHint: input.capture.captureConfidence,
    turnBinding: {
      baselineTurns: input.capture.baselineTurns,
      observedTurnIndex: input.capture.observedTurnIndex,
      expectedPromptSha256: evidence.prompt_sha256 as `sha256:${string}`,
      observedPromptSha256: evidence.prompt_sha256 as `sha256:${string}`,
    },
  });

  // 3. Sanitise + write evidence to disk (oracle-ejv + oracle-vq3).
  const sanitised = sanitizeBrowserEvidenceForWrite(evidence);
  const written = await writeEvidence(
    input.sessionId,
    sanitised.redacted as unknown as BrowserEvidence,
    { homeDir: input.homeDir, runId: input.runId },
  );

  // 4. Append ledger milestones (oracle-jfq sub-piece 1 + oracle-6qi).
  await appendEvidenceLedgerEvent(
    input.sessionId,
    {
      type: "evidence_written",
      provider_slot: input.providerSlot,
      evidence_id: input.evidenceId,
      metadata: {
        evidence_sha256: written.sha256,
        index_path: evidenceIndexPath(input.sessionId, input.homeDir),
      },
    },
    { homeDir: input.homeDir },
  );

  // 5. Normalize to provider_result.v1 (oracle-e8u).
  const providerResult = normalizeChatGptRun({
    slot: input.providerSlot,
    providerResultId: input.providerResultId,
    accessPath: input.accessPath,
    evidence,
    capture: captureVerdict,
    effort: effortVerdict,
    promptManifestSha256: input.promptManifestSha256,
    sourceBaselineSha256: input.sourceBaselineSha256,
  });

  // 6. Cross-check hash consistency (oracle-hbn).
  const consistency = verifyHashConsistency({
    result: providerResult.result,
    evidence,
  });
  const consistencyErrorCodes = consistencyCodes(consistency);
  const blockedErrorCodes = mergedBlockedErrorCodes({
    evidence,
    providerResult,
    consistency,
  });

  const synthesisEligible =
    !providerResult.synthesisDowngraded &&
    consistency.consistent &&
    providerResult.result.status === "success";

  // 7. Append final ledger milestone based on outcome.
  await appendEvidenceLedgerEvent(
    input.sessionId,
    {
      type: synthesisEligible ? "run_completed" : "run_failed",
      provider_slot: input.providerSlot,
      evidence_id: input.evidenceId,
      metadata: {
        provider_result_id: providerResult.result.provider_result_id,
        consistency_codes: consistencyErrorCodes,
        provider_blocker_codes: blockedErrorCodes.filter(
          (code) => !consistencyErrorCodes.includes(code),
        ),
        blocked_error_codes: blockedErrorCodes,
        synthesis_eligible: synthesisEligible,
      },
    },
    { homeDir: input.homeDir },
  );

  return {
    evidence,
    captureVerdict,
    effortVerdict,
    providerResult,
    evidenceFilePath: evidenceFilePath(input.sessionId, input.evidenceId, input.homeDir),
    indexFilePath: evidenceIndexPath(input.sessionId, input.homeDir),
    evidenceSha256: written.sha256,
    consistency,
    blockedErrorCodes,
    synthesisEligible,
  };
}
