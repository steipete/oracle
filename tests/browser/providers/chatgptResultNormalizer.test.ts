// Integration tests for the ChatGPT provider_result normalizer
// (oracle-e8u). Drives the normalizer with realistic browser-layer
// artefacts (CaptureVerdict + EffortStrategyResult + evidence) and
// asserts the emitted result matches the canonical v18 fixtures.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { browserEvidenceSchema, type BrowserEvidence } from "../../../src/oracle/v18/contracts.js";
import {
  captureToSummary,
  effortToSummary,
  normalizeChatGptRun,
} from "../../../src/browser/providers/chatgptResultNormalizer.js";
import {
  captured,
  emptyOutput,
  staleTurn,
  type CaptureVerdict,
} from "../../../src/browser/output-capture/index.js";
import type { EffortStrategyResult } from "../../../src/browser/selectors/chatgpt/effortStrategy.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(
  moduleDir,
  "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

async function loadFixture<T = unknown>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")) as T;
}

function effortVerified(overrides: Partial<EffortStrategyResult> = {}): EffortStrategyResult {
  return {
    status: "verified",
    selected: "Heavy",
    tier: "heavy",
    rank: 60,
    selectedIsHighestVisible: true,
    availableEffortLabelsHash: `sha256:${"a".repeat(64)}`,
    selectorManifestVersion: "chatgpt-selectors.v1",
    errorCode: null,
    reason: "verified",
    observedLabels: ["Heavy", "Pro Extended"],
    ...overrides,
  };
}

function capturedVerdict(overrides: Partial<CaptureVerdict> = {}): CaptureVerdict {
  return {
    ...captured({
      outputTextSha256: `sha256:${"b".repeat(64)}`,
      outputBytes: 4096,
      captureConfidence: "high",
      turnId: "turn-5",
      messageId: "msg-5",
      markdownPreserved: true,
    }),
    ...overrides,
  };
}

async function loadChatGptEvidence(): Promise<BrowserEvidence> {
  const raw = await loadFixture<unknown>("fixtures/chatgpt-pro-evidence.json");
  return browserEvidenceSchema.parse(raw) as BrowserEvidence;
}

const PROMPT_MANIFEST_HASH = `sha256:${"c".repeat(64)}` as const;
const SOURCE_BASELINE_HASH = `sha256:${"d".repeat(64)}` as const;

