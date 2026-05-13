import { describe, expect, test } from "vitest";

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  BROWSER_SESSION_SCHEMA_VERSION,
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  CRITICAL_CORE_FIELDS,
  JSON_ENVELOPE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  PROVIDER_RESULT_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  ROBOT_SURFACE_SCHEMA_VERSION,
  ROUTE_READINESS_SCHEMA_VERSION,
  RUN_PROGRESS_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserEvidenceSchema,
  browserLeaseSchema,
  browserSessionSchema,
  contextSerializationPolicySchema,
  jsonEnvelopeSchema,
  providerCapabilitySchema,
  providerResultSchema,
  remoteBrowserEndpointSchema,
  robotSurfaceSchema,
  routeReadinessSchema,
  runProgressSchema,
  sha256HashSchema,
  v18Contracts,
} from "@src/oracle/v18/index.ts";

// Verbatim copies of the canonical fixtures from
// PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/. Pinning them here keeps the
// tests independent of the plan-bundle directory layout while still asserting
// our contracts accept the documented v18 shapes.

const jsonEnvelopeFixture = {
  blocked_reason: null,
  commands: { next: "tool doctor --json" },
  data: { message: "ok" },
  errors: [],
  fix_command: null,
  meta: { bundle_version: V18_BUNDLE_VERSION },
  next_command: null,
  ok: true,
  retry_safe: null,
  schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
  warnings: [],
};

const providerCapabilityFixture = {
  access_path: "claude_code_subscription_cli",
  api_allowed: false,
  bundle_version: V18_BUNDLE_VERSION,
  capabilities: { claude_code_keyword: "ultrathink", effort: "max" },
  checked_at: "2026-05-12T00:00:00Z",
  claude_code_keyword: "ultrathink",
  effort: "max",
  highest_reasoning_verified: false,
  model: "claude-opus-4-7",
  provider: "claude",
  provider_family: "claude",
  provider_slot: "claude_code_opus",
  required_command: "claude",
  schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
  status: "ready",
  thinking: { type: "adaptive" },
};

const browserLeaseFixture = {
  blocked_reason: null,
  bundle_version: V18_BUNDLE_VERSION,
  expires_at: "2026-05-12T00:30:00Z",
  fix_command: null,
  holder: null,
  issued_at: "2026-05-12T00:00:00Z",
  lease_id: "lease-demo-chatgpt",
  lock_name: "browser:shared-profile:chatgpt",
  next_command: null,
  profile_id_hash: "sha256:aacd890f85040adcbc768935a0daa1d3971eeac950425288dcabc2fd0ee02a84",
  profile_scope: "shared_logical_remote_browser_profile_with_provider_locks",
  provider: "chatgpt",
  remote_browser: {
    endpoint_id: "remote-browser-demo",
    host_env: "ORACLE_REMOTE_HOST",
    host_hash: "sha256:efa0848e6fd55eec6a3d6e2e171a9b8025950871925586a2154448b5bb58502c",
    mode: "preferred",
    no_plaintext_secrets: true,
    profile_policy: "shared_logical_profile",
    status: "ready",
    token_env: "ORACLE_REMOTE_TOKEN",
  },
  renewable: true,
  schema_version: BROWSER_LEASE_SCHEMA_VERSION,
  shared_profile_policy:
    "one_user_auth_context_per_remote_browser_host; provider-specific technical profiles are allowed only if Oracle requires them internally",
  status: "available",
  ttl_seconds: 1800,
};

const browserEvidenceFixture = {
  available_effort_labels_hash:
    "sha256:3783e2e25fe2fb31540b46f44b69c10dc8b03f2f2b19b76dd105a3bcb503bdf4",
  browser_effort_strategy: "select_highest_visible",
  bundle_version: V18_BUNDLE_VERSION,
  capture_confidence: "high",
  created_at: "2026-05-12T00:00:10Z",
  effort_rank: "highest_visible",
  evidence_id: "evidence-demo-chatgpt_pro_first_plan",
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
  observed_mode_label_hash:
    "sha256:d7b7c908e3e34240373fc3f039ce138181d3c7d110b6cedb7c7c5eb86fc540b9",
  observed_reasoning_effort_label: "Heavy",
  output_text_sha256: "sha256:1a8f9f53b1c104b8e875b567fa926c96106866aa67b84ceb0ae9b79cc2b6f069",
  prompt_sha256: "sha256:8066ce46612720cc9fef084e87ff90b1eec0f7f9fa6c41988018601257fe8791",
  prompt_submitted_at: "2026-05-12T00:00:05Z",
  provider: "chatgpt",
  provider_result_id: "provider-result-demo-chatgpt_pro_first_plan",
  provider_slot: "chatgpt_pro_first_plan",
  reasoning_effort_verification_method: "model_picker_label",
  reasoning_effort_verified: true,
  redaction_policy: "redacted",
  requested_mode: "pro_extended_reasoning",
  requested_reasoning_effort: "max_browser_available",
  run_id: "run-demo",
  schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
  selected_effort_is_highest_visible: true,
  selector_manifest_version: "chatgpt-pro-v1",
  session_id_hash: "sha256:2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea",
  transition_log_sha256:
    "sha256:9c9c239de9790a1c12bbda6a34c7fc8b69c05612237dfb3cedaedd3a130fd82f",
  unsafe_artifacts_quarantined: true,
  verification_method: "same_session_ui_observation_plus_selector_trace",
  verification_scope: "same_browser_session_before_prompt_submit",
  verified_at: "2026-05-12T00:00:00Z",
  verified_before_prompt_submit: true,
};

