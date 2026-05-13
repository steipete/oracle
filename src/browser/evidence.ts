// Browser evidence builder — the single place that constructs
// `browser_evidence.v1` objects with real SHA-256 hash provenance.
//
// Per oracle-0c4: centralize hashing so every SHA-256 value is a full
// `sha256:<64 hex>` string, verify timestamp ordering, and refuse to emit
// success-claiming evidence when verification happened after prompt
// submission or when any required field is missing.
//
// Storage and redaction live in `src/oracle/v18/evidence.ts`; this module
// only constructs the typed object so the writer can persist it.

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  assertRealHash,
  browserEvidenceSchema,
  sha256OfBytes,
  type BrowserEvidence,
} from "../oracle/v18/index.js";

export type BrowserEvidenceProvider = "chatgpt" | "gemini";
export type BrowserEvidenceVerificationMethod =
  | "same_session_ui_observation"
  | "same_session_ui_observation_plus_selector_trace";
export type BrowserEvidenceCaptureConfidence = "high" | "medium" | "low";
export type BrowserEvidenceRedactionPolicy = "redacted" | "off" | "unsafe_debug";

/** Bytes-or-prehashed input for fields where a caller may legitimately ship either. */
export type HashableInput =
  | { readonly bytes: string | Uint8Array }
  | { readonly precomputedHash: string };

export interface BuildBrowserEvidenceInput {
  // Identity
  readonly evidence_id: string;
  readonly run_id: string;
  readonly provider: BrowserEvidenceProvider;
  readonly provider_slot: string;
  readonly provider_result_id: string;

  // Verification state
  readonly requested_mode: string;
  readonly mode_verified: boolean;
  readonly verified_before_prompt_submit: boolean;
  readonly reasoning_effort_verified: boolean;
  readonly unsafe_artifacts_quarantined: boolean;

  // Timestamps (ISO-8601 strings)
  readonly verified_at: string;
  readonly prompt_submitted_at: string;
  readonly created_at?: string;

  // Verification metadata
  readonly verification_method: BrowserEvidenceVerificationMethod;
  readonly verification_scope: string;
  readonly capture_confidence: BrowserEvidenceCaptureConfidence;
  readonly redaction_policy?: BrowserEvidenceRedactionPolicy;

  // Bytes & hashes
  readonly promptBytes: string | Uint8Array;
  readonly outputBytes: string | Uint8Array;
  readonly transition_log: HashableInput;
  readonly available_effort_labels: readonly string[] | HashableInput;
  readonly session_id_hash: string; // pre-computed by caller (session id is sensitive)
  readonly observed_mode_label?: string; // hashed by us when provided

  // Selector / strategy metadata
  readonly selector_manifest_version: string;
  readonly requested_reasoning_effort: string;
  readonly observed_reasoning_effort_label: string;
  readonly effort_rank: string;
  readonly selected_effort_is_highest_visible: boolean;
  readonly browser_effort_strategy: string;

  // Optional v18 extension surfaces
  readonly evidence_privacy?: Record<string, unknown>;
  readonly thinking_level_if_exposed?: string;
  readonly thinking_level_verified?: boolean;
  readonly reasoning_effort_verification_method?: string;
  readonly failure_code?: string | null;
  readonly fix_command?: string | null;
  readonly next_command?: string | null;
}

export class BrowserEvidenceBuildError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`browser_evidence.${field}: ${message}`);
    this.name = "BrowserEvidenceBuildError";
    this.field = field;
  }
}

function parseIsoTimestamp(value: string, field: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowserEvidenceBuildError(field, "must be a non-empty ISO-8601 timestamp");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new BrowserEvidenceBuildError(field, `is not a valid ISO-8601 timestamp: "${value}"`);
  }
  return ms;
}

function requireNonEmptyBytes(
  value: string | Uint8Array,
  field: string,
): string | Uint8Array {
  const length = typeof value === "string" ? value.length : value.byteLength;
  if (length === 0) {
    throw new BrowserEvidenceBuildError(field, "must be non-empty bytes");
  }
  return value;
}

function hashHashable(input: HashableInput, field: string): `sha256:${string}` {
  if ("precomputedHash" in input) {
    return assertRealHash(input.precomputedHash, field);
  }
  requireNonEmptyBytes(input.bytes, field);
  return sha256OfBytes(input.bytes);
}

function hashAvailableEffortLabels(
  input: readonly string[] | HashableInput,
): `sha256:${string}` {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new BrowserEvidenceBuildError(
        "available_effort_labels_hash",
        "must include at least one effort label",
      );
    }
    // Canonical encoding: each label trimmed, joined with newline. Mirrors
    // how a selector manifest lists them visually so test reproducibility
    // doesn't depend on platform-specific separators.
    const canonical = input.map((label) => String(label).trim()).join("\n");
    return sha256OfBytes(canonical);
  }
  return hashHashable(input as HashableInput, "available_effort_labels_hash");
}

const REQUIRED_STRING_FIELDS = [
  "evidence_id",
  "run_id",
  "provider_slot",
  "provider_result_id",
  "requested_mode",
  "verification_scope",
  "selector_manifest_version",
  "requested_reasoning_effort",
  "observed_reasoning_effort_label",
  "effort_rank",
  "browser_effort_strategy",
] as const satisfies readonly (keyof BuildBrowserEvidenceInput)[];

