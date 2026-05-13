// Static capability registry — produces a CapabilityReport from local
// environment state with ZERO network calls. APR / vibe-planning will use
// this as the first Oracle preflight command, so it must be fast, free,
// boring, and deterministic.
//
// Each capability advertises:
//   * `supported`: the code path exists in this build of Oracle.
//   * `status`: ready | available | blocked | unsupported. `ready` means
//     the surface can be used right now; `available` means the code path
//     exists but local config is incomplete; `blocked` means we know it
//     will fail; `unsupported` means Oracle does not ship that adapter.
//   * `next_command` / `fix_command`: machine-readable recovery hints.
//
// Tokens, account identifiers, cookie values, raw DOM, screenshots, and
// auth headers are NEVER emitted. We only report ENV VAR NAMES + presence
// flags, plus the typed contract metadata that lives in this repo.

import {
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
} from "../v18/index.js";

export const ORACLE_CAPABILITIES_SCHEMA_VERSION = "oracle_capabilities.v1" as const;

export type CapabilityId =
  | "chatgpt_pro_browser"
  | "gemini_deep_think_browser"
  | "remote_browser"
  | "browser_leases"
  | "redacted_evidence"
  | "provider_access_policy"
  | "prompt_payload_format_passthrough"
  | "toon_prompt_blocks_passthrough"
  | "deepseek_adapter";

export type CapabilityStatus = "ready" | "available" | "blocked" | "unsupported";

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly supported: boolean;
  readonly status: CapabilityStatus;
  readonly description: string;
  readonly next_command: string | null;
  readonly fix_command: string | null;
  /** Non-secret metadata (schema versions, env var NAMES, flags, etc.). */
  readonly notes: Record<string, unknown>;
}

export interface CapabilityReport {
  readonly schema_version: typeof ORACLE_CAPABILITIES_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly generated_at: string;
  readonly tty: boolean;
  readonly ci: boolean;
  readonly capabilities: readonly CapabilityEntry[];
  readonly counts: {
    readonly total: number;
    readonly ready: number;
    readonly available: number;
    readonly blocked: number;
    readonly unsupported: number;
  };
}

export interface BuildCapabilityReportInput {
  /** Subset of process.env to consult. Pass an empty object for CI/fixtures. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  /** When provided, overrides the TTY auto-detect (tests set this to a fixed value). */
  readonly tty?: boolean;
}

const REMOTE_HOST_ENV = "ORACLE_REMOTE_HOST";
const REMOTE_TOKEN_ENV = "ORACLE_REMOTE_TOKEN";
const OPENAI_KEY_ENV = "OPENAI_API_KEY";
const GEMINI_KEY_ENV = "GEMINI_API_KEY";

function detectCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env.CI?.toLowerCase();
  return ci === "1" || ci === "true" || ci === "yes";
}

function envPresent(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function chatgptCapability(env: Readonly<Record<string, string | undefined>>): CapabilityEntry {
  const remotePreferred = envPresent(env, REMOTE_HOST_ENV) && envPresent(env, REMOTE_TOKEN_ENV);
  return {
    id: "chatgpt_pro_browser",
    supported: true,
    status: "available",
    description: "ChatGPT Pro browser path with selector manifest and redacted evidence.",
    next_command: remotePreferred
      ? "oracle --engine browser --model gpt-5.5-pro -p '...'"
      : "oracle browser doctor --json",
    fix_command: remotePreferred ? null : "set ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN to prefer remote browser",
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      requires_same_session_evidence: true,
      never_clicks_answer_now: true,
      remote_browser_preferred: remotePreferred,
    },
  };
}

function geminiCapability(env: Readonly<Record<string, string | undefined>>): CapabilityEntry {
  const remotePreferred = envPresent(env, REMOTE_HOST_ENV) && envPresent(env, REMOTE_TOKEN_ENV);
  return {
    id: "gemini_deep_think_browser",
    supported: true,
    status: "available",
    description: "Gemini Deep Think browser path with high-if-exposed strategy.",
    next_command: remotePreferred
      ? "oracle --engine browser --model gemini-3-pro -p '...'"
      : "oracle browser doctor --json",
    fix_command: remotePreferred ? null : "set ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN to prefer remote browser",
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      strategy: "high_if_exposed",
      never_substitutes_gemini_api: true,
      remote_browser_preferred: remotePreferred,
    },
  };
}

function remoteBrowserCapability(env: Readonly<Record<string, string | undefined>>): CapabilityEntry {
  const hostPresent = envPresent(env, REMOTE_HOST_ENV);
  const tokenPresent = envPresent(env, REMOTE_TOKEN_ENV);
  if (hostPresent && tokenPresent) {
    return {
      id: "remote_browser",
      supported: true,
      status: "ready",
      description: "Remote browser endpoint configured; preferred over local Chrome.",
      next_command: "oracle remote doctor --json",
      fix_command: null,
      notes: {
        host_env: REMOTE_HOST_ENV,
        token_env: REMOTE_TOKEN_ENV,
        host_present: true,
        token_present: true,
        endpoint_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
      },
    };
  }
  const missing = [
    hostPresent ? null : REMOTE_HOST_ENV,
    tokenPresent ? null : REMOTE_TOKEN_ENV,
  ].filter((value): value is string => value !== null);
  return {
    id: "remote_browser",
    supported: true,
    status: "available",
    description: "Remote browser code path exists but no remote endpoint is configured locally.",
    next_command: `set ${missing.join(" and ")} to enable remote browser`,
    fix_command: `set ${missing.join(" and ")} to enable remote browser`,
    notes: {
      host_env: REMOTE_HOST_ENV,
      token_env: REMOTE_TOKEN_ENV,
      host_present: hostPresent,
      token_present: tokenPresent,
      missing_env_vars: missing,
      endpoint_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    },
  };
}

