// v18 contract core for Oracle. Strict on documented fields, permissive on
// extensions — see PLAN/oracle-vnext-plan-bundle-v18.0.0/docs/contract-core-extension-policy.md.
//
// Each top-level schema is `.passthrough()` so unknown sibling keys round-trip
// without dropping; consumers must still gate critical decisions on the typed
// core fields (mode_verified, verified_before_prompt_submit, synthesis_eligible,
// etc.), never on extension fields.

import { z } from "zod";

export const V18_BUNDLE_VERSION = "v18.0.0" as const;

export const sha256HashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected sha256:<64-hex> form");

const bundleVersionSchema = z.literal(V18_BUNDLE_VERSION);

// ─── json_envelope.v1 ────────────────────────────────────────────────────────

export const JSON_ENVELOPE_SCHEMA_VERSION = "json_envelope.v1" as const;

export const jsonEnvelopeSchema = z
  .object({
    schema_version: z.literal(JSON_ENVELOPE_SCHEMA_VERSION),
    ok: z.boolean(),
    data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string(), z.null()]),
    meta: z.record(z.string(), z.unknown()),
    blocked_reason: z.string().nullable(),
    next_command: z.string().nullable(),
    fix_command: z.string().nullable(),
    retry_safe: z.boolean().nullable(),
    errors: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
    commands: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type JsonEnvelope = z.infer<typeof jsonEnvelopeSchema>;

// ─── provider_capability.v1 ──────────────────────────────────────────────────

export const PROVIDER_CAPABILITY_SCHEMA_VERSION = "provider_capability.v1" as const;

export const providerCapabilityStatusSchema = z.enum(["ready", "blocked", "degraded", "unknown"]);

export const providerCapabilitySchema = z
  .object({
    schema_version: z.literal(PROVIDER_CAPABILITY_SCHEMA_VERSION),
    provider: z.string(),
    capabilities: z.record(z.string(), z.unknown()),
    checked_at: z.string(),
    status: providerCapabilityStatusSchema.optional(),
    evidence_required: z.boolean().optional(),
    remote_browser_supported: z.boolean().optional(),
    blocked_reason: z.string().nullable().optional(),
    next_command: z.string().nullable().optional(),
  })
  .passthrough();
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

// ─── browser_lease.v1 ────────────────────────────────────────────────────────

export const BROWSER_LEASE_SCHEMA_VERSION = "browser_lease.v1" as const;

export const browserProviderSchema = z.enum(["chatgpt", "gemini"]);

export const browserLeaseStatusSchema = z.enum([
  "available",
  "acquired",
  "blocked",
  "expired",
  "released",
]);