function assertRequiredStrings(input: BuildBrowserEvidenceInput): void {
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new BrowserEvidenceBuildError(field, "is required and must be a non-empty string");
    }
  }
}

/**
 * Build and validate a `browser_evidence.v1` ledger.
 *
 *   * Hashes `promptBytes`, `outputBytes`, and (when bytes are supplied)
 *     `transition_log` / `available_effort_labels` through the centralized
 *     SHA-256 helper, producing canonical `sha256:<64 hex>` strings.
 *   * Pre-computed hashes (`session_id_hash`, optional `precomputedHash`
 *     unions) are validated against the same regex and rejected if they
 *     look like a placeholder (all-zeros, single-char repeats).
 *   * Refuses to emit success evidence when timestamps contradict the
 *     verification claim: `verified_at` must be at or before
 *     `prompt_submitted_at` whenever `mode_verified === true` or
 *     `verified_before_prompt_submit === true`.
 *   * Final shape passes through `browserEvidenceSchema.parse()` so every
 *     required v18 field is present before the caller persists the object.
 */
export function buildBrowserEvidence(input: BuildBrowserEvidenceInput): BrowserEvidence {
  assertRequiredStrings(input);

  // Hashes
  requireNonEmptyBytes(input.promptBytes, "prompt_sha256");
  requireNonEmptyBytes(input.outputBytes, "output_text_sha256");
  const prompt_sha256 = sha256OfBytes(input.promptBytes);
  const output_text_sha256 = sha256OfBytes(input.outputBytes);
  const transition_log_sha256 = hashHashable(input.transition_log, "transition_log_sha256");
  const available_effort_labels_hash = hashAvailableEffortLabels(input.available_effort_labels);
  const session_id_hash = assertRealHash(input.session_id_hash, "session_id_hash");
  const observed_mode_label_hash =
    input.observed_mode_label != null
      ? sha256OfBytes(input.observed_mode_label)
      : undefined;

  // Timestamps
  const verifiedAtMs = parseIsoTimestamp(input.verified_at, "verified_at");
  const promptSubmittedAtMs = parseIsoTimestamp(
    input.prompt_submitted_at,
    "prompt_submitted_at",
  );
  if (
    (input.mode_verified || input.verified_before_prompt_submit) &&
    verifiedAtMs > promptSubmittedAtMs
  ) {
    throw new BrowserEvidenceBuildError(
      "verified_at",
      `claims success but verified_at (${input.verified_at}) is after prompt_submitted_at (${input.prompt_submitted_at}); verification must precede prompt submission.`,
    );
  }
  if (input.verified_before_prompt_submit && !input.mode_verified) {
    throw new BrowserEvidenceBuildError(
      "verified_before_prompt_submit",
      "cannot be true when mode_verified is false",
    );
  }

  const created_at = input.created_at ?? new Date().toISOString();
  const createdAtMs = parseIsoTimestamp(created_at, "created_at");
  if (createdAtMs < verifiedAtMs) {
    throw new BrowserEvidenceBuildError(
      "created_at",
      `must not precede verified_at (${input.verified_at} > ${created_at}).`,
    );
  }

  const draft: BrowserEvidence = {
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    evidence_id: input.evidence_id,
    run_id: input.run_id,
    provider: input.provider,
    provider_slot: input.provider_slot,
    provider_result_id: input.provider_result_id,
    requested_mode: input.requested_mode,
    mode_verified: input.mode_verified,
    verified_before_prompt_submit: input.verified_before_prompt_submit,
    verified_at: input.verified_at,
    prompt_submitted_at: input.prompt_submitted_at,
    verification_method: input.verification_method,
    verification_scope: input.verification_scope,
    capture_confidence: input.capture_confidence,
    redaction_policy: input.redaction_policy ?? "redacted",
    session_id_hash,
    selector_manifest_version: input.selector_manifest_version,
    transition_log_sha256,
    prompt_sha256,
    output_text_sha256,
    unsafe_artifacts_quarantined: input.unsafe_artifacts_quarantined,
    created_at,
    requested_reasoning_effort: input.requested_reasoning_effort,
    observed_reasoning_effort_label: input.observed_reasoning_effort_label,
    reasoning_effort_verified: input.reasoning_effort_verified,
    effort_rank: input.effort_rank,
    selected_effort_is_highest_visible: input.selected_effort_is_highest_visible,
    available_effort_labels_hash,
    browser_effort_strategy: input.browser_effort_strategy,
    ...(observed_mode_label_hash ? { observed_mode_label_hash } : {}),
    ...(input.evidence_privacy ? { evidence_privacy: input.evidence_privacy } : {}),
    ...(input.thinking_level_if_exposed !== undefined
      ? { thinking_level_if_exposed: input.thinking_level_if_exposed }
      : {}),
    ...(input.thinking_level_verified !== undefined
      ? { thinking_level_verified: input.thinking_level_verified }
      : {}),
    ...(input.reasoning_effort_verification_method !== undefined
      ? { reasoning_effort_verification_method: input.reasoning_effort_verification_method }
      : {}),
    ...(input.failure_code !== undefined ? { failure_code: input.failure_code } : {}),
    ...(input.fix_command !== undefined ? { fix_command: input.fix_command } : {}),
    ...(input.next_command !== undefined ? { next_command: input.next_command } : {}),
  };

  // Final schema check: belt-and-suspenders against future code drift.
  return browserEvidenceSchema.parse(draft);
}
