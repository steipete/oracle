import { describe, expect, test } from "vitest";

import { createProviderBoundaryPavSnapshot } from "@src/oracle/provider_boundaries_pav.ts";
import {
  PAV_SESSION_NAMESPACE_SCHEMA_VERSION,
  assertNoRawPromptInMetadata,
  attachPavToProviderResult,
  attachPavToSessionRecord,
  isOrdinaryOracleUsage,
  projectPavMetadata,
  readPavBoundaries,
  type PavBoundaryMetadata,
  type ProviderResultLike,
} from "@src/oracle/v18/pav_wiring.ts";

const SECRET_PROMPT = "PLEASE_DO_NOT_LEAK_THIS_PROMPT_BODY";

function buildSnapshot(overrides: {
  providerSlot?: string;
  providerFamily?: string;
  requestedMode?: "browser" | "api" | "file-bundle";
  prompt?: string;
} = {}) {
  return createProviderBoundaryPavSnapshot({
    providerPrompt: overrides.prompt ?? SECRET_PROMPT,
    providerFamily: overrides.providerFamily ?? "chatgpt",
    providerSlot: overrides.providerSlot ?? "chatgpt_pro_first_plan",
    requestedMode: overrides.requestedMode ?? "browser",
  });
}

describe("projectPavMetadata strips boundary_roles but keeps everything else", () => {
  test("returned metadata omits boundary_roles", () => {
    const snap = buildSnapshot();
    const projected = projectPavMetadata(snap);
    expect((projected as Record<string, unknown>).boundary_roles).toBeUndefined();
    expect(projected.schema_version).toBe(snap.metadata.schema_version);
    expect(projected.prompt_sha256).toBe(snap.metadata.prompt_sha256);
    expect(projected.prompt_bytes).toBe(snap.metadata.prompt_bytes);
    expect(projected.prompt_semantics).toBe("unchanged");
    expect(projected.raw_prompt_in_metadata).toBe(false);
    expect(projected.ownership).toBe("oracle_browser");
  });

  test("the raw prompt body never appears in projected metadata", () => {
    const snap = buildSnapshot();
    const serialized = JSON.stringify(projectPavMetadata(snap));
    expect(serialized).not.toContain(SECRET_PROMPT);
  });
});

describe("isOrdinaryOracleUsage", () => {
  test("returns true for unknown slots (ordinary Oracle use)", () => {
    const snap = createProviderBoundaryPavSnapshot({
      providerPrompt: "hello",
      providerFamily: "openai",
      providerSlot: "general_oracle_api_run",
      requestedMode: "api",
    });
    expect(isOrdinaryOracleUsage(snap)).toBe(true);
  });

  test("returns false for protected ChatGPT Pro slot", () => {
    expect(isOrdinaryOracleUsage(buildSnapshot())).toBe(false);
  });
});

describe("attachPavToProviderResult", () => {
  const baseResult: ProviderResultLike = {
    schema_version: "provider_result.v1",
    provider_slot: "chatgpt_pro_first_plan",
    provider_family: "chatgpt",
    access_path: "oracle_browser_remote",
    prompt_manifest_sha256: `sha256:${"a".repeat(64)}`,
    status: "success",
  };

  test("adds pav_boundary block for protected workflow slot", () => {
    const snap = buildSnapshot();
    const updated = attachPavToProviderResult(baseResult, snap);
    const pav = (updated as Record<string, unknown>).pav_boundary as PavBoundaryMetadata;
    expect(pav).toBeDefined();
    expect(pav.policy_scope).toBe("protected_workflow_slot");
    expect(pav.ownership).toBe("oracle_browser");
    expect(pav.protected_slot_metadata).not.toBeNull();
    expect(pav.prompt_sha256).toBe(snap.metadata.prompt_sha256);
    expect(pav.raw_prompt_in_metadata).toBe(false);
  });

  test("returns input unchanged for ordinary Oracle usage", () => {
    const ordinarySnapshot = createProviderBoundaryPavSnapshot({
      providerPrompt: "hi",
      providerFamily: "openai",
      providerSlot: "general_oracle_api_run",
      requestedMode: "api",
    });
    const updated = attachPavToProviderResult(baseResult, ordinarySnapshot);
    expect(updated).toBe(baseResult); // referential equality preserved
    expect((updated as Record<string, unknown>).pav_boundary).toBeUndefined();
  });

  test("attached provider_result never carries raw prompt text", () => {
    const snap = buildSnapshot();
    const updated = attachPavToProviderResult(baseResult, snap);
    expect(JSON.stringify(updated)).not.toContain(SECRET_PROMPT);
  });

  test("preserves existing fields on the provider_result", () => {
    const snap = buildSnapshot();
    const updated = attachPavToProviderResult(baseResult, snap) as Record<string, unknown>;
    expect(updated.schema_version).toBe(baseResult.schema_version);
    expect(updated.provider_slot).toBe(baseResult.provider_slot);
    expect(updated.prompt_manifest_sha256).toBe(baseResult.prompt_manifest_sha256);
    expect(updated.status).toBe(baseResult.status);
  });
});

