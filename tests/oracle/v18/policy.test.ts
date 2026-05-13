import { describe, expect, test } from "vitest";

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  PROVIDER_RESULT_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  evaluateApiSubstitution,
  evaluateBrowserEvidenceTrust,
  evaluateProviderApiAllowed,
  evaluateProviderResultSynthesisEligibility,
  evaluateSynthesisGate,
} from "@src/oracle/v18/index.ts";

// Verified baseline objects taken from
// PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/. Each one represents the
// happy-path state; individual tests mutate the typed core fields under
// test (and add adversarial extension keys) to prove gating depends only on
// the typed core.

const verifiedEvidence = {
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

const synthesisReadyResult = {
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

const apiBlockedCapability = {
  access_path: "claude_code_subscription_cli",
  api_allowed: false,
  capabilities: { claude_code_keyword: "ultrathink", effort: "max" },
  checked_at: "2026-05-12T00:00:00Z",
  provider: "claude",
  schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
  status: "ready",
};

const apiAllowedCapability = {
  ...apiBlockedCapability,
  api_allowed: true,
};

describe("evaluateBrowserEvidenceTrust — happy path", () => {
  test("verified evidence passes", () => {
    const verdict = evaluateBrowserEvidenceTrust(verifiedEvidence);
    expect(verdict.eligible).toBe(true);
    expect(verdict.blockedReasons).toEqual([]);
  });
});

describe("evaluateBrowserEvidenceTrust — typed core gating", () => {
  test("mode_verified=false blocks even with an adversarial override extension", () => {
    const adversarial = {
      ...verifiedEvidence,
      mode_verified: false,
      mode_verified_override: true, // extension lookalike — must be ignored
      experimental_force_trust: true,
    };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(verdict.eligible).toBe(false);
    const fields = verdict.blockedReasons.map((r) => r.field);
    expect(fields).toContain("browser_evidence.mode_verified");
    // Critically: no reason should pivot on the extension keys.
    expect(fields).not.toContain("browser_evidence.mode_verified_override");
    expect(fields).not.toContain("browser_evidence.experimental_force_trust");
  });

  test("verified_before_prompt_submit=false yields the prompt_submitted_before_verification code", () => {
    const adversarial = {
      ...verifiedEvidence,
      verified_before_prompt_submit: false,
      verified_before_prompt_submit_override: true,
    };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(verdict.eligible).toBe(false);
    const reason = verdict.blockedReasons.find(
      (r) => r.field === "browser_evidence.verified_before_prompt_submit",
    );
    expect(reason?.code).toBe("prompt_submitted_before_verification");
  });

  test("reasoning_effort_verified=false on chatgpt evidence flags extended_reasoning_unverified", () => {
    const adversarial = { ...verifiedEvidence, reasoning_effort_verified: false };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.find(
        (r) => r.field === "browser_evidence.reasoning_effort_verified",
      )?.code,
    ).toBe("chatgpt_extended_reasoning_unverified");
  });

  test("gemini provider routes mode_verified failures to gemini_deep_think_unverified", () => {
    const adversarial = {
      ...verifiedEvidence,
      provider: "gemini",
      mode_verified: false,
    };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(
      verdict.blockedReasons.find((r) => r.field === "browser_evidence.mode_verified")?.code,
    ).toBe("gemini_deep_think_unverified");
  });

  test("unsafe_debug redaction policy is never trusted", () => {
    const adversarial = { ...verifiedEvidence, redaction_policy: "unsafe_debug" };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some((r) => r.field === "browser_evidence.redaction_policy"),
    ).toBe(true);
  });

  test("unsafe_artifacts_quarantined=false blocks", () => {
    const adversarial = { ...verifiedEvidence, unsafe_artifacts_quarantined: false };
    const verdict = evaluateBrowserEvidenceTrust(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some(
        (r) => r.field === "browser_evidence.unsafe_artifacts_quarantined",
      ),
    ).toBe(true);
  });

  test("missing required typed field surfaces as a schema-issue blocker", () => {
    const stripped = { ...verifiedEvidence } as Record<string, unknown>;
    delete stripped.prompt_sha256;
    const verdict = evaluateBrowserEvidenceTrust(stripped);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some((r) => r.field === "browser_evidence.prompt_sha256"),
    ).toBe(true);
  });
});

