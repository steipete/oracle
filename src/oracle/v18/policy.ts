// Strict-core / permissive-extension policy gating for v18 contracts.
//
// Critical eligibility decisions (browser-evidence trust, synthesis
// eligibility, API substitution) are made *only* from typed core fields on
// the parsed Zod schemas in `./contracts.ts`. Extension keys live in the
// `.passthrough()` bag and round-trip on the parsed object, but no helper
// in this module ever indexes into them — that way a malicious or
// accidental extension like `mode_verified_override: true` cannot flip a
// `false` core value into a passing verdict.
//
// See PLAN/oracle-vnext-plan-bundle-v18.0.0/docs/contract-core-extension-policy.md
// rule #6: the field names api_allowed, mode_verified,
// verified_before_prompt_submit, formal_first_plan, eligible_for_synthesis,
// and synthesis_eligible are explicitly off-limits to extension override.

import { z } from "zod";
import {
  browserEvidenceSchema,
  providerCapabilitySchema,
  providerResultSchema,
  type BrowserEvidence,
  type ProviderCapability,
  type ProviderResult,
} from "./contracts.js";
import {
  V18_ERROR_CODES,
  type V18ErrorCode,
} from "./json_envelope.js";

export interface BlockedReason {
  /** v18 error code from `V18_ERROR_CODES` when one applies; else `null`. */
  code: V18ErrorCode | null;
  /** Dotted contract path (e.g. `browser_evidence.mode_verified`). */
  field: string;
  message: string;
}

export interface EligibilityVerdict {
  readonly eligible: boolean;
  readonly blockedReasons: readonly BlockedReason[];
}

const OK: EligibilityVerdict = Object.freeze({ eligible: true, blockedReasons: [] });

function fail(reasons: BlockedReason[]): EligibilityVerdict {
  return { eligible: false, blockedReasons: reasons };
}

function reason(field: string, message: string, code: V18ErrorCode | null = null): BlockedReason {
  return { code, field, message };
}

function parseOrCollect<S extends z.ZodType>(
  schema: S,
  input: unknown,
  prefix: string,
  reasons: BlockedReason[],
): z.output<S> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    if (issues.length === 0) {
      reasons.push(reason(prefix, `${prefix} did not parse`));
    }
    for (const issue of issues) {
      const dotted =
        issue.path.length === 0
          ? prefix
          : `${prefix}.${issue.path.map((segment) => String(segment)).join(".")}`;
      reasons.push(reason(dotted, issue.message));
    }
    return null;
  }
  return parsed.data;
}

const PROVIDER_TO_EVIDENCE_ERROR: Record<BrowserEvidence["provider"], V18ErrorCode> = {
  chatgpt: "chatgpt_pro_unverified",
  gemini: "gemini_deep_think_unverified",
};

/**
 * Browser-evidence trust gate. Returns eligible only when every typed core
 * verification boolean on `browser_evidence.v1` is true and unsafe
 * artifacts are quarantined. Extension keys are never consulted.
 */
export function evaluateBrowserEvidenceTrust(input: unknown): EligibilityVerdict {
  const reasons: BlockedReason[] = [];
  const evidence = parseOrCollect(
    browserEvidenceSchema,
    input,
    "browser_evidence",
    reasons,
  ) as BrowserEvidence | null;
  if (!evidence) return fail(reasons);

  const providerCode = PROVIDER_TO_EVIDENCE_ERROR[evidence.provider];
  if (!evidence.mode_verified) {
    reasons.push(reason("browser_evidence.mode_verified", "must be true", providerCode));
  }
  if (!evidence.verified_before_prompt_submit) {
    reasons.push(
      reason(
        "browser_evidence.verified_before_prompt_submit",
        "must be true (verification must happen before prompt submit)",
        "prompt_submitted_before_verification",
      ),
    );
  }
  if (!evidence.reasoning_effort_verified) {
    reasons.push(
      reason(
        "browser_evidence.reasoning_effort_verified",
        "must be true",
        "chatgpt_extended_reasoning_unverified",
      ),
    );
  }
  if (!evidence.unsafe_artifacts_quarantined) {
    reasons.push(reason("browser_evidence.unsafe_artifacts_quarantined", "must be true"));
  }
  if (evidence.redaction_policy === "unsafe_debug") {
    reasons.push(
      reason(
        "browser_evidence.redaction_policy",
        "unsafe_debug evidence is never trusted for synthesis",
      ),
    );
  }
  return reasons.length === 0 ? OK : fail(reasons);
}

export interface SynthesisEligibilityOptions {
  /** When true, also require evidence (id + payload) to be present and trusted. */
  readonly evidenceRequired?: boolean;
}

/**
 * Decide whether a `provider_result.v1` is allowed to feed synthesis.
 * Reads only the typed `synthesis_eligible`, `status`, and `evidence` core
 * fields — not any extension key named `eligible_for_synthesis` or similar.
 */
