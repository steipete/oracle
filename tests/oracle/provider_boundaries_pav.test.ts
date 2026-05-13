import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  contextSerializationPolicySchema,
} from "../../src/oracle/v18/index.ts";
import {
  createContextSerializationBoundary,
  digestContextSerializationPolicy,
} from "../../src/oracle/v18/context_serialization_pav.js";
import {
  createProviderBoundaryPavSnapshot,
  providerBoundaryMetadataContainsRawPrompt,
} from "../../src/oracle/provider_boundaries_pav.js";

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function contextSerializationPolicyFixture() {
  return {
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
}

describe("PAV provider boundary snapshots", () => {
  test("preserves provider prompt bytes while keeping raw prompt out of metadata", () => {
    const policy = contextSerializationPolicySchema.parse(contextSerializationPolicyFixture());
    const prompt = [
      "unique-provider-boundary-prompt",
      "```toon",
      "items[2]{id,name}:",
      "  1,Ada",
      "  2,Linus",
      "```",
      "",
    ].join("\n");

    const snapshot = createProviderBoundaryPavSnapshot({
      providerPrompt: prompt,
      providerFamily: "chatgpt",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "browser",
      contextSerializationPolicy: policy,
    });

    expect(snapshot.providerPrompt).toBe(prompt);
    expect(snapshot.metadata.prompt_sha256).toBe(sha256(prompt));
    expect(snapshot.metadata.prompt_bytes).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(snapshot.metadata.prompt_semantics).toBe("unchanged");
    expect(snapshot.metadata.raw_prompt_in_metadata).toBe(false);
    expect(providerBoundaryMetadataContainsRawPrompt(snapshot.metadata, prompt)).toBe(false);
    expect(JSON.stringify(snapshot.metadata)).not.toContain("unique-provider-boundary-prompt");
    expect(snapshot.metadata.context_serialization.warnings.map((warning) => warning.code)).toEqual(
      ["toon_prompt_blocks_json_fallback", "toon_rust_policy_not_executed"],
    );
  });

  test("flags API substitution attempts for protected workflow slots", () => {
    const snapshot = createProviderBoundaryPavSnapshot({
      providerPrompt: "plan with prompt bytes preserved",
      providerFamily: "openai",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "api",
      accessPath: "openai_api",
    });

    expect(snapshot.metadata.policy_scope).toBe("protected_workflow_slot");
    expect(snapshot.metadata.ownership).toBe("oracle_browser");
    expect(snapshot.metadata.protected_slot_metadata).toMatchObject({
      protected_slot: true,
      api_substitution_allowed_for_this_slot: false,
      required_provider_family: "chatgpt",
      unverified_error_code: "chatgpt_pro_unverified",
    });
    expect(snapshot.metadata.slot_access.eligible).toBe(false);
    expect(snapshot.metadata.slot_access.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "provider_result.provider_family" }),
        expect.objectContaining({ field: "provider_result.access_path" }),
      ]),
    );
  });

  test("allows verified browser transport for protected slots", () => {
    const snapshot = createProviderBoundaryPavSnapshot({
      providerPrompt: "browser prompt",
      providerFamily: "gemini",
      providerSlot: "gemini_deep_think",
      requestedMode: "browser",
    });

    expect(snapshot.metadata.access_path).toBe("oracle_browser_remote_or_local");
    expect(snapshot.metadata.slot_access).toEqual({ eligible: true, reasons: [] });
    expect(snapshot.metadata.protected_slot_metadata?.required_provider_family).toBe("gemini");
  });

  test("ordinary Oracle API usage remains outside protected workflow policy", () => {
    const prompt = "general-purpose Oracle request";
    const snapshot = createProviderBoundaryPavSnapshot({
      providerPrompt: prompt,
      providerFamily: "openai",
      providerSlot: "gpt-5.2",
      requestedMode: "api",
    });

    expect(snapshot.providerPrompt).toBe(prompt);
    expect(snapshot.metadata.access_path).toBe("openai_api");
    expect(snapshot.metadata.policy_scope).toBe("ordinary_oracle_usage");
    expect(snapshot.metadata.ownership).toBe("ordinary_oracle");
    expect(snapshot.metadata.protected_slot_metadata).toBeNull();
    expect(snapshot.metadata.slot_access).toEqual({ eligible: true, reasons: [] });
  });
});

describe("PAV context serialization boundary", () => {
  test("summarizes JSON canonical storage and TOON passthrough without owning toon_rust", () => {
    const policy = contextSerializationPolicySchema.parse(contextSerializationPolicyFixture());
    const boundary = createContextSerializationBoundary({
      policy,
      prompt: "```toon\nrows[1]{id}: 1\n```",
    });

    expect(boundary).toMatchObject({
      prompt_payload_format_passthrough: true,
      toon_prompt_blocks_passthrough: true,
      provider_payload_format: "text",
      provider_payload_semantics: "unchanged",
      canonical_storage_format: "json",
      fallback_format: "json",
      default_effective_format: "json",
      canonical_artifacts_remain_json: true,
      json_cli_output_remains_json: true,
      owns_toon_rust: false,
      requires_toon_rust: false,
      invokes_toon_rust: false,
      decodes_toon: false,
      validates_toon: false,
      policy_status: "gated_optional",
      prompt_context_preference: "json",
    });
    expect(boundary.policy_hash).toMatchObject({
      source: "context_serialization_policy",
      algorithm: "sha256",
    });
    expect(boundary.warnings.map((warning) => warning.code)).toEqual([
      "toon_prompt_blocks_json_fallback",
      "toon_rust_policy_not_executed",
    ]);
  });

  test("hashes context serialization policy independent of key order", () => {
    const left = {
      canonical_storage_format: "json",
      fallback_format: "json",
      toon_rust: { strict_decode: true, required: false },
    };
    const right = {
      toon_rust: { required: false, strict_decode: true },
      fallback_format: "json",
      canonical_storage_format: "json",
    };

    expect(digestContextSerializationPolicy(left)).toEqual(
      digestContextSerializationPolicy(right),
    );
  });
});
