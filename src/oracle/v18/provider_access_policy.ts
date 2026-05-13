// v18 `provider_access_policy.v1` contract layer and protected-slot
// metadata. The Zod parser pins schema + bundle version; the helpers
// enforce the slot-substitution invariants from v18 spec §3 / the
// provider-access-policy fixture in the plan bundle.
//
// This is a workflow policy layer, not a global product restriction:
// ordinary Oracle API use outside `$vibe-planning` keeps working. The
// helpers only fire when callers pass a v18 slot name.

import { z } from "zod";

import { V18_BUNDLE_VERSION } from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const PROVIDER_ACCESS_POLICY_SCHEMA_VERSION = "provider_access_policy.v1" as const;

const bundleVersionSchema = z.literal(V18_BUNDLE_VERSION);

/**
 * Live-route entry shape. Only fields that the helpers consult are typed;
 * everything else round-trips through `.passthrough()` so APR can carry
 * route-specific metadata without forcing a contract bump.
 */
export const providerAccessPolicyRouteSchema = z
  .object({
    access_path: z.string(),
    api_allowed: z.boolean(),
    provider_family: z.string(),
    oracle_allowed: z.boolean().optional(),
    evidence_required: z.boolean().optional(),
    eligible_for_synthesis: z.boolean().optional(),
    model: z.string().optional(),
    purpose: z.string().optional(),
  })
  .passthrough();
export type ProviderAccessPolicyRoute = z.infer<typeof providerAccessPolicyRouteSchema>;

export const providerAccessPolicySchema = z
  .object({
    schema_version: z.literal(PROVIDER_ACCESS_POLICY_SCHEMA_VERSION),
    bundle_version: bundleVersionSchema,
    live_routes: z.record(z.string(), providerAccessPolicyRouteSchema),
    forbidden_live_substitutions: z.array(z.string()),
    allowed_api_routes: z.array(z.string()),
    runtime_invariants: z.array(z.string()),
  })
  .passthrough();
export type ProviderAccessPolicy = z.infer<typeof providerAccessPolicySchema>;

// ─── Slot taxonomy ───────────────────────────────────────────────────────────

/**
 * Workflow slots that require Oracle browser evidence and forbid direct
 * provider-API substitution. Sourced from oracle-cv6 and the
 * `forbidden_live_substitutions` array in
 * `fixtures/provider-access-policy.json`.
 */
export const PROTECTED_SLOTS = [
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
  "gemini_deep_think",
] as const;
export type ProtectedSlot = (typeof PROTECTED_SLOTS)[number];

/**
 * Workflow slots that are explicitly API-allowed (APR-owned routes that
 * Oracle does not gate behind browser evidence).
 */
export const API_ALLOWED_SLOTS = [
  "xai_grok_reasoning",
  "deepseek_v4_pro_reasoning_search",
] as const;
export type ApiAllowedSlot = (typeof API_ALLOWED_SLOTS)[number];

/**
 * Workflow slots that are neither protected nor API-allowed; these route
 * through caller-side subscription CLIs (Claude Code, Codex). API
 * substitution is forbidden but the gate is owned outside Oracle.
 */
export const NON_ORACLE_CLI_SLOTS = [
  "claude_code_opus",
  "codex_intake",
  "codex_thinking_fast_draft",
] as const;
export type NonOracleCliSlot = (typeof NON_ORACLE_CLI_SLOTS)[number];

const PROTECTED_SLOT_SET: ReadonlySet<string> = new Set(PROTECTED_SLOTS);
const API_ALLOWED_SLOT_SET: ReadonlySet<string> = new Set(API_ALLOWED_SLOTS);
const NON_ORACLE_CLI_SLOT_SET: ReadonlySet<string> = new Set(NON_ORACLE_CLI_SLOTS);

export function isProtectedSlot(slot: unknown): slot is ProtectedSlot {
  return typeof slot === "string" && PROTECTED_SLOT_SET.has(slot);
}

export function isApiAllowedSlot(slot: unknown): slot is ApiAllowedSlot {
  return typeof slot === "string" && API_ALLOWED_SLOT_SET.has(slot);
}

export function isNonOracleCliSlot(slot: unknown): slot is NonOracleCliSlot {
  return typeof slot === "string" && NON_ORACLE_CLI_SLOT_SET.has(slot);
}

// ─── Access-path taxonomy ────────────────────────────────────────────────────

/**
 * Access-path values that satisfy `evidence_required` for protected
 * browser slots. Sourced from the live_routes block of the canonical
 * fixture and `docs/provider-access-policy.md`.
 */
export const ORACLE_BROWSER_ACCESS_PATHS = [
  "oracle_browser_remote",
  "oracle_browser_local",
  // The bundle fixture uses the disjunctive literal when either local or
  // remote is acceptable; we accept both forms.
  "oracle_browser_remote_or_local",
] as const;
export type OracleBrowserAccessPath = (typeof ORACLE_BROWSER_ACCESS_PATHS)[number];

const ORACLE_BROWSER_ACCESS_PATH_SET: ReadonlySet<string> = new Set(ORACLE_BROWSER_ACCESS_PATHS);

export function isOracleBrowserAccessPath(value: unknown): value is OracleBrowserAccessPath {
  return typeof value === "string" && ORACLE_BROWSER_ACCESS_PATH_SET.has(value);
}

/**
 * Required browser provider_family for each protected slot. ChatGPT Pro
 * slots must originate from the `chatgpt` family; gemini_deep_think must
 * originate from the `gemini` family. Anything else is an API
 * substitution attempt.
 */