describe("normalizeChatGptRun — happy path matches canonical fixture", () => {
  test("chatgpt_pro_first_plan happy path is fully eligible", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "provider-result-test-first-plan",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({
        outputTextSha256: evidence.output_text_sha256 as `sha256:${string}`,
      }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.blockedReasons).toEqual([]);
    expect(build.synthesisDowngraded).toBe(false);
    expect(build.result.schema_version).toBe("provider_result.v1");
    expect(build.result.provider_family).toBe("chatgpt");
    expect(build.result.provider_slot).toBe("chatgpt_pro_first_plan");
    expect(build.result.access_path).toBe("oracle_browser_remote");
    expect(build.result.status).toBe("success");
    expect(build.result.synthesis_eligible).toBe(true);
    expect(build.result.evidence_id).toBe(evidence.evidence_id);
    expect(build.result.reasoning_effort).toBe("max_browser_available");
    expect(build.result.reasoning_effort_verified).toBe(true);
    expect(build.result.result_text_sha256).toBe(evidence.output_text_sha256);
  });

  test("emitted result parses cleanly against the v18 provider_result schema (round-trip)", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "provider-result-roundtrip",
      accessPath: "oracle_browser_local",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    // build.result IS the parsed value from providerResultSchema.parse,
    // so the round-trip is implicit. We just sanity-check the structural
    // alignment with the canonical fixture.
    const fixture = await loadFixture<Record<string, unknown>>(
      "fixtures/provider-result.chatgpt.json",
    );
    for (const key of [
      "schema_version",
      "provider_family",
      "provider_slot",
      "reasoning_effort",
    ]) {
      expect((build.result as Record<string, unknown>)[key]).toBe(fixture[key]);
    }
  });

  test("chatgpt_pro_synthesis happy path is fully eligible", async () => {
    const evidence = await loadChatGptEvidence();
    const synthEvidence = browserEvidenceSchema.parse({
      ...evidence,
      evidence_id: "evidence-test-synth-1",
      provider_slot: "chatgpt_pro_synthesis",
      provider_result_id: "provider-result-test-synth",
    }) as BrowserEvidence;
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_synthesis",
      providerResultId: "provider-result-test-synth",
      accessPath: "oracle_browser_remote",
      evidence: synthEvidence,
      capture: capturedVerdict({ outputTextSha256: synthEvidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });

    expect(build.blockedReasons).toEqual([]);
    expect(build.result.provider_slot).toBe("chatgpt_pro_synthesis");
    expect(build.result.status).toBe("success");
    expect(build.result.synthesis_eligible).toBe(true);
  });

  test("reasoning_config records the effort verdict provenance", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-1",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified({ selected: "Pro Extended", tier: "pro_extended", rank: 50 }),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    const cfg = build.result.reasoning_config as Record<string, unknown>;
    expect(cfg.observed_reasoning_effort_label).toBe("Pro Extended");
    expect(cfg.canonical_effort_tier).toBe("pro_extended");
    expect(cfg.selector_manifest_version).toBe("chatgpt-selectors.v1");
    expect(cfg.selected_effort_is_highest_visible).toBe(true);
    expect(cfg.available_effort_labels_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("normalizeChatGptRun — negative: API substitution", () => {
  test("openai_api access_path is rejected for chatgpt_pro_first_plan", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-2",
      // @ts-expect-error — typed surface forbids the cast; this is the
      // exact regression we want to catch.
      accessPath: "openai_api",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    // The schema accepts the string at the field level, but the
    // eligibility gate records a blocker AND forces synthesis_eligible
    // to false with the chatgpt_pro_unverified v18 error code.
    expect(build.synthesisDowngraded).toBe(true);
    expect(build.result.synthesis_eligible).toBe(false);
    expect(
      build.blockedReasons.some((r) => r.field === "provider_result.access_path"),
    ).toBe(true);
    expect(build.blockedReasons.some((r) => r.code === "chatgpt_pro_unverified")).toBe(true);
  });

  test("oracle_browser_remote stays eligible (control)", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-3",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(build.synthesisDowngraded).toBe(false);
  });
});