export function evaluateProviderResultSynthesisEligibility(
  input: unknown,
  options: SynthesisEligibilityOptions = {},
): EligibilityVerdict {
  const reasons: BlockedReason[] = [];
  const result = parseOrCollect(
    providerResultSchema,
    input,
    "provider_result",
    reasons,
  ) as ProviderResult | null;
  if (!result) return fail(reasons);

  if (result.synthesis_eligible !== true) {
    reasons.push(reason("provider_result.synthesis_eligible", "must be true"));
  }
  if (result.status !== "success") {
    reasons.push(
      reason("provider_result.status", `must be \"success\" (was \"${result.status}\")`),
    );
  }
  if (options.evidenceRequired) {
    if (!result.evidence_id) {
      reasons.push(
        reason(
          "provider_result.evidence_id",
          "required when evidence is gated",
          "output_capture_unverified",
        ),
      );
    }
    if (!result.evidence) {
      reasons.push(
        reason(
          "provider_result.evidence",
          "required when evidence is gated",
          "output_capture_unverified",
        ),
      );
    }
  }
  return reasons.length === 0 ? OK : fail(reasons);
}

/**
 * Provider-capability gate for direct API usage. Returns eligible only
 * when typed `api_allowed` is not `false` and typed `status` is not
 * `blocked`. Extension keys cannot bypass either check.
 */
export function evaluateProviderApiAllowed(input: unknown): EligibilityVerdict {
  const reasons: BlockedReason[] = [];
  const capability = parseOrCollect(
    providerCapabilitySchema,
    input,
    "provider_capability",
    reasons,
  ) as ProviderCapability | null;
  if (!capability) return fail(reasons);

  if (capability.api_allowed === false) {
    reasons.push(
      reason(
        "provider_capability.api_allowed",
        "must not be false to use API access path",
        "provider_login_required",
      ),
    );
  }
  if (capability.status === "blocked") {
    reasons.push(
      reason(
        "provider_capability.status",
        "provider is currently blocked",
        "provider_login_required",
      ),
    );
  }
  return reasons.length === 0 ? OK : fail(reasons);
}

const API_ACCESS_PATH_PATTERN = /(^api_|_api(_|$))/i;

export interface ApiSubstitutionInputs {
  readonly capability: unknown;
  readonly result: unknown;
}

/**
 * Cross-contract: block a provider result whose `access_path` indicates a
 * direct API call when the matching capability snapshot says
 * `api_allowed: false`. This enforces v18's API-substitution ban.
 */
export function evaluateApiSubstitution(inputs: ApiSubstitutionInputs): EligibilityVerdict {
  const reasons: BlockedReason[] = [];
  const capability = parseOrCollect(
    providerCapabilitySchema,
    inputs.capability,
    "provider_capability",
    reasons,
  ) as ProviderCapability | null;
  const result = parseOrCollect(
    providerResultSchema,
    inputs.result,
    "provider_result",
    reasons,
  ) as ProviderResult | null;
  if (!capability || !result) return fail(reasons);

  if (capability.api_allowed === false && API_ACCESS_PATH_PATTERN.test(result.access_path)) {
    reasons.push(
      reason(
        "provider_result.access_path",
        `capability disallows API but access_path is "${result.access_path}"`,
        "provider_login_required",
      ),
    );
  }
  return reasons.length === 0 ? OK : fail(reasons);
}

/**
 * Combined synthesis gate: a provider result is only eligible for
 * synthesis if (a) its own typed core fields pass
 * `evaluateProviderResultSynthesisEligibility`, (b) the matching capability
 * has not been API-substituted, and (c) the linked browser evidence
 * (when the result claims to be browser-backed) passes evidence trust.
 *
 * Returns the merged verdict; never short-circuits on the first failure so
 * the caller sees every blocker at once for human-friendly recovery.
 */
export interface SynthesisGateInputs {
  readonly capability?: unknown;
  readonly result: unknown;
  readonly evidence?: unknown;
}

export function evaluateSynthesisGate(inputs: SynthesisGateInputs): EligibilityVerdict {
  const reasons: BlockedReason[] = [];

  const eligibility = evaluateProviderResultSynthesisEligibility(inputs.result, {
    evidenceRequired: inputs.evidence !== undefined,
  });
  reasons.push(...eligibility.blockedReasons);

  if (inputs.capability !== undefined) {
    const substitution = evaluateApiSubstitution({
      capability: inputs.capability,
      result: inputs.result,
    });
    reasons.push(...substitution.blockedReasons);
  }

  if (inputs.evidence !== undefined) {
    const trust = evaluateBrowserEvidenceTrust(inputs.evidence);
    reasons.push(...trust.blockedReasons);
  }

  return reasons.length === 0 ? OK : fail(reasons);
}

/** Sanity-check that policy reason codes stay aligned with the v18 taxonomy. */
export const POLICY_ERROR_CODES_USED: readonly V18ErrorCode[] = [
  "provider_login_required",
  "prompt_submitted_before_verification",
  "chatgpt_pro_unverified",
  "chatgpt_extended_reasoning_unverified",
  "gemini_deep_think_unverified",
  "output_capture_unverified",
] as const;

// Compile-time guard: every entry above must be a valid V18ErrorCode.
// (Runtime safety net.)
for (const code of POLICY_ERROR_CODES_USED) {
  if (!V18_ERROR_CODES.includes(code)) {
    throw new Error(`policy.ts references unknown v18 error code: ${code}`);
  }
}