export const browserLeaseSchema = z
  .object({
    schema_version: z.literal(BROWSER_LEASE_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    lease_id: z.string(),
    provider: browserProviderSchema,
    profile_id_hash: sha256HashSchema,
    remote_browser: z.record(z.string(), z.unknown()),
    lock_name: z.string(),
    status: browserLeaseStatusSchema,
    ttl_seconds: z.number().int(),
    issued_at: z.string(),
    expires_at: z.string(),
    renewable: z.boolean(),
    profile_scope: z.string(),
    shared_profile_policy: z.string(),
    holder: z.string().nullable().optional(),
    blocked_reason: z.string().nullable().optional(),
    next_command: z.string().nullable().optional(),
    fix_command: z.string().nullable().optional(),
  })
  .passthrough();
export type BrowserLease = z.infer<typeof browserLeaseSchema>;

// ─── browser_evidence.v1 ─────────────────────────────────────────────────────

export const BROWSER_EVIDENCE_SCHEMA_VERSION = "browser_evidence.v1" as const;

export const browserEvidenceCaptureConfidenceSchema = z.enum(["high", "medium", "low"]);
export const browserEvidenceRedactionPolicySchema = z.enum(["redacted", "off", "unsafe_debug"]);
export const browserEvidenceVerificationMethodSchema = z.enum([
  "same_session_ui_observation",
  "same_session_ui_observation_plus_selector_trace",
]);

export const browserEvidenceSchema = z
  .object({
    schema_version: z.literal(BROWSER_EVIDENCE_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    evidence_id: z.string(),
    provider_slot: z.string(),
    provider: browserProviderSchema,
    requested_mode: z.string(),
    mode_verified: z.boolean(),
    verified_before_prompt_submit: z.boolean(),
    verified_at: z.string(),
    prompt_submitted_at: z.string(),
    verification_method: browserEvidenceVerificationMethodSchema,
    capture_confidence: browserEvidenceCaptureConfidenceSchema,
    redaction_policy: browserEvidenceRedactionPolicySchema,
    session_id_hash: sha256HashSchema,
    selector_manifest_version: z.string(),
    transition_log_sha256: sha256HashSchema,
    prompt_sha256: sha256HashSchema,
    output_text_sha256: sha256HashSchema,
    unsafe_artifacts_quarantined: z.boolean(),
    created_at: z.string(),
    run_id: z.string(),
    provider_result_id: z.string(),
    verification_scope: z.string(),
    requested_reasoning_effort: z.string(),
    observed_reasoning_effort_label: z.string(),
    reasoning_effort_verified: z.boolean(),
    effort_rank: z.string(),
    selected_effort_is_highest_visible: z.boolean(),
    available_effort_labels_hash: sha256HashSchema,
    browser_effort_strategy: z.string(),
    evidence_privacy: z.record(z.string(), z.unknown()).optional(),
    failure_code: z.string().nullable().optional(),
    fix_command: z.string().nullable().optional(),
    next_command: z.string().nullable().optional(),
    observed_mode_label_hash: sha256HashSchema.optional(),
    thinking_level_if_exposed: z.string().optional(),
    thinking_level_verified: z.boolean().optional(),
    reasoning_effort_verification_method: z.string().optional(),
  })
  .passthrough();
export type BrowserEvidence = z.infer<typeof browserEvidenceSchema>;

// ─── browser_session.v1 ──────────────────────────────────────────────────────

export const BROWSER_SESSION_SCHEMA_VERSION = "browser_session.v1" as const;

export const browserSessionStatusSchema = z.enum(["ready", "blocked", "recovering", "unknown"]);

export const browserSessionSchema = z
  .object({
    schema_version: z.literal(BROWSER_SESSION_SCHEMA_VERSION),
    session_id: z.string(),
    profile: z.string(),
    provider_locks: z.array(z.record(z.string(), z.unknown())),
    remote_browser: z.record(z.string(), z.unknown()),
    status: browserSessionStatusSchema.optional(),
    next_command: z.string().nullable().optional(),
  })
  .passthrough();
export type BrowserSession = z.infer<typeof browserSessionSchema>;

// ─── remote_browser_endpoint.v1 ──────────────────────────────────────────────

export const REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION = "remote_browser_endpoint.v1" as const;

export const remoteBrowserEndpointModeSchema = z.enum(["preferred", "required", "off"]);
export const remoteBrowserEndpointStatusSchema = z.enum([
  "ready",
  "blocked",
  "unknown",
  "degraded",
]);

export const remoteBrowserEndpointSchema = z
  .object({
    schema_version: z.literal(REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    endpoint_id: z.string(),
    mode: remoteBrowserEndpointModeSchema,
    status: remoteBrowserEndpointStatusSchema,
    host_env: z.string(),
    token_env: z.string(),
    host_hash: sha256HashSchema,
    auth_profile_id_hash: sha256HashSchema,
    no_plaintext_secrets: z.boolean(),
    shared_profile_policy: z.string(),
    provider_locks: z.array(z.string()),
  })
  .passthrough();
export type RemoteBrowserEndpoint = z.infer<typeof remoteBrowserEndpointSchema>;

// ─── route_readiness.v1 ──────────────────────────────────────────────────────

export const ROUTE_READINESS_SCHEMA_VERSION = "route_readiness.v1" as const;

export const routeReadinessProfileSchema = z.enum(["fast", "balanced", "audit", "offline"]);
export const routeReadinessScopeSchema = z.enum(["preflight", "synthesis", "handoff"]);

export const routeReadinessSchema = z
  .object({
    schema_version: z.literal(ROUTE_READINESS_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    profile: routeReadinessProfileSchema,
    required_slots: z.array(z.string()),
    optional_slots: z.array(z.string()),
    ready: z.boolean(),
    blocked: z.array(z.record(z.string(), z.unknown())),
    degraded: z.array(z.record(z.string(), z.unknown())),
    mock_mode: z.boolean(),
    browser_evidence_required_for: z.array(z.string()),
    ready_scope: routeReadinessScopeSchema,
    preflight_ready: z.boolean(),
    synthesis_ready: z.boolean(),
    pending_browser_evidence_for: z.array(z.string()),
    stage_readiness: z.record(z.string(), z.unknown()),
    synthesis_prompt_ready: z.boolean(),
    synthesis_prompt_blocked_until_evidence_for: z.array(z.string()),
    final_handoff_blocked_until_evidence_for: z.array(z.string()),
    review_quorum_policy: z.string(),
    review_quorum_ready: z.boolean(),
    review_quorum: z.record(z.string(), z.unknown()),
    highest_reasoning_required_for: z.array(z.string()).optional(),
    blocked_on_missing_effort_verification_for: z.array(z.string()).optional(),
    model_reasoning_policy: z.string().optional(),
  })
  .passthrough();
export type RouteReadiness = z.infer<typeof routeReadinessSchema>;

// ─── provider_result.v1 ──────────────────────────────────────────────────────

export const PROVIDER_RESULT_SCHEMA_VERSION = "provider_result.v1" as const;

export const providerResultStatusSchema = z.enum([
  "success",
  "failed",
  "degraded",
  "skipped",
  "manual_import",
  "cached",
]);

export const providerResultSchema = z
  .object({
    schema_version: z.literal(PROVIDER_RESULT_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    provider_slot: z.string(),
    provider_family: z.string(),
    access_path: z.string(),
    status: providerResultStatusSchema,
    synthesis_eligible: z.boolean(),
    evidence: z.record(z.string(), z.unknown()).nullable(),
    evidence_id: z.string().nullable(),
    prompt_manifest_sha256: sha256HashSchema,
    source_baseline_sha256: sha256HashSchema,
    provider_result_id: z.string(),
    result_text_sha256: sha256HashSchema,
    model: z.string().optional(),
    error: z.record(z.string(), z.unknown()).nullable().optional(),
    result_path: z.string().nullable().optional(),
    degradation_reason: z.string().nullable().optional(),
    reasoning_config: z.record(z.string(), z.unknown()).optional(),
    reasoning_effort: z.string().optional(),
    reasoning_effort_verified: z.boolean().optional(),
    reasoning_content_policy: z.string().optional(),
    reasoning_content_sha256: sha256HashSchema.nullable().optional(),
    reasoning_content_stored: z.boolean().optional(),
    reasoning_content_transient_replay: z.boolean().optional(),
    quorum_eligible: z.boolean().optional(),
    api_base_url: z.string().optional(),
    api_key_env: z.string().optional(),
    official_api: z.boolean().optional(),
    provider_result_stage: z.string().optional(),
    search_enabled: z.boolean().optional(),
    search_mode: z.string().optional(),
    search_tool_name: z.string().optional(),
    search_trace_sha256: sha256HashSchema.nullable().optional(),
    tool_call_replay_policy: z.string().optional(),
    thinking: z.record(z.string(), z.unknown()).optional(),
    thinking_enabled: z.boolean().optional(),
    claude_code_keyword: z.string().optional(),
  })
  .passthrough();
export type ProviderResult = z.infer<typeof providerResultSchema>;

// ─── robot_surface.v1 ────────────────────────────────────────────────────────

export const ROBOT_SURFACE_SCHEMA_VERSION = "robot_surface.v1" as const;

export const robotSurfaceSchema = z
  .object({
    schema_version: z.literal(ROBOT_SURFACE_SCHEMA_VERSION),
    tool: z.string(),
    commands: z.array(z.record(z.string(), z.unknown())),
    json_envelope_required: z.boolean().optional(),
    error_fields_required: z.array(z.string()).optional(),
  })
  .passthrough();
export type RobotSurface = z.infer<typeof robotSurfaceSchema>;

// ─── run_progress.v1 ─────────────────────────────────────────────────────────

export const RUN_PROGRESS_SCHEMA_VERSION = "run_progress.v1" as const;

export const runProgressSchema = z
  .object({
    schema_version: z.literal(RUN_PROGRESS_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    run_id: z.string(),
    profile: z.string(),
    state: z.string(),
    current_stage: z.string(),
    completed_stages: z.array(z.string()),
    pending_stages: z.array(z.string()),
    progress_percent: z.number(),
    user_visible_message: z.string(),
    next_command: z.string().nullable(),
    blocked_reason: z.string().nullable(),
    retry_safe: z.boolean(),
    last_event_at: z.string().optional(),
  })
  .passthrough();
export type RunProgress = z.infer<typeof runProgressSchema>;

// ─── context_serialization_policy.v1 ─────────────────────────────────────────

export const CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION =
  "context_serialization_policy.v1" as const;

export const contextSerializationPolicyStatusSchema = z.enum([
  "gated_optional",
  "enabled_optional",
  "disabled",
]);
export const contextPromptPreferenceSchema = z.enum(["json", "auto", "toon"]);

export const toonRustPolicySchema = z
  .object({
    enabled: z.boolean(),
    required: z.boolean(),
    cli_candidates: z.array(z.string()),
    prefer_cli: z.string(),
    strict_decode: z.boolean(),
    source_repo: z.string(),
    library_name: z.string().optional(),
    library_package: z.string().optional(),
    minimum_version: z.string().optional(),
    enabled_by_default: z.boolean().optional(),
    key_folding: z.string().optional(),
    license_note: z.string().optional(),
    license_review_required: z.boolean().optional(),
  })
  .passthrough();
export type ToonRustPolicy = z.infer<typeof toonRustPolicySchema>;

export const contextSerializationPolicySchema = z
  .object({
    schema_version: z.literal(CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    canonical_storage_format: z.literal("json"),
    prompt_context_preference: contextPromptPreferenceSchema,
    fallback_format: z.literal("json"),
    toon_rust: toonRustPolicySchema,
    usage_patterns: z.array(z.string()),
    anti_patterns: z.array(z.string()),
    hash_requirements: z.array(z.string()),
    policy_status: contextSerializationPolicyStatusSchema,
    legal_review_required: z.boolean(),
    default_effective_format: z.literal("json"),
    activation_requirements: z.array(z.string()),
  })
  .passthrough();
export type ContextSerializationPolicy = z.infer<typeof contextSerializationPolicySchema>;

// ─── Core extension policy invariants ────────────────────────────────────────
// Per docs/contract-core-extension-policy.md: unknown extension fields must
// never override these critical core flags when consumers gate decisions.
//
// Keep this list aligned with policy doc rule #6. Tests assert that contract
// validation continues to surface the typed value for these keys even when
// adversarial extensions are present.
export const CRITICAL_CORE_FIELDS = [
  "api_allowed",
  "mode_verified",
  "verified_before_prompt_submit",
  "formal_first_plan",
  "eligible_for_synthesis",
  "synthesis_eligible",
] as const;
export type CriticalCoreField = (typeof CRITICAL_CORE_FIELDS)[number];

export interface V18Contract<T> {
  schemaVersion: string;
  schema: z.ZodType<T>;
}

export const v18Contracts = {
  jsonEnvelope: { schemaVersion: JSON_ENVELOPE_SCHEMA_VERSION, schema: jsonEnvelopeSchema },
  providerCapability: {
    schemaVersion: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    schema: providerCapabilitySchema,
  },
  browserLease: { schemaVersion: BROWSER_LEASE_SCHEMA_VERSION, schema: browserLeaseSchema },
  browserEvidence: {
    schemaVersion: BROWSER_EVIDENCE_SCHEMA_VERSION,
    schema: browserEvidenceSchema,
  },
  browserSession: { schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, schema: browserSessionSchema },
  remoteBrowserEndpoint: {
    schemaVersion: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    schema: remoteBrowserEndpointSchema,
  },
  routeReadiness: { schemaVersion: ROUTE_READINESS_SCHEMA_VERSION, schema: routeReadinessSchema },
  providerResult: { schemaVersion: PROVIDER_RESULT_SCHEMA_VERSION, schema: providerResultSchema },
  robotSurface: { schemaVersion: ROBOT_SURFACE_SCHEMA_VERSION, schema: robotSurfaceSchema },
  runProgress: { schemaVersion: RUN_PROGRESS_SCHEMA_VERSION, schema: runProgressSchema },
  contextSerializationPolicy: {
    schemaVersion: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
    schema: contextSerializationPolicySchema,
  },
} as const;

export type V18ContractName = keyof typeof v18Contracts;
