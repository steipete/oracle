import { createHash } from "node:crypto";

import {
  API_ALLOWED_SLOTS,
  NON_ORACLE_CLI_SLOTS,
  PROTECTED_SLOTS,
  evaluateSlotAccess,
  protectedSlotMetadataFor,
  type AccessEligibilityVerdict,
  type ProtectedSlotMetadata,
} from "./v18/provider_access_policy.js";
import {
  createContextSerializationBoundary,
  type ContextSerializationBoundary,
} from "./v18/context_serialization_pav.js";
import type { ContextSerializationPolicyLike } from "./toon_passthrough.js";
import type { PromptTransportRequestedMode } from "../types/transport.js";

export const PROVIDER_BOUNDARY_PAV_SCHEMA_VERSION = "oracle.provider_boundary_pav.v1" as const;

export type ProviderBoundaryPavOwnership =
  | "oracle_browser"
  | "external_user_cli"
  | "external_user_api"
  | "ordinary_oracle";

export interface ProviderBoundaryPavMetadata {
  readonly schema_version: typeof PROVIDER_BOUNDARY_PAV_SCHEMA_VERSION;
  readonly provider_family: string;
  readonly provider_slot: string;
  readonly requested_mode: PromptTransportRequestedMode;
  readonly access_path: string;
  readonly prompt_sha256: `sha256:${string}`;
  readonly prompt_bytes: number;
  readonly prompt_semantics: "unchanged";
  readonly raw_prompt_in_metadata: false;
  readonly ownership: ProviderBoundaryPavOwnership;
  readonly policy_scope: "protected_workflow_slot" | "api_allowed_workflow_slot" | "non_oracle_cli_slot" | "ordinary_oracle_usage";
  readonly slot_access: AccessEligibilityVerdict;
  readonly protected_slot_metadata: ProtectedSlotMetadata | null;
  readonly context_serialization: ContextSerializationBoundary;
  readonly boundary_roles: {
    readonly oracle: "provider_transport_and_evidence";
    readonly apr: "semantic_prompt_planning_and_synthesis";
  };
}

export interface ProviderBoundaryPavSnapshot {
  /**
   * The exact bytes Oracle should hand to the provider. It is separated
   * from metadata so callers can prove pass-through while keeping raw
   * prompt text out of telemetry.
   */
  readonly providerPrompt: string;
  readonly metadata: ProviderBoundaryPavMetadata;
}

export interface CreateProviderBoundaryPavSnapshotInput {
  readonly providerPrompt: string;
  readonly providerFamily: string;
  readonly providerSlot: string;
  readonly requestedMode: PromptTransportRequestedMode;
  readonly accessPath?: string;
  readonly contextSerializationPolicy?: ContextSerializationPolicyLike;
}

const PROTECTED_SLOT_SET: ReadonlySet<string> = new Set(PROTECTED_SLOTS);
const API_ALLOWED_SLOT_SET: ReadonlySet<string> = new Set(API_ALLOWED_SLOTS);
const NON_ORACLE_CLI_SLOT_SET: ReadonlySet<string> = new Set(NON_ORACLE_CLI_SLOTS);

export function createProviderBoundaryPavSnapshot(
  input: CreateProviderBoundaryPavSnapshotInput,
): ProviderBoundaryPavSnapshot {
  const accessPath = input.accessPath ?? defaultAccessPath(input);
  const slotAccess = evaluateSlotAccess({
    slot: input.providerSlot,
    providerFamily: input.providerFamily,
    accessPath,
  });
  const contextSerialization = createContextSerializationBoundary({
    policy: input.contextSerializationPolicy,
    prompt: input.providerPrompt,
  });

  return {
    providerPrompt: input.providerPrompt,
    metadata: {
      schema_version: PROVIDER_BOUNDARY_PAV_SCHEMA_VERSION,
      provider_family: input.providerFamily,
      provider_slot: input.providerSlot,
      requested_mode: input.requestedMode,
      access_path: accessPath,
      prompt_sha256: sha256(input.providerPrompt),
      prompt_bytes: Buffer.byteLength(input.providerPrompt, "utf8"),
      prompt_semantics: "unchanged",
      raw_prompt_in_metadata: false,
      ownership: ownershipForSlot(input.providerSlot),
      policy_scope: policyScopeForSlot(input.providerSlot),
      slot_access: slotAccess,
      protected_slot_metadata: protectedSlotMetadataFor(input.providerSlot),
      context_serialization: contextSerialization,
      boundary_roles: {
        oracle: "provider_transport_and_evidence",
        apr: "semantic_prompt_planning_and_synthesis",
      },
    },
  };
}

export function providerBoundaryMetadataContainsRawPrompt(
  metadata: ProviderBoundaryPavMetadata,
  prompt: string,
): boolean {
  return prompt.length > 0 && JSON.stringify(metadata).includes(prompt);
}

function defaultAccessPath(input: CreateProviderBoundaryPavSnapshotInput): string {
  if (input.requestedMode === "browser") return "oracle_browser_remote_or_local";
  if (input.requestedMode === "file-bundle") return "oracle_file_bundle";
  return `${input.providerFamily}_api`;
}

function ownershipForSlot(slot: string): ProviderBoundaryPavOwnership {
  if (PROTECTED_SLOT_SET.has(slot)) return "oracle_browser";
  if (NON_ORACLE_CLI_SLOT_SET.has(slot)) return "external_user_cli";
  if (API_ALLOWED_SLOT_SET.has(slot)) return "external_user_api";
  return "ordinary_oracle";
}

function policyScopeForSlot(
  slot: string,
): ProviderBoundaryPavMetadata["policy_scope"] {
  if (PROTECTED_SLOT_SET.has(slot)) return "protected_workflow_slot";
  if (API_ALLOWED_SLOT_SET.has(slot)) return "api_allowed_workflow_slot";
  if (NON_ORACLE_CLI_SLOT_SET.has(slot)) return "non_oracle_cli_slot";
  return "ordinary_oracle_usage";
}

function sha256(input: string): `sha256:${string}` {
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  return `sha256:${digest}`;
}