const browserSessionFixture = {
  bundle_version: V18_BUNDLE_VERSION,
  next_command: null,
  profile: "shared-remote-profile",
  provider_locks: [
    { lock: "browser:shared-profile:chatgpt", provider: "chatgpt" },
    { lock: "browser:shared-profile:gemini", provider: "gemini" },
  ],
  remote_browser: {
    host_env: "ORACLE_REMOTE_HOST",
    preferred: true,
    token_env: "ORACLE_REMOTE_TOKEN",
  },
  schema_version: BROWSER_SESSION_SCHEMA_VERSION,
  session_id: "browser-session-demo",
  status: "ready",
};

const remoteBrowserEndpointFixture = {
  auth_profile_id_hash:
    "sha256:5145a2449252f93357efa5387da50412bfab629736717a22f2b5dcdcd3ca01e1",
  bundle_version: V18_BUNDLE_VERSION,
  doctor_command: "oracle remote doctor --json",
  endpoint_id: "remote-browser-demo",
  host_env: "ORACLE_REMOTE_HOST",
  host_hash: "sha256:0f86cdc5e6e9b6bfa21071a192fa7cc721a4aafcb26dfa92065f38bab5a4cef7",
  mode: "preferred",
  no_plaintext_secrets: true,
  provider_locks: ["browser:shared-profile:chatgpt", "browser:shared-profile:gemini"],
  recover_command: "oracle browser leases recover --provider PROVIDER --json",
  schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  shared_profile_policy: "one_user_auth_context_per_remote_browser_host",
  status: "ready",
  token_env: "ORACLE_REMOTE_TOKEN",
};

const routeReadinessFixture = {
  active_failure_modes: ["FM-001"],
  blocked: [],
  browser_evidence_required_for: ["chatgpt_pro_first_plan", "gemini_deep_think"],
  bundle_version: V18_BUNDLE_VERSION,
  degraded: [],
  final_handoff_blocked_until_evidence_for: ["chatgpt_pro_first_plan"],
  highest_reasoning_required_for: ["chatgpt_pro_first_plan"],
  mock_mode: true,
  optional_slots: ["claude_code_opus"],
  pending_browser_evidence_for: ["chatgpt_pro_first_plan"],
  preflight_ready: true,
  profile: "balanced",
  ready: true,
  ready_scope: "preflight",
  required_slots: ["chatgpt_pro_first_plan", "gemini_deep_think"],
  review_quorum: { required_independent_reviewers: ["gemini_deep_think"] },
  review_quorum_policy: "fixtures/review-quorum.balanced.json",
  review_quorum_ready: false,
  schema_version: ROUTE_READINESS_SCHEMA_VERSION,
  stage_readiness: { compare: { ready: false } },
  synthesis_prompt_blocked_until_evidence_for: ["chatgpt_pro_first_plan"],
  synthesis_prompt_ready: false,
  synthesis_ready: false,
};

const providerResultFixture = {
  access_path: "oracle_browser_remote",
  bundle_version: V18_BUNDLE_VERSION,
  degradation_reason: null,
  error: null,
  evidence: {
    evidence_id: "evidence-demo-chatgpt_pro_first_plan",
    mode_verified: true,
    path: ".apr/runs/demo/evidence/chatgpt_pro_first_plan/evidence.json",
    verified_before_prompt_submit: true,
  },
  evidence_id: "evidence-demo-chatgpt_pro_first_plan",
  model: "chatgpt-pro-latest",
  prompt_manifest_sha256:
    "sha256:69223c8fae80b46ec663079168f541e9308eb835d7720212f8222bf1f239cb18",
  provider_family: "chatgpt",
  provider_result_id: "provider-result-demo-chatgpt_pro_first_plan",
  provider_slot: "chatgpt_pro_first_plan",
  reasoning_effort: "max_browser_available",
  reasoning_effort_verified: true,
  result_path: ".apr/runs/demo/plans/chatgpt_pro_first_plan/output.md",
  result_text_sha256: "sha256:1a8f9f53b1c104b8e875b567fa926c96106866aa67b84ceb0ae9b79cc2b6f069",
  schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
  source_baseline_sha256:
    "sha256:b91d369c3f7250980878f782559b0c4ccc00a829603c88cf555c0b23bdd12ee6",
  status: "success",
  synthesis_eligible: true,
};