describe("normalizeChatGptRun — negative: unverified evidence", () => {
  test("mode_verified=false blocks synthesis_eligible", async () => {
    const evidence = await loadChatGptEvidence();
    const unverified = browserEvidenceSchema.parse({
      ...evidence,
      mode_verified: false,
    }) as BrowserEvidence;
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-4",
      accessPath: "oracle_browser_remote",
      evidence: unverified,
      capture: capturedVerdict({ outputTextSha256: unverified.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(build.synthesisDowngraded).toBe(true);
    expect(build.result.synthesis_eligible).toBe(false);
    expect(build.result.status).not.toBe("success");
    expect(
      build.blockedReasons.some((r) => r.field === "browser_evidence.mode_verified"),
    ).toBe(true);
    expect(build.blockedReasons.some((r) => r.code === "chatgpt_pro_unverified")).toBe(true);
  });

  test("verified_before_prompt_submit=false blocks with prompt_submitted_before_verification", async () => {
    const evidence = await loadChatGptEvidence();
    const tainted = browserEvidenceSchema.parse({
      ...evidence,
      verified_before_prompt_submit: false,
    }) as BrowserEvidence;
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-5",
      accessPath: "oracle_browser_remote",
      evidence: tainted,
      capture: capturedVerdict({ outputTextSha256: tainted.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(
      build.blockedReasons.some((r) => r.code === "prompt_submitted_before_verification"),
    ).toBe(true);
    expect(build.result.synthesis_eligible).toBe(false);
  });

  test("evidence.provider_slot mismatch is blocked", async () => {
    const evidence = await loadChatGptEvidence();
    const wrongSlot = browserEvidenceSchema.parse({
      ...evidence,
      provider_slot: "chatgpt_pro_synthesis",
    }) as BrowserEvidence;
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-6",
      accessPath: "oracle_browser_remote",
      evidence: wrongSlot,
      capture: capturedVerdict({ outputTextSha256: wrongSlot.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(
      build.blockedReasons.some((r) => r.field === "browser_evidence.provider_slot"),
    ).toBe(true);
  });
});

describe("normalizeChatGptRun — negative: effort drift / unknown", () => {
  test("ui_drift_suspected effort blocks with ui_drift_suspected code", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-7",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified({
        status: "ui_drift_suspected",
        selected: null,
        tier: null,
        rank: null,
        selectedIsHighestVisible: false,
        errorCode: "ui_drift_suspected",
        reason: "no known tier in observed labels",
        observedLabels: ["Unobtainium"],
      }),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(build.blockedReasons.some((r) => r.code === "ui_drift_suspected")).toBe(true);
    expect(build.result.reasoning_effort_verified).toBe(false);
    expect(build.result.synthesis_eligible).toBe(false);
  });

  test("verified-but-not-highest-visible still blocks synthesis", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-8",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified({ selectedIsHighestVisible: false }),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(
      build.blockedReasons.some((r) => r.code === "chatgpt_extended_reasoning_unverified"),
    ).toBe(true);
    expect(build.result.synthesis_eligible).toBe(false);
  });

  test("unverified effort verdict (empty observed labels)", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-9",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict({ outputTextSha256: evidence.output_text_sha256 as `sha256:${string}` }),
      effort: effortVerified({
        status: "unverified",
        selected: null,
        tier: null,
        rank: null,
        selectedIsHighestVisible: false,
        errorCode: "output_capture_unverified",
        reason: "effort picker empty",
      }),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(
      build.blockedReasons.some((r) => r.code === "chatgpt_extended_reasoning_unverified"),
    ).toBe(true);
  });
});

describe("normalizeChatGptRun — negative: capture failures", () => {
  test("empty capture maps to output_capture_empty + status=failed", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-10",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: emptyOutput(),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(build.blockedReasons.some((r) => r.code === "output_capture_empty")).toBe(true);
    expect(build.result.status).toBe("failed");
    expect(build.result.synthesis_eligible).toBe(false);
  });

  test("stale_turn capture maps to output_capture_unverified", async () => {
    const evidence = await loadChatGptEvidence();
    const build = normalizeChatGptRun({
      slot: "chatgpt_pro_first_plan",
      providerResultId: "id-11",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: staleTurn({ expectedTurnIndex: 5, observedTurnIndex: 2 }),
      effort: effortVerified(),
      promptManifestSha256: PROMPT_MANIFEST_HASH,
      sourceBaselineSha256: SOURCE_BASELINE_HASH,
    });
    expect(
      build.blockedReasons.some((r) => r.code === "output_capture_unverified"),
    ).toBe(true);
    expect(build.result.status).toBe("failed");
  });
});

describe("normalizeChatGptRun — projection helpers", () => {
  test("captureToSummary maps every status verbatim", () => {
    expect(
      captureToSummary(
        captured({
          outputTextSha256: `sha256:${"e".repeat(64)}`,
          outputBytes: 1,
          captureConfidence: "high",
          turnId: null,
          messageId: null,
          markdownPreserved: false,
        }),
      ),
    ).toMatchObject({ status: "captured" });
    expect(captureToSummary(emptyOutput())).toMatchObject({ status: "empty" });
  });

  test("effortToSummary preserves the verdict fields", () => {
    const summary = effortToSummary(effortVerified());
    expect(summary.status).toBe("verified");
    expect(summary.tier).toBe("heavy");
    expect(summary.selected).toBe("Heavy");
    expect(summary.selectedIsHighestVisible).toBe(true);
    expect(summary.availableEffortLabelsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