describe("evaluateProviderResultSynthesisEligibility — typed core gating", () => {
  test("happy path is eligible", () => {
    expect(
      evaluateProviderResultSynthesisEligibility(synthesisReadyResult).eligible,
    ).toBe(true);
  });

  test("synthesis_eligible=false blocks even with eligible_for_synthesis extension", () => {
    const adversarial = {
      ...synthesisReadyResult,
      synthesis_eligible: false,
      eligible_for_synthesis: true, // extension lookalike per policy rule #6
      experimental_override_synthesis_eligible: true,
      formal_first_plan: true,
    };
    const verdict = evaluateProviderResultSynthesisEligibility(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some((r) => r.field === "provider_result.synthesis_eligible"),
    ).toBe(true);
  });

  test("non-success status blocks", () => {
    const adversarial = { ...synthesisReadyResult, status: "degraded" };
    const verdict = evaluateProviderResultSynthesisEligibility(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(verdict.blockedReasons.some((r) => r.field === "provider_result.status")).toBe(true);
  });

  test("evidenceRequired flags missing evidence", () => {
    const stripped = { ...synthesisReadyResult, evidence: null, evidence_id: null };
    const verdict = evaluateProviderResultSynthesisEligibility(stripped, {
      evidenceRequired: true,
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.blockedReasons.some((r) => r.field === "provider_result.evidence")).toBe(true);
    expect(
      verdict.blockedReasons.some((r) => r.field === "provider_result.evidence_id"),
    ).toBe(true);
  });
});

describe("evaluateProviderApiAllowed — api_allowed gating", () => {
  test("api_allowed=true clears", () => {
    expect(evaluateProviderApiAllowed(apiAllowedCapability).eligible).toBe(true);
  });

  test("api_allowed=false blocks even with adversarial extensions", () => {
    const adversarial = {
      ...apiBlockedCapability,
      allow_api_anyway: true, // adversarial extension
      experimental_force_api: true,
    };
    const verdict = evaluateProviderApiAllowed(adversarial);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.find((r) => r.field === "provider_capability.api_allowed")?.code,
    ).toBe("provider_login_required");
  });

  test("status=blocked surfaces the provider_login_required code", () => {
    const verdict = evaluateProviderApiAllowed({
      ...apiAllowedCapability,
      status: "blocked",
    });
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.find((r) => r.field === "provider_capability.status")?.code,
    ).toBe("provider_login_required");
  });
});

describe("evaluateApiSubstitution — cross-contract guard", () => {
  test("browser access_path with api_allowed=false is fine", () => {
    const verdict = evaluateApiSubstitution({
      capability: apiBlockedCapability,
      result: synthesisReadyResult, // access_path = oracle_browser_remote
    });
    expect(verdict.eligible).toBe(true);
  });

  test("api access_path with api_allowed=false is blocked even with override extension", () => {
    const apiSubstitutedResult = {
      ...synthesisReadyResult,
      access_path: "openai_responses_api",
      api_allowed_override: true, // adversarial extension
      experimental_skip_api_substitution_check: true,
    };
    const verdict = evaluateApiSubstitution({
      capability: apiBlockedCapability,
      result: apiSubstitutedResult,
    });
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.find((r) => r.field === "provider_result.access_path")?.code,
    ).toBe("provider_login_required");
  });

  test("api access_path is allowed when capability permits API", () => {
    const verdict = evaluateApiSubstitution({
      capability: apiAllowedCapability,
      result: { ...synthesisReadyResult, access_path: "openai_responses_api" },
    });
    expect(verdict.eligible).toBe(true);
  });
});

describe("evaluateSynthesisGate — combined gate", () => {
  test("happy path: capability ok, result synthesis_eligible, evidence verified", () => {
    const verdict = evaluateSynthesisGate({
      capability: apiAllowedCapability,
      result: synthesisReadyResult,
      evidence: verifiedEvidence,
    });
    expect(verdict.eligible).toBe(true);
  });

  test("collects every blocker at once instead of short-circuiting", () => {
    const adversarial = {
      ...synthesisReadyResult,
      access_path: "openai_responses_api",
      synthesis_eligible: false,
      eligible_for_synthesis: true,
    };
    const failedEvidence = {
      ...verifiedEvidence,
      mode_verified: false,
      verified_before_prompt_submit: false,
      mode_verified_override: true,
    };
    const verdict = evaluateSynthesisGate({
      capability: apiBlockedCapability,
      result: adversarial,
      evidence: failedEvidence,
    });
    expect(verdict.eligible).toBe(false);
    const fields = verdict.blockedReasons.map((r) => r.field);
    // Each subordinate gate contributes at least one reason.
    expect(fields).toContain("provider_result.synthesis_eligible");
    expect(fields).toContain("provider_result.access_path"); // api substitution
    expect(fields).toContain("browser_evidence.mode_verified");
    expect(fields).toContain("browser_evidence.verified_before_prompt_submit");
  });

  test("works without capability or evidence inputs", () => {
    expect(
      evaluateSynthesisGate({ result: synthesisReadyResult }).eligible,
    ).toBe(true);
  });
});

describe("extension policy invariant: extension keys never satisfy a missing typed field", () => {
  test("extension key with critical core name cannot stand in for the typed field", () => {
    // verified_before_prompt_submit is missing entirely; an extension with the
    // same name camouflaged via a different key cannot fix it. The schema
    // requires the typed key explicitly, so parse fails and the verdict
    // blocks with a schema issue (not a silent pass).
    const stripped = { ...verifiedEvidence } as Record<string, unknown>;
    delete stripped.verified_before_prompt_submit;
    stripped.verified_before_prompt_submit_override = true; // adversarial alias
    const verdict = evaluateBrowserEvidenceTrust(stripped);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some(
        (r) => r.field === "browser_evidence.verified_before_prompt_submit",
      ),
    ).toBe(true);
  });
});