describe("attachPavToSessionRecord", () => {
  test("attaches a session_pav.v1 block with one boundary", () => {
    const session = { id: "sess-1", options: { prompt: SECRET_PROMPT } };
    const snap = buildSnapshot();
    const updated = attachPavToSessionRecord(session, snap);
    const pav = (updated as Record<string, unknown>).pav as {
      schema_version: string;
      boundaries: PavBoundaryMetadata[];
    };
    expect(pav.schema_version).toBe(PAV_SESSION_NAMESPACE_SCHEMA_VERSION);
    expect(pav.boundaries).toHaveLength(1);
    expect(pav.boundaries[0].provider_slot).toBe("chatgpt_pro_first_plan");
  });

  test("appends to existing boundaries in stable order", () => {
    const session = { id: "sess-1" };
    const first = attachPavToSessionRecord(
      session,
      buildSnapshot({ providerSlot: "chatgpt_pro_first_plan" }),
    );
    const second = attachPavToSessionRecord(
      first,
      buildSnapshot({ providerSlot: "chatgpt_pro_synthesis" }),
    );
    const boundaries = readPavBoundaries(second);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].provider_slot).toBe("chatgpt_pro_first_plan");
    expect(boundaries[1].provider_slot).toBe("chatgpt_pro_synthesis");
  });

  test("returns session unchanged for ordinary Oracle usage (preserves existing behavior)", () => {
    const session = { id: "sess-1", options: { prompt: "hello" } };
    const ordinarySnap = createProviderBoundaryPavSnapshot({
      providerPrompt: "hello",
      providerFamily: "openai",
      providerSlot: "general_oracle_api_run",
      requestedMode: "api",
    });
    const updated = attachPavToSessionRecord(session, ordinarySnap);
    expect(updated).toBe(session);
    expect(readPavBoundaries(updated)).toEqual([]);
  });

  test("session record after attach never carries raw prompt text", () => {
    // The original session.options.prompt is still present (we don't
    // touch it); the PAV block itself must NOT mirror the body.
    const session = { id: "sess-1", options: {} };
    const snap = buildSnapshot();
    const updated = attachPavToSessionRecord(session, snap);
    // Check the pav block specifically — never serializes the prompt.
    const pavOnly = JSON.stringify(
      (updated as Record<string, unknown>).pav,
    );
    expect(pavOnly).not.toContain(SECRET_PROMPT);
  });

  test("preserves existing top-level session fields", () => {
    const session = {
      id: "sess-1",
      createdAt: "2026-05-12T00:00:00Z",
      mode: "browser",
      status: "running",
    };
    const updated = attachPavToSessionRecord(session, buildSnapshot()) as Record<string, unknown>;
    expect(updated.id).toBe("sess-1");
    expect(updated.createdAt).toBe("2026-05-12T00:00:00Z");
    expect(updated.mode).toBe("browser");
    expect(updated.status).toBe("running");
  });
});

describe("assertNoRawPromptInMetadata invariant", () => {
  test("accepts valid PAV metadata", () => {
    const snap = buildSnapshot();
    expect(() => assertNoRawPromptInMetadata(projectPavMetadata(snap))).not.toThrow();
  });

  test("throws if a leak surface introduces providerPrompt / raw_prompt / prompt_text", () => {
    expect(() => assertNoRawPromptInMetadata({ providerPrompt: "leak" })).toThrow(/leak detected/i);
    expect(() => assertNoRawPromptInMetadata({ meta: { raw_prompt: "leak" } })).toThrow(
      /leak detected/i,
    );
    expect(() => assertNoRawPromptInMetadata({ prompt_text: "leak" })).toThrow(/leak detected/i);
  });

  test("null/undefined payload is a no-op", () => {
    expect(() => assertNoRawPromptInMetadata(null)).not.toThrow();
    expect(() => assertNoRawPromptInMetadata(undefined)).not.toThrow();
  });
});

describe("acceptance: provider results/session metadata expose the required fields", () => {
  test("provider_result + session both expose prompt_sha256, policy_scope, protected_slot_metadata, context_serialization", () => {
    const snap = buildSnapshot();
    const result = attachPavToProviderResult(
      {
        schema_version: "provider_result.v1",
        provider_slot: snap.metadata.provider_slot,
      } as ProviderResultLike,
      snap,
    );
    const session = attachPavToSessionRecord({ id: "sess-acceptance" }, snap);

    const pavOnResult = (result as Record<string, unknown>).pav_boundary as PavBoundaryMetadata;
    const boundariesOnSession = readPavBoundaries(session);

    for (const block of [pavOnResult, boundariesOnSession[0]]) {
      expect(block.prompt_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(block.policy_scope).toBe("protected_workflow_slot");
      expect(block.protected_slot_metadata).toMatchObject({
        protected_slot: true,
        api_substitution_allowed_for_this_slot: false,
      });
      expect(block.context_serialization).toBeDefined();
      expect(block.raw_prompt_in_metadata).toBe(false);
    }
  });
});