export const PROTECTED_SLOT_FAMILY: Record<ProtectedSlot, "chatgpt" | "gemini"> = {
  chatgpt_pro_first_plan: "chatgpt",
  chatgpt_pro_synthesis: "chatgpt",
  gemini_deep_think: "gemini",
};

/**
 * The `error_code` callers should attach to a failure envelope when a
 * forbidden API substitution is detected for a protected slot.
 */
export const PROTECTED_SLOT_UNVERIFIED_CODE: Record<ProtectedSlot, V18ErrorCode> = {
  chatgpt_pro_first_plan: "chatgpt_pro_unverified",
  chatgpt_pro_synthesis: "chatgpt_pro_unverified",
  gemini_deep_think: "gemini_deep_think_unverified",
};

// ─── Eligibility verdict ─────────────────────────────────────────────────────

export interface AccessReason {
  /** v18 error code if one applies. */
  code: V18ErrorCode | null;
  /** Dotted field path, e.g. `provider_result.access_path`. */
  field: string;
  message: string;
}

export interface AccessEligibilityVerdict {
  readonly eligible: boolean;
  readonly reasons: readonly AccessReason[];
}

const OK: AccessEligibilityVerdict = Object.freeze({ eligible: true, reasons: [] });

function fail(reasons: AccessReason[]): AccessEligibilityVerdict {
  return { eligible: false, reasons };
}

export interface SlotAccessInputs {
  /** Workflow slot the caller is trying to satisfy. */
  slot: string;
  /** `provider_family` from the provider-result (chatgpt, gemini, openai_api, ...). */
  providerFamily: string;
  /** `access_path` from the provider-result (oracle_browser_remote, openai_api, ...). */
  accessPath: string;
}

/**
 * Decide whether a (slot, provider_family, access_path) triple satisfies
 * the v18 provider-access policy.
 *
 * Returns `eligible: true` for any slot we do not own a gate on (so
 * Oracle's general-purpose CLI use outside vibe-planning keeps working).
 * Returns `eligible: false` with a v18 error code only when a protected
 * slot is attacked by an API substitution, or an API-allowed slot is
 * misrouted through Oracle browser automation.
 */
export function evaluateSlotAccess(inputs: SlotAccessInputs): AccessEligibilityVerdict {
  const { slot, providerFamily, accessPath } = inputs;
  const reasons: AccessReason[] = [];

  if (isProtectedSlot(slot)) {
    const requiredFamily = PROTECTED_SLOT_FAMILY[slot];
    const code = PROTECTED_SLOT_UNVERIFIED_CODE[slot];
    if (providerFamily !== requiredFamily) {
      reasons.push({
        code,
        field: "provider_result.provider_family",
        message: `slot ${slot} requires provider_family="${requiredFamily}", got "${providerFamily}"`,
      });
    }
    if (!isOracleBrowserAccessPath(accessPath)) {
      reasons.push({
        code,
        field: "provider_result.access_path",
        message: `slot ${slot} forbids API substitution; access_path must be one of ${ORACLE_BROWSER_ACCESS_PATHS.join(", ")} (got "${accessPath}")`,
      });
    }
    return reasons.length === 0 ? OK : fail(reasons);
  }

  if (isApiAllowedSlot(slot)) {
    if (isOracleBrowserAccessPath(accessPath)) {
      reasons.push({
        // API-allowed slots are explicitly API-routed; an Oracle browser
        // access_path here is a routing mistake, not a substitution attack,
        // but it still violates the contract.
        code: null,
        field: "provider_result.access_path",
        message: `slot ${slot} is API-allowed and must not route through Oracle browser automation (got "${accessPath}")`,
      });
      return fail(reasons);
    }
    return OK;
  }

  // Unknown / non-v18 slot: explicitly eligible. Oracle's general API
  // path is not policed here; it is gated at the capability layer.
  return OK;
}

/**
 * Returns `true` iff the given provider-result, identified by its slot
 * and access_path, looks like a forbidden API substitution attempt for a
 * protected workflow slot.
 */
export function isApiSubstitutionForbiddenFor(
  slot: string,
  providerFamily: string,
  accessPath: string,
): boolean {
  if (!isProtectedSlot(slot)) return false;
  return !evaluateSlotAccess({ slot, providerFamily, accessPath }).eligible;
}

/**
 * Build the metadata object Oracle should embed on protected-slot
 * provider-results so APR (and other consumers) can mechanically detect
 * forbidden substitutions without re-deriving policy. Returns `null` for
 * any non-v18 slot to keep general-purpose Oracle results untouched.
 */
export interface ProtectedSlotMetadata {
  protected_slot: true;
  api_substitution_allowed_for_this_slot: false;
  required_provider_family: "chatgpt" | "gemini";
  required_access_paths: readonly OracleBrowserAccessPath[];
  unverified_error_code: V18ErrorCode;
}

export function protectedSlotMetadataFor(slot: string): ProtectedSlotMetadata | null {
  if (!isProtectedSlot(slot)) return null;
  return {
    protected_slot: true,
    api_substitution_allowed_for_this_slot: false,
    required_provider_family: PROTECTED_SLOT_FAMILY[slot],
    required_access_paths: ORACLE_BROWSER_ACCESS_PATHS,
    unverified_error_code: PROTECTED_SLOT_UNVERIFIED_CODE[slot],
  };
}
