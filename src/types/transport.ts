export type PromptTransportRequestedMode = "api" | "browser" | "file-bundle";

export type PromptTransportProviderFamily = "openai" | "anthropic" | "google" | "xai" | "other";

export type PromptTransportRedactionDecision =
  | "raw_prompt_omitted"
  | "raw_output_omitted"
  | "raw_dom_omitted"
  | "cookies_omitted"
  | "screenshots_omitted"
  | "hidden_reasoning_omitted"
  | "input_hashes_only"
  | "untrusted_source_instructions_are_user_data"
  | (string & {});

export interface PromptTransportInputHash {
  source: "system_prompt" | "user_prompt" | "context_serialization_policy" | (string & {});
  algorithm: "sha256";
  value: string;
}

export interface PromptTransportSettings {
  search_enabled?: boolean;
  background?: boolean;
  store_response?: boolean;
  previous_response_id?: boolean;
  [key: string]: string | number | boolean | undefined;
}

export interface PromptTransportMetadata {
  schema_version: "oracle.prompt_transport.v1";
  provider_family: PromptTransportProviderFamily;
  provider_slot: string;
  requested_mode: PromptTransportRequestedMode;
  policy_family: "oracle.prompt_transport";
  policy_version: "v1";
  prompt_semantics: "unchanged";
  evidence_policy: string;
  included_sections: string[];
  excluded_sections: string[];
  input_hashes: PromptTransportInputHash[];
  context_serialization_policy_hash: PromptTransportInputHash;
  redaction_decisions: PromptTransportRedactionDecision[];
  transport_settings: PromptTransportSettings;
  token_budget?: number;
}

export interface PromptTransportMetadataOptions {
  providerFamily?: PromptTransportProviderFamily;
  providerSlot?: string;
  requestedMode?: PromptTransportRequestedMode;
  evidencePolicy?: string;
  includedSections?: string[];
  excludedSections?: string[];
  tokenBudget?: number;
  contextSerializationPolicyHash?: PromptTransportInputHash;
  redactionDecisions?: PromptTransportRedactionDecision[];
  transportSettings?: PromptTransportSettings;
}

export const PROMPT_TRANSPORT_METADATA_KEY = Symbol.for("oracle.prompt_transport_metadata");

export function attachPromptTransportMetadata<T extends object>(
  target: T,
  metadata: PromptTransportMetadata,
): T {
  Object.defineProperty(target, PROMPT_TRANSPORT_METADATA_KEY, {
    configurable: true,
    enumerable: false,
    value: cloneTransportMetadata(metadata),
    writable: false,
  });
  return target;
}

export function getPromptTransportMetadata(
  target: object | null | undefined,
): PromptTransportMetadata | undefined {
  if (!target) return undefined;
  return (target as Record<symbol, PromptTransportMetadata | undefined>)[
    PROMPT_TRANSPORT_METADATA_KEY
  ];
}

function cloneTransportMetadata(metadata: PromptTransportMetadata): PromptTransportMetadata {
  return JSON.parse(JSON.stringify(metadata)) as PromptTransportMetadata;
}