const robotSurfaceFixture = {
  bundle_version: V18_BUNDLE_VERSION,
  commands: [
    { mock_command: "python3 scripts/validate-subset.py --json", name: "doctor" },
    { mock_command: "python3 scripts/validate-subset.py --json", name: "robot-plan" },
  ],
  error_fields_required: ["blocked_reason", "next_command", "fix_command", "retry_safe"],
  json_envelope_required: true,
  schema_version: ROBOT_SURFACE_SCHEMA_VERSION,
  tool: "vibe-plan-run",
};

const runProgressFixture = {
  blocked_reason: "live_provider_approval_required",
  bundle_version: V18_BUNDLE_VERSION,
  completed_stages: ["brief_lint", "source_baseline", "route_plan"],
  current_stage: "preflight",
  last_event_at: "2026-05-12T00:00:00Z",
  next_command: "oracle remote doctor --json",
  pending_stages: ["first_plan", "synthesis", "handoff"],
  profile: "balanced",
  progress_percent: 18,
  retry_safe: true,
  run_id: "run_demo_v17",
  schema_version: RUN_PROGRESS_SCHEMA_VERSION,
  state: "waiting_for_live_provider_approval",
  user_visible_message: "Preflight is complete. Live browser/provider calls have not started.",
};

const contextSerializationPolicyFixture = {
  activation_requirements: ["license_compatibility_review_approved"],
  anti_patterns: ["canonical_artifact_storage_as_toon"],
  bundle_version: V18_BUNDLE_VERSION,
  canonical_storage_format: "json",
  default_effective_format: "json",
  fallback_format: "json",
  hash_requirements: ["canonical_json_sha256"],
  legal_review_required: true,
  policy_status: "gated_optional",
  prompt_context_preference: "json",
  schema_version: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  toon_rust: {
    cli_candidates: ["toon", "tru"],
    enabled: false,
    enabled_by_default: false,
    key_folding: "safe",
    library_name: "toon",
    library_package: "tru",
    license_review_required: true,
    minimum_version: "0.2.3",
    prefer_cli: "toon",
    required: false,
    source_repo: "https://github.com/Dicklesworthstone/toon_rust",
    strict_decode: true,
  },
  usage_patterns: ["prompt_context_packet_compaction"],
};

interface FixtureCase {
  name: string;
  fixture: unknown;
  schema: (typeof v18Contracts)[keyof typeof v18Contracts]["schema"];
  schemaVersion: string;
}

const fixtureCases: FixtureCase[] = [
  {
    name: "json_envelope.v1",
    fixture: jsonEnvelopeFixture,
    schema: v18Contracts.jsonEnvelope.schema,
    schemaVersion: JSON_ENVELOPE_SCHEMA_VERSION,
  },
  {
    name: "provider_capability.v1",
    fixture: providerCapabilityFixture,
    schema: v18Contracts.providerCapability.schema,
    schemaVersion: PROVIDER_CAPABILITY_SCHEMA_VERSION,
  },
  {
    name: "browser_lease.v1",
    fixture: browserLeaseFixture,
    schema: v18Contracts.browserLease.schema,
    schemaVersion: BROWSER_LEASE_SCHEMA_VERSION,
  },
  {
    name: "browser_evidence.v1",
    fixture: browserEvidenceFixture,
    schema: v18Contracts.browserEvidence.schema,
    schemaVersion: BROWSER_EVIDENCE_SCHEMA_VERSION,
  },
  {
    name: "browser_session.v1",
    fixture: browserSessionFixture,
    schema: v18Contracts.browserSession.schema,
    schemaVersion: BROWSER_SESSION_SCHEMA_VERSION,
  },
  {
    name: "remote_browser_endpoint.v1",
    fixture: remoteBrowserEndpointFixture,
    schema: v18Contracts.remoteBrowserEndpoint.schema,
    schemaVersion: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  },
  {
    name: "route_readiness.v1",
    fixture: routeReadinessFixture,
    schema: v18Contracts.routeReadiness.schema,
    schemaVersion: ROUTE_READINESS_SCHEMA_VERSION,
  },
  {
    name: "provider_result.v1",
    fixture: providerResultFixture,
    schema: v18Contracts.providerResult.schema,
    schemaVersion: PROVIDER_RESULT_SCHEMA_VERSION,
  },
  {
    name: "robot_surface.v1",
    fixture: robotSurfaceFixture,
    schema: v18Contracts.robotSurface.schema,
    schemaVersion: ROBOT_SURFACE_SCHEMA_VERSION,
  },
  {
    name: "run_progress.v1",
    fixture: runProgressFixture,
    schema: v18Contracts.runProgress.schema,
    schemaVersion: RUN_PROGRESS_SCHEMA_VERSION,
  },
  {
    name: "context_serialization_policy.v1",
    fixture: contextSerializationPolicyFixture,
    schema: v18Contracts.contextSerializationPolicy.schema,
    schemaVersion: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  },
];