function browserLeasesCapability(): CapabilityEntry {
  return {
    id: "browser_leases",
    supported: true,
    status: "ready",
    description: "Typed browser leases with TTL, status, and same-session policy.",
    next_command: "oracle browser leases list --json",
    fix_command: null,
    notes: {
      lease_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
      enforces_provider_locks: true,
    },
  };
}

function redactedEvidenceCapability(): CapabilityEntry {
  return {
    id: "redacted_evidence",
    supported: true,
    status: "ready",
    description: "Redacted browser evidence is the default; unsafe payloads are quarantined.",
    next_command: "oracle evidence show <session> --json",
    fix_command: null,
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      default_redaction_policy: "redacted",
      quarantine_excluded_from_normal_index: true,
    },
  };
}

function providerAccessPolicyCapability(): CapabilityEntry {
  return {
    id: "provider_access_policy",
    supported: true,
    status: "ready",
    description: "Typed protected-slot metadata and API-substitution guard surface.",
    next_command: "oracle capabilities --json",
    fix_command: null,
    notes: {
      policy_schema_version: PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
      api_substitution_guard: true,
    },
  };
}

function promptPayloadPassthroughCapability(): CapabilityEntry {
  return {
    id: "prompt_payload_format_passthrough",
    supported: true,
    status: "ready",
    description: "Prompt payload bytes pass through Oracle unchanged with prompt_sha256 provenance.",
    next_command: null,
    fix_command: null,
    notes: {
      preserves_byte_order: true,
      records_prompt_sha256: true,
    },
  };
}

function toonPassthroughCapability(): CapabilityEntry {
  return {
    id: "toon_prompt_blocks_passthrough",
    supported: true,
    status: "available",
    description:
      "TOON-encoded prompt blocks are passed through; canonical storage remains JSON until legal review opts in.",
    next_command: null,
    fix_command: "context_serialization_policy.policy_status=gated_optional; enable per project after legal review",
    notes: {
      context_serialization_policy_schema_version: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
      canonical_storage_format: "json",
      policy_status: "gated_optional",
      toon_rust_enabled_by_default: false,
    },
  };
}

function deepseekAdapterCapability(): CapabilityEntry {
  return {
    id: "deepseek_adapter",
    supported: false,
    status: "unsupported",
    description: "Oracle does not ship a DeepSeek adapter; APR routes DeepSeek directly.",
    next_command: null,
    fix_command: null,
    notes: {
      ownership: "apr",
      reason: "no DeepSeek adapter ownership for this workflow",
    },
  };
}

/**
 * Build a `CapabilityReport` from the supplied env + clock. Pure — no
 * filesystem reads, no network calls, no `process.env` access. Pass an
 * empty `env` object for fully deterministic CI/doc snapshots.
 */
export function buildCapabilityReport(input: BuildCapabilityReportInput): CapabilityReport {
  const capabilities: CapabilityEntry[] = [
    chatgptCapability(input.env),
    geminiCapability(input.env),
    remoteBrowserCapability(input.env),
    browserLeasesCapability(),
    redactedEvidenceCapability(),
    providerAccessPolicyCapability(),
    promptPayloadPassthroughCapability(),
    toonPassthroughCapability(),
    deepseekAdapterCapability(),
  ];
  // Stable ordering: caller already constructed in declaration order;
  // alphabetize by id for deterministic snapshot tests.
  capabilities.sort((a, b) => a.id.localeCompare(b.id));

  const counts = capabilities.reduce(
    (acc, entry) => {
      acc.total += 1;
      acc[entry.status] = (acc[entry.status] ?? 0) + 1;
      return acc;
    },
    { total: 0, ready: 0, available: 0, blocked: 0, unsupported: 0 } as {
      total: number;
      ready: number;
      available: number;
      blocked: number;
      unsupported: number;
    },
  );

  return {
    schema_version: ORACLE_CAPABILITIES_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    generated_at: input.now.toISOString(),
    tty: input.tty ?? false,
    ci: detectCi(input.env),
    capabilities,
    counts,
    // Reference: env var names callers can hand off for credentials.
    // Listed here for the benefit of robot callers; never the values.
    ...({
      env_var_names: {
        remote_host: REMOTE_HOST_ENV,
        remote_token: REMOTE_TOKEN_ENV,
        openai_api_key: OPENAI_KEY_ENV,
        gemini_api_key: GEMINI_KEY_ENV,
      },
    } as Record<string, unknown>),
  };
}

export function capabilityById(
  report: CapabilityReport,
  id: CapabilityId,
): CapabilityEntry | undefined {
  return report.capabilities.find((entry) => entry.id === id);
}
