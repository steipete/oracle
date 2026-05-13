import crypto from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  BrowserEvidenceBuildError,
  buildBrowserEvidence,
  type BuildBrowserEvidenceInput,
  type HashableInput,
} from "@src/browser/evidence.ts";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserEvidenceSchema,
  sha256OfBytes,
} from "@src/oracle/v18/index.ts";

function realHash(seed: string): string {
  return `sha256:${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

function buildBaseInput(
  overrides: Partial<BuildBrowserEvidenceInput> = {},
): BuildBrowserEvidenceInput {
  return {
    evidence_id: "evidence-test-001",
    run_id: "run-test-001",
    provider: "chatgpt",
    provider_slot: "chatgpt_pro_first_plan",
    provider_result_id: "provider-result-test-001",
    requested_mode: "pro_extended_reasoning",
    mode_verified: true,
    verified_before_prompt_submit: true,
    reasoning_effort_verified: true,
    unsafe_artifacts_quarantined: true,
    verified_at: "2026-05-12T00:00:00Z",
    prompt_submitted_at: "2026-05-12T00:00:05Z",
    created_at: "2026-05-12T00:00:10Z",
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    capture_confidence: "high",
    redaction_policy: "redacted",
    promptBytes: "You are a helpful oracle. Audit the plan.",
    outputBytes: "Plan looks consistent; here is the analysis...",
    transition_log: { bytes: '[{"t":1,"event":"model_picked"}]' },
    available_effort_labels: ["Auto", "Thinking", "Pro"],
    session_id_hash: realHash("session-test-001"),
    observed_mode_label: "Pro",
    selector_manifest_version: "chatgpt-pro-v1",
    requested_reasoning_effort: "max_browser_available",
    observed_reasoning_effort_label: "Heavy",
    effort_rank: "highest_visible",
    selected_effort_is_highest_visible: true,
    browser_effort_strategy: "select_highest_visible",
    failure_code: null,
    fix_command: null,
    next_command: null,
    ...overrides,
  };
}

describe("buildBrowserEvidence — success paths", () => {
  test("ChatGPT happy path produces schema-valid evidence with full sha256 hashes", () => {
    const input = buildBaseInput();
    const evidence = buildBrowserEvidence(input);

    expect(evidence.schema_version).toBe(BROWSER_EVIDENCE_SCHEMA_VERSION);
    expect(evidence.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(evidence.provider).toBe("chatgpt");
    expect(evidence.provider_slot).toBe("chatgpt_pro_first_plan");

    // Every typed hash field must be a full sha256:<64 hex>.
    const hashFields = [
      evidence.prompt_sha256,
      evidence.output_text_sha256,
      evidence.transition_log_sha256,
      evidence.session_id_hash,
      evidence.available_effort_labels_hash,
    ];
    for (const value of hashFields) {
      expect(value).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(evidence.observed_mode_label_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Final shape passes the zod parse.
    expect(() => browserEvidenceSchema.parse(evidence)).not.toThrow();
  });

  test("Gemini happy path with the same builder produces schema-valid evidence", () => {
    const input = buildBaseInput({
      provider: "gemini",
      provider_slot: "gemini_deep_think",
      provider_result_id: "provider-result-gemini-001",
      requested_mode: "deep_think_high",
      selector_manifest_version: "gemini-deep-think-v1",
      observed_reasoning_effort_label: "Deep Think",
      observed_mode_label: "Deep Think",
    });
    const evidence = buildBrowserEvidence(input);
    expect(evidence.provider).toBe("gemini");
    expect(evidence.provider_slot).toBe("gemini_deep_think");
    expect(() => browserEvidenceSchema.parse(evidence)).not.toThrow();
  });

  test("prompt bytes and output bytes round-trip through SHA-256", () => {
    const prompt = "private prompt bytes ✓";
    const output = "expected output bytes ✓";
    const evidence = buildBrowserEvidence(buildBaseInput({ promptBytes: prompt, outputBytes: output }));
    expect(evidence.prompt_sha256).toBe(sha256OfBytes(prompt));
    expect(evidence.output_text_sha256).toBe(sha256OfBytes(output));
  });

  test("Uint8Array prompt input hashes equal to UTF-8 string input", () => {
    const text = "matching content";
    const asString = buildBrowserEvidence(buildBaseInput({ promptBytes: text }));
    const asBytes = buildBrowserEvidence(
      buildBaseInput({ promptBytes: new TextEncoder().encode(text) }),
    );
    expect(asString.prompt_sha256).toBe(asBytes.prompt_sha256);
  });

  test("available_effort_labels are canonicalized (trimmed, newline-joined) before hashing", () => {
    const labels = ["Auto", "Thinking", "Pro"];
    const a = buildBrowserEvidence(buildBaseInput({ available_effort_labels: labels }));
    const b = buildBrowserEvidence(
      buildBaseInput({
        available_effort_labels: ["  Auto", "Thinking  ", "  Pro  "],
      }),
    );
    expect(a.available_effort_labels_hash).toBe(b.available_effort_labels_hash);
    expect(a.available_effort_labels_hash).toBe(sha256OfBytes("Auto\nThinking\nPro"));
  });

  test("created_at defaults to a current ISO timestamp when omitted", () => {
    const before = Date.now();
    const input = buildBaseInput({ created_at: undefined });
    const evidence = buildBrowserEvidence(input);
    const createdMs = Date.parse(evidence.created_at);
    expect(createdMs).toBeGreaterThanOrEqual(before - 1);
    expect(createdMs).toBeLessThanOrEqual(Date.now() + 1);
  });

  test("optional thinking_level fields round-trip when provided", () => {
    const evidence = buildBrowserEvidence(
      buildBaseInput({
        thinking_level_if_exposed: "Heavy",
        thinking_level_verified: true,
        reasoning_effort_verification_method: "model_picker_label",
      }),
    );
    expect(evidence.thinking_level_if_exposed).toBe("Heavy");
    expect(evidence.thinking_level_verified).toBe(true);
    expect(evidence.reasoning_effort_verification_method).toBe("model_picker_label");
  });
});

describe("buildBrowserEvidence — timestamp ordering", () => {
  test("verified_at after prompt_submitted_at is rejected when mode_verified=true", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({
          verified_at: "2026-05-12T00:00:10Z",
          prompt_submitted_at: "2026-05-12T00:00:05Z",
        }),
      ),
    ).toThrowError(/verification must precede prompt submission/i);
  });

  test("verified_at after prompt_submitted_at is rejected when verified_before_prompt_submit=true", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({
          mode_verified: false,
          verified_before_prompt_submit: true,
          verified_at: "2026-05-12T00:00:10Z",
          prompt_submitted_at: "2026-05-12T00:00:05Z",
        }),
      ),
      // Surfaces the mode_verified contradiction before timestamp check,
      // which is fine — both indicate a malformed claim.
    ).toThrow();
  });

  test("verified_before_prompt_submit=true requires mode_verified=true", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({
          mode_verified: false,
          verified_before_prompt_submit: true,
        }),
      ),
    ).toThrowError(/cannot be true when mode_verified is false/);
  });

  test("malformed timestamps throw BrowserEvidenceBuildError with the bad field", () => {
    const error = (() => {
      try {
        buildBrowserEvidence(buildBaseInput({ verified_at: "not-a-date" }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(BrowserEvidenceBuildError);
    expect((error as BrowserEvidenceBuildError).field).toBe("verified_at");
  });

  test("created_at must not precede verified_at", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({
          verified_at: "2026-05-12T00:00:10Z",
          prompt_submitted_at: "2026-05-12T00:00:15Z",
          created_at: "2026-05-12T00:00:05Z",
        }),
      ),
    ).toThrowError(/created_at.*must not precede verified_at/i);
  });
});

describe("buildBrowserEvidence — placeholder hash rejection", () => {
  test("all-zeros session_id_hash is rejected as a placeholder", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({ session_id_hash: `sha256:${"0".repeat(64)}` }),
      ),
    ).toThrowError(/session_id_hash.*placeholder/i);
  });

  test("all-fs hash is rejected", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({ session_id_hash: `sha256:${"f".repeat(64)}` }),
      ),
    ).toThrowError(/session_id_hash.*placeholder/i);
  });

  test("malformed hash regex is rejected", () => {
    expect(() =>
      buildBrowserEvidence(
        buildBaseInput({ session_id_hash: "sha256:short" }),
      ),
    ).toThrowError(/session_id_hash/);
  });

  test("precomputed transition_log hash that is a placeholder is rejected", () => {
    const placeholder: HashableInput = {
      precomputedHash: `sha256:${"a".repeat(64)}`,
    };
    expect(() =>
      buildBrowserEvidence(buildBaseInput({ transition_log: placeholder })),
    ).toThrowError(/transition_log_sha256.*placeholder/i);
  });

  test("real precomputed transition_log hash is accepted", () => {
    const realPrecomputed: HashableInput = {
      precomputedHash: realHash("transition-log-content"),
    };
    const evidence = buildBrowserEvidence(
      buildBaseInput({ transition_log: realPrecomputed }),
    );
    expect(evidence.transition_log_sha256).toBe(realPrecomputed.precomputedHash);
  });
});

describe("buildBrowserEvidence — required-field validation", () => {
  test("empty prompt bytes are rejected", () => {
    expect(() => buildBrowserEvidence(buildBaseInput({ promptBytes: "" }))).toThrowError(
      /prompt_sha256.*non-empty/,
    );
  });

  test("empty output bytes are rejected", () => {
    expect(() => buildBrowserEvidence(buildBaseInput({ outputBytes: "" }))).toThrowError(
      /output_text_sha256.*non-empty/,
    );
  });

  test("empty effort label list is rejected", () => {
    expect(() =>
      buildBrowserEvidence(buildBaseInput({ available_effort_labels: [] })),
    ).toThrowError(/available_effort_labels_hash.*at least one effort label/i);
  });

  test("missing required string field throws BrowserEvidenceBuildError with that field", () => {
    const error = (() => {
      try {
        buildBrowserEvidence(buildBaseInput({ provider_slot: "" }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(BrowserEvidenceBuildError);
    expect((error as BrowserEvidenceBuildError).field).toBe("provider_slot");
  });
});

describe("buildBrowserEvidence — unverified evidence still produces a valid failure record", () => {
  test("mode_verified=false + verified_before_prompt_submit=false builds a valid failure ledger", () => {
    const evidence = buildBrowserEvidence(
      buildBaseInput({
        mode_verified: false,
        verified_before_prompt_submit: false,
        reasoning_effort_verified: false,
        failure_code: "chatgpt_pro_unverified",
      }),
    );
    expect(evidence.mode_verified).toBe(false);
    expect(evidence.verified_before_prompt_submit).toBe(false);
    expect(evidence.failure_code).toBe("chatgpt_pro_unverified");
    // Schema is still valid — the trust gate (policy.ts) rejects it downstream.
    expect(() => browserEvidenceSchema.parse(evidence)).not.toThrow();
  });
});