describe("v18 contract bundle metadata", () => {
  test("bundle version constant matches v18.0.0", () => {
    expect(V18_BUNDLE_VERSION).toBe("v18.0.0");
  });

  test("critical core fields enumerate the policy guardrails", () => {
    expect(CRITICAL_CORE_FIELDS).toEqual(
      expect.arrayContaining([
        "api_allowed",
        "mode_verified",
        "verified_before_prompt_submit",
        "synthesis_eligible",
      ]),
    );
  });
});

describe("sha256HashSchema", () => {
  test("accepts canonical sha256 hash strings", () => {
    expect(() =>
      sha256HashSchema.parse(
        "sha256:" + "a".repeat(64),
      ),
    ).not.toThrow();
  });

  test("rejects malformed or wrong-length digests", () => {
    expect(() => sha256HashSchema.parse("sha256:abc")).toThrow();
    expect(() => sha256HashSchema.parse("md5:" + "a".repeat(64))).toThrow();
    expect(() => sha256HashSchema.parse("SHA256:" + "a".repeat(64))).toThrow();
  });
});

describe("v18 fixture parity", () => {
  test.each(fixtureCases.map((c) => [c.name, c]))(
    "%s: canonical fixture parses",
    (_name, caseRecord) => {
      const c = caseRecord as FixtureCase;
      const parsed = c.schema.parse(c.fixture) as { schema_version: string };
      expect(parsed.schema_version).toBe(c.schemaVersion);
    },
  );

  test.each(fixtureCases.map((c) => [c.name, c]))(
    "%s: rejects wrong schema_version literal",
    (_name, caseRecord) => {
      const c = caseRecord as FixtureCase;
      const mutated = {
        ...(c.fixture as Record<string, unknown>),
        schema_version: "wrong.version.v0",
      };
      expect(() => c.schema.parse(mutated)).toThrow();
    },
  );
});

