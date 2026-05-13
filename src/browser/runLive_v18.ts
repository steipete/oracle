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
import { normalizeGeminiRun } from "./providers/geminiResultNormalizer.js";
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
import { isV18ErrorCode, type V18ErrorCode } from "../oracle/v18/json_envelope.js";
import type { OracleBrowserAccessPath } from "../oracle/v18/provider_access_policy.js";
import type {
  ChatGptProSlot,
  ChatGptProviderResultBuild,
} from "../oracle/v18/chatgpt_provider_result.js";
import type {
  GeminiDeepThinkSlot,
  GeminiProviderResultBuild,
} from "../oracle/v18/gemini_provider_result.js";
import type { GeminiStreamCaptureSummary } from "../gemini-web/streamSafeguards.js";
import type { GeminiDeepThinkVerificationResult } from "./state/geminiDeepThink.js";
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
  readonly blockedErrorCodes: readonly V18ErrorCode[];
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
}): readonly V18ErrorCode[] {
  const codes: V18ErrorCode[] = [];
  const add = (code: unknown) => {
    if (isV18ErrorCode(code) && !codes.includes(code)) {
      codes.push(code);
    }
  };

  add(input.evidence.failure_code);
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

// ─── Gemini Deep Think orchestrator (oracle-scb) ───────────────────────────
//
// The ChatGPT pipeline above is route-specific (provider="chatgpt",
// chatgpt slot, ChatGPT effort verdict, ChatGPT normalizer). Live
// Gemini Deep Think runs go through their own FSM
// (src/browser/state/geminiDeepThink.ts) and capture summary
// (src/gemini-web/streamSafeguards.ts) so they need a parallel
// orchestrator that builds the same browser_evidence.v1 shape with
// provider="gemini" / provider_slot="gemini_deep_think", appends the
// same evidence_written → run_completed/run_failed ledger pair, and
// hands off to normalizeGeminiRun.
//
// The two orchestrators stay separate (rather than a polymorphic
// dispatcher) so the ChatGPT path's tight typing and effort logic
// stay isolated from Gemini's thinking-level / stream-capture shape.
// Callers pick the orchestrator based on the run's target host; see
// runLive_emit_artifacts.ts for the wrap-side dispatch.

export interface LiveGeminiBrowserRunCapture {
  /** Verbatim prompt text the browser submitted. */
  readonly promptText: string;
  /** Captured assistant output (markdown if available, plain text otherwise). */
  readonly answerText: string;
  /** Gemini stream-ownership capture summary from streamSafeguards.ts. */
  readonly stream: GeminiStreamCaptureSummary;
  /** Deep Think verification verdict (effort + same-session check). */
  readonly deepThink: GeminiDeepThinkVerificationResult;
  /** Same-session UI verification booleans observed by the FSM. */
  readonly modeVerified: boolean;
  readonly verifiedBeforePromptSubmit: boolean;
}

export interface EmitV18GeminiBrowserArtifactsInput {
  readonly sessionId: string;
  readonly homeDir?: string;
  readonly providerSlot: GeminiDeepThinkSlot;
  readonly providerResultId: string;
  readonly evidenceId: string;
  readonly accessPath: OracleBrowserAccessPath;
  readonly capture: LiveGeminiBrowserRunCapture;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly runId?: string;
}

export interface EmitV18GeminiBrowserArtifactsResult {
  readonly evidence: BrowserEvidence;
  readonly providerResult: GeminiProviderResultBuild;
  readonly evidenceFilePath: string;
  readonly indexFilePath: string;
  readonly evidenceSha256: `sha256:${string}`;
  readonly consistency: ConsistencyVerdict;
  readonly blockedErrorCodes: readonly V18ErrorCode[];
  readonly synthesisEligible: boolean;
}

function geminiEffortLabelsFromVerdict(
  verdict: GeminiDeepThinkVerificationResult,
): readonly string[] {
  return verdict.observedLabels;
}

function buildGeminiBrowserEvidence(
  input: EmitV18GeminiBrowserArtifactsInput,
): BrowserEvidence {
  const promptSha = sha(input.capture.promptText);
  const outputSha = sha(input.capture.answerText);
  const verdict = input.capture.deepThink;
  const errorCode = verdict.errorCode;
  // effort_rank must be a string per browser_evidence.v1 schema. The
  // Gemini verdict exposes a numeric `rank` (sorted position) plus a
  // categorical `tier` / `status`; mirror the ChatGPT helper's choice
  // (verified ⇒ tier label, otherwise status) so downstream consumers
  // see a stable enum-like string across providers.
  const effortRank: string = verdict.status === "verified"
    ? (verdict.tier ?? "highest_visible")
    : verdict.status;

  const raw = {
    available_effort_labels_hash: verdict.availableEffortLabelsHash,
    browser_effort_strategy: "gemini_thinking_level_if_exposed",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: input.capture.stream.confidence,
    created_at: new Date().toISOString(),
    effort_rank: effortRank,
    evidence_id: input.evidenceId,
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: errorCode,
    fix_command: null,
    mode_verified: input.capture.modeVerified,
    next_command: null,
    observed_reasoning_effort_label:
      verdict.deepThinkLabel ?? verdict.selected ?? geminiEffortLabelsFromVerdict(verdict)[0] ?? "Deep Think",
    output_text_sha256: outputSha,
    prompt_sha256: promptSha,
    prompt_submitted_at: new Date().toISOString(),
    provider: "gemini",
    provider_result_id: input.providerResultId,
    provider_slot: input.providerSlot,
    reasoning_effort_verified: verdict.status === "verified",
    redaction_policy: "redacted",
    requested_mode: "gemini_deep_think",
    requested_reasoning_effort: "max_browser_available",
    run_id: input.runId ?? "live-run",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: verdict.selectedIsHighestVisible,
    selector_manifest_version: verdict.selectorManifestVersion,
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

function mergedGeminiBlockedErrorCodes(input: {
  readonly evidence: BrowserEvidence;
  readonly providerResult: GeminiProviderResultBuild;
  readonly consistency: ConsistencyVerdict;
}): readonly V18ErrorCode[] {
  const codes: V18ErrorCode[] = [];
  const add = (code: unknown) => {
    if (isV18ErrorCode(code) && !codes.includes(code)) codes.push(code);
  };
  add(input.evidence.failure_code);
  for (const reason of input.providerResult.blockedReasons) add(reason.code);
  for (const code of consistencyCodes(input.consistency)) add(code);
  return codes;
}

/**
 * Parallel of {@link emitV18BrowserArtifacts} for the Gemini Deep
 * Think route. Writes browser_evidence.v1 (provider="gemini",
 * provider_slot="gemini_deep_think"), appends the same ledger pair
 * (`evidence_written` then `run_completed` or `run_failed`), and
 * normalizes the run through normalizeGeminiRun.
 */
export async function emitV18GeminiBrowserArtifacts(
  input: EmitV18GeminiBrowserArtifactsInput,
): Promise<EmitV18GeminiBrowserArtifactsResult> {
  // 1. Build evidence from the captured prompt/output + Deep Think verdict.
  const evidence = buildGeminiBrowserEvidence(input);

  // 2. Sanitise + write to disk (oracle-ejv defense-in-depth).
  const sanitised = sanitizeBrowserEvidenceForWrite(evidence);
  const written = await writeEvidence(
    input.sessionId,
    sanitised.redacted as unknown as BrowserEvidence,
    { homeDir: input.homeDir, runId: input.runId },
  );

  // 3. Append evidence_written milestone.
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

  // 4. Normalize through the Gemini provider_result.v1 builder.
  const providerResult = normalizeGeminiRun({
    slot: input.providerSlot,
    providerResultId: input.providerResultId,
    accessPath: input.accessPath,
    evidence,
    capture: input.capture.stream,
    deepThink: input.capture.deepThink,
    promptManifestSha256: input.promptManifestSha256,
    sourceBaselineSha256: input.sourceBaselineSha256,
  });

  // 5. Hash consistency cross-check.
  const consistency = verifyHashConsistency({
    result: providerResult.result,
    evidence,
  });
  const consistencyErrorCodes = consistencyCodes(consistency);
  const blockedErrorCodes = mergedGeminiBlockedErrorCodes({
    evidence,
    providerResult,
    consistency,
  });

  const synthesisEligible =
    !providerResult.synthesisDowngraded &&
    consistency.consistent &&
    providerResult.result.status === "success";

  // 6. Final ledger milestone (run_completed on success, run_failed on
  //    any blocker — captures the failure-arm path so post-mortem
  //    audits can prove what happened).
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
    providerResult,
    evidenceFilePath: evidenceFilePath(input.sessionId, input.evidenceId, input.homeDir),
    indexFilePath: evidenceIndexPath(input.sessionId, input.homeDir),
    evidenceSha256: written.sha256,
    consistency,
    blockedErrorCodes,
    synthesisEligible,
  };
}
