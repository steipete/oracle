import { createHash } from "node:crypto";

import {
  createToonPromptPassthrough,
  getToonPassthroughCapabilities,
  summarizeContextSerializationPolicy,
  type ContextSerializationPolicyLike,
  type ToonPolicyMetadata,
} from "../toon_passthrough.js";

export const CONTEXT_SERIALIZATION_BOUNDARY_SCHEMA_VERSION =
  "oracle.context_serialization_boundary.v1" as const;

export interface ContextSerializationBoundaryWarning {
  readonly code: string;
  readonly severity: "warning";
  readonly message: string;
}

export interface ContextSerializationBoundary {
  readonly schema_version: typeof CONTEXT_SERIALIZATION_BOUNDARY_SCHEMA_VERSION;
  readonly prompt_payload_format_passthrough: true;
  readonly toon_prompt_blocks_passthrough: true;
  readonly provider_payload_format: "text";
  readonly provider_payload_semantics: "unchanged";
  readonly canonical_storage_format: string;
  readonly fallback_format: string;
  readonly default_effective_format: string;
  readonly canonical_artifacts_remain_json: boolean;
  readonly json_cli_output_remains_json: boolean;
  readonly owns_toon_rust: false;
  readonly requires_toon_rust: false;
  readonly invokes_toon_rust: false;
  readonly decodes_toon: false;
  readonly validates_toon: false;
  readonly policy_status: string;
  readonly prompt_context_preference: string;
  readonly policy_hash: {
    readonly source: "context_serialization_policy";
    readonly algorithm: "sha256";
    readonly value: string;
  };
  readonly policy_metadata: ToonPolicyMetadata;
  readonly warnings: readonly ContextSerializationBoundaryWarning[];
}

export interface CreateContextSerializationBoundaryInput {
  readonly policy?: ContextSerializationPolicyLike;
  /**
   * Optional prompt bytes. When present, warnings can mention observed
   * TOON blocks. The prompt itself is never stored on metadata.
   */
  readonly prompt?: string;
}

export function createContextSerializationBoundary(
  input: CreateContextSerializationBoundaryInput = {},
): ContextSerializationBoundary {
  const policyMetadata = summarizeContextSerializationPolicy(input.policy);
  const passthrough = createToonPromptPassthrough(input.prompt ?? "", {
    contextSerializationPolicy: input.policy,
  });
  const capabilities = getToonPassthroughCapabilities();

  return {
    schema_version: CONTEXT_SERIALIZATION_BOUNDARY_SCHEMA_VERSION,
    prompt_payload_format_passthrough: capabilities.prompt_payload_format_passthrough,
    toon_prompt_blocks_passthrough: capabilities.toon_prompt_blocks_passthrough,
    provider_payload_format: capabilities.provider_payload_format,
    provider_payload_semantics: capabilities.provider_payload_semantics,
    canonical_storage_format: policyMetadata.canonical_storage_format,
    fallback_format: policyMetadata.fallback_format,
    default_effective_format: policyMetadata.default_effective_format,
    canonical_artifacts_remain_json: policyMetadata.canonical_storage_format === "json",
    json_cli_output_remains_json: true,
    owns_toon_rust: capabilities.owns_toon_rust,
    requires_toon_rust: capabilities.requires_toon_rust,
    invokes_toon_rust: capabilities.invokes_toon_rust,
    decodes_toon: capabilities.decodes_toon,
    validates_toon: capabilities.validates_toon,
    policy_status: policyMetadata.policy_status,
    prompt_context_preference: policyMetadata.prompt_context_preference,
    policy_hash: digestContextSerializationPolicy(input.policy),
    policy_metadata: policyMetadata,
    warnings: passthrough.warnings.map((warning) => ({
      code: warning.code,
      severity: warning.severity,
      message: warning.message,
    })),
  };
}

export function digestContextSerializationPolicy(
  policy?: ContextSerializationPolicyLike,
): ContextSerializationBoundary["policy_hash"] {
  const bytes = stableJson(policy ?? summarizeContextSerializationPolicy(undefined));
  return {
    source: "context_serialization_policy",
    algorithm: "sha256",
    value: createHash("sha256").update(bytes, "utf8").digest("hex"),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