describe("required-field enforcement (sample of high-impact schemas)", () => {
  test("json envelope drops successfully when all required keys are set", () => {
    expect(() => jsonEnvelopeSchema.parse(jsonEnvelopeFixture)).not.toThrow();
  });

  test("json envelope rejects missing required fields", () => {
    for (const field of [
      "ok",
      "data",
      "meta",
      "blocked_reason",
      "next_command",
      "fix_command",
      "retry_safe",
      "errors",
      "warnings",
      "commands",
    ] as const) {
      const stripped = { ...jsonEnvelopeFixture } as Record<string, unknown>;
      delete stripped[field];
      expect(() => jsonEnvelopeSchema.parse(stripped), `missing ${field}`).toThrow();
    }
  });

  test("browser_lease rejects missing required fields", () => {
    const requiredKeys = [
      "schema_version",
      "bundle_version",
      "lease_id",
      "provider",
      "profile_id_hash",
      "remote_browser",
      "lock_name",
      "status",
      "ttl_seconds",
      "issued_at",
      "expires_at",
      "renewable",
      "profile_scope",
      "shared_profile_policy",
    ];
    for (const field of requiredKeys) {
      const stripped = { ...browserLeaseFixture } as Record<string, unknown>;
      delete stripped[field];
      expect(() => browserLeaseSchema.parse(stripped), `missing ${field}`).toThrow();
    }
  });

  test("browser_evidence rejects bad sha256 hashes on prompt/output", () => {
    expect(() =>
      browserEvidenceSchema.parse({
        ...browserEvidenceFixture,
        prompt_sha256: "not-a-hash",
      }),
    ).toThrow();
    expect(() =>
      browserEvidenceSchema.parse({
        ...browserEvidenceFixture,
        output_text_sha256: "sha256:short",
      }),
    ).toThrow();
  });

  test("provider_result enforces hash provenance fields", () => {
    expect(() =>
      providerResultSchema.parse({
        ...providerResultFixture,
        prompt_manifest_sha256: "sha256:short",
      }),
    ).toThrow();
    expect(() =>
      providerResultSchema.parse({
        ...providerResultFixture,
        source_baseline_sha256: "not-a-hash",
      }),
    ).toThrow();
    expect(() =>
      providerResultSchema.parse({
        ...providerResultFixture,
        result_text_sha256: undefined,
      }),
    ).toThrow();
  });

  test("route_readiness rejects unknown profile and ready_scope values", () => {
    expect(() =>
      routeReadinessSchema.parse({ ...routeReadinessFixture, profile: "lightning" }),
    ).toThrow();
    expect(() =>
      routeReadinessSchema.parse({ ...routeReadinessFixture, ready_scope: "deploy" }),
    ).toThrow();
  });

  test("remote_browser_endpoint enforces mode + status enums", () => {
    expect(() =>
      remoteBrowserEndpointSchema.parse({
        ...remoteBrowserEndpointFixture,
        mode: "auto",
      }),
    ).toThrow();
    expect(() =>
      remoteBrowserEndpointSchema.parse({
        ...remoteBrowserEndpointFixture,
        status: "online",
      }),
    ).toThrow();
  });

  test("context_serialization_policy locks json as canonical/effective format", () => {
    expect(() =>
      contextSerializationPolicySchema.parse({
        ...contextSerializationPolicyFixture,
        canonical_storage_format: "toon",
      }),
    ).toThrow();
    expect(() =>
      contextSerializationPolicySchema.parse({
        ...contextSerializationPolicyFixture,
        default_effective_format: "yaml",
      }),
    ).toThrow();
  });

  test("robot_surface requires tool and commands", () => {
    expect(() =>
      robotSurfaceSchema.parse({ ...robotSurfaceFixture, tool: undefined }),
    ).toThrow();
    expect(() =>
      robotSurfaceSchema.parse({ ...robotSurfaceFixture, commands: undefined }),
    ).toThrow();
  });

  test("run_progress rejects missing nullable-but-required fields", () => {
    expect(() =>
      runProgressSchema.parse({ ...runProgressFixture, next_command: undefined }),
    ).toThrow();
    expect(() =>
      runProgressSchema.parse({ ...runProgressFixture, blocked_reason: undefined }),
    ).toThrow();
  });

  test("provider_capability allows status to be optional but rejects unknown values", () => {
    expect(() =>
      providerCapabilitySchema.parse({ ...providerCapabilityFixture, status: "online" }),
    ).toThrow();
  });

  test("browser_session enforces enum for status when present", () => {
    expect(() =>
      browserSessionSchema.parse({ ...browserSessionFixture, status: "offline" }),
    ).toThrow();
  });
});

describe("extension policy: unknown keys round-trip and never override core", () => {
  test("json_envelope preserves unknown extension keys", () => {
    const parsed = jsonEnvelopeSchema.parse({
      ...jsonEnvelopeFixture,
      experimental_trace_id: "trace-abc",
    }) as Record<string, unknown>;
    expect(parsed.experimental_trace_id).toBe("trace-abc");
    expect(parsed.ok).toBe(true);
  });

  test("browser_evidence: an extension cannot flip mode_verified or verified_before_prompt_submit", () => {
    // Per contract-core-extension-policy.md, extensions must not be consulted
    // when gating decisions; they round-trip but typed fields stay authoritative.
    const adversarial = {
      ...browserEvidenceFixture,
      mode_verified: false,
      verified_before_prompt_submit: false,
      experimental_override_synthesis_eligible: true,
      mode_verified_override: true,
    };
    const parsed = browserEvidenceSchema.parse(adversarial);
    expect(parsed.mode_verified).toBe(false);
    expect(parsed.verified_before_prompt_submit).toBe(false);
    expect((parsed as Record<string, unknown>).mode_verified_override).toBe(true);
  });

  test("provider_result: an extension cannot flip synthesis_eligible", () => {
    const adversarial = {
      ...providerResultFixture,
      synthesis_eligible: false,
      experimental_override_synthesis_eligible: true,
      eligible_for_synthesis: true, // extension lookalike
    };
    const parsed = providerResultSchema.parse(adversarial);
    expect(parsed.synthesis_eligible).toBe(false);
    expect((parsed as Record<string, unknown>).eligible_for_synthesis).toBe(true);
  });
});
