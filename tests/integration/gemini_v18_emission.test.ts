// Integration regression for oracle-scb: live Gemini Deep Think runs
// must emit a sanitised browser_evidence.v1 (provider=gemini,
// provider_slot=gemini_deep_think), append evidence_written +
// run_completed/run_failed to the evidence ledger, and produce a
// provider_result.v1 via normalizeGeminiRun.
//
// Before this commit the v18 emission path was ChatGPT-only:
// detectProviderSlotFromOptions in src/browser/runLive_emit_artifacts.ts
// only recognised chatgpt.com hosts; runLive_v18.ts hardcoded
// provider="chatgpt" and normalizeChatGptRun. Gemini browser runs
// returned the bare text but left ZERO artifacts on disk, so
// post-hoc audits (`oracle evidence show`, `oracle evidence verify`,
// the ledger chain) could not see Gemini runs at all.
//
// These tests drive the new emitV18GeminiBrowserArtifacts +
// emitGeminiDeepThinkV18ArtifactsForRun helpers end-to-end against a
// temp Oracle home, parse the on-disk artifacts back, and assert:
//   - browser_evidence.v1 file written with provider=gemini
//   - evidence_ledger.v1 has evidence_written entry
//   - evidence_ledger.v1 has run_completed (success) or run_failed
//   - provider_result.v1 from normalizeGeminiRun is well-formed
//   - failure-arm (empty stream) writes run_failed with the typed
//     v18 error code, not run_completed.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitV18GeminiBrowserArtifacts } from "../../src/browser/runLive_v18.js";
import {
  emitGeminiDeepThinkV18ArtifactsForRun,
  geminiDeepThinkDomProviderWithFsm,
} from "../../src/browser/providers/geminiDeepThinkDomProvider.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import type { GeminiStreamCaptureSummary } from "../../src/gemini-web/streamSafeguards.js";
import { verifyGeminiDeepThinkCandidate } from "../../src/browser/state/geminiDeepThink.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;
const SOURCE_HASH = `sha256:${"b".repeat(64)}` as const;

function sha256Text(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function buildStreamCapture(text: string): GeminiStreamCaptureSummary {
  // result_text_sha256 must match the hash of the captured answer
  // text — the v18 hash-consistency cross-check compares the provider
  // result's result_text_sha256 (sourced from this summary) against
  // the evidence's output_text_sha256 (sha of the answer). A mismatch
  // would downgrade the run to run_failed even when nothing else is
  // wrong, which we want to avoid in the happy-path test.
  return {
    capture_method: "stream_generate_latest_non_empty_candidate",
    confidence: text.length > 0 ? "high" : "low",
    result_text_sha256: text.length > 0 ? sha256Text(text) : null,
    output_bytes: Buffer.byteLength(text, "utf8"),
    current_prompt_sha256: null,
    current_session_id: "live-session",
    observed_response_candidate_id: "cand-1",
    expected_response_candidate_id: "cand-1",
    chunk_count: 4,
    non_empty_candidate_count: 1,
  };
}

const happyDeepThink = verifyGeminiDeepThinkCandidate({
  deepThinkLabel: "Deep Think",
  observedThinkingLevelLabels: ["Standard", "High"],
  selectedThinkingLevel: "High",
  thinkingLevelControlExposed: true,
});

let homeDir: string;
beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-scb-"));
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("emitV18GeminiBrowserArtifacts — direct orchestrator (oracle-scb)", () => {
  it("writes a Gemini browser_evidence.v1 file plus run_completed ledger pair (happy path)", async () => {
    const sessionId = "gemini-success-session";
    const result = await emitV18GeminiBrowserArtifacts({
      sessionId,
      homeDir,
      providerSlot: "gemini_deep_think",
      providerResultId: "pr-gemini-1",
      evidenceId: "ev-gemini-1",
      accessPath: "oracle_browser_remote",
      capture: {
        promptText: "What is the capital of France?",
        answerText: "Paris.",
        stream: buildStreamCapture("Paris."),
        deepThink: happyDeepThink,
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      },
      promptManifestSha256: PROMPT_HASH,
      sourceBaselineSha256: SOURCE_HASH,
      runId: "run-gemini-1",
    });

    // 1. browser_evidence.v1 file is on disk with provider=gemini.
    const evidenceRaw = await readFile(result.evidenceFilePath, "utf8");
    const evidence = JSON.parse(evidenceRaw) as Record<string, unknown>;
    expect(evidence.schema_version).toBe("browser_evidence.v1");
    expect(evidence.provider).toBe("gemini");
    expect(evidence.provider_slot).toBe("gemini_deep_think");
    expect(evidence.evidence_id).toBe("ev-gemini-1");
    expect(evidence.redaction_policy).toBe("redacted");
    // Forbidden-key sanitisation ran (oracle-ejv): the on-disk bytes
    // never carry raw cookie / DOM / screenshot values. The schema's
    // `evidence_privacy.stores_*` declarations are carved out — those
    // are policy booleans, not leaked secrets.
    const rawCookieKeys = /"cookies?":|"raw_dom":|"screenshot_base64":/i;
    expect(evidenceRaw).not.toMatch(rawCookieKeys);

    // 2. evidence_ledger has the evidence_written + run_completed pair.
    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    const eventTypes = ledger.entries.map((e) => e.event.type);
    expect(eventTypes).toContain("evidence_written");
    expect(eventTypes).toContain("run_completed");
    const written = ledger.entries.find((e) => e.event.type === "evidence_written")!;
    expect(written.event.provider_slot).toBe("gemini_deep_think");
    expect(written.event.evidence_id).toBe("ev-gemini-1");

    // 3. provider_result.v1 from normalizeGeminiRun is well-formed.
    expect(result.providerResult.result.schema_version).toBe("provider_result.v1");
    expect(result.providerResult.result.provider_slot).toBe("gemini_deep_think");
    expect(result.providerResult.result.provider_family).toMatch(/gemini/i);
    expect(result.providerResult.result.status).toBe("success");

    // 4. Orchestrator returns a non-skipped success outcome.
    expect(result.synthesisEligible).toBe(true);
    expect(result.blockedErrorCodes).toEqual([]);
  });

  it("writes run_failed (not run_completed) when the stream capture is empty", async () => {
    const sessionId = "gemini-empty-session";
    const result = await emitV18GeminiBrowserArtifacts({
      sessionId,
      homeDir,
      providerSlot: "gemini_deep_think",
      providerResultId: "pr-gemini-empty",
      evidenceId: "ev-gemini-empty",
      accessPath: "oracle_browser_remote",
      capture: {
        promptText: "Q",
        answerText: "",
        stream: buildStreamCapture(""),
        deepThink: happyDeepThink,
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      },
      promptManifestSha256: PROMPT_HASH,
      sourceBaselineSha256: SOURCE_HASH,
    });

    expect(result.synthesisEligible).toBe(false);
    // The ledger records run_failed (not run_completed) so post-mortem
    // audits can see the failure-arm decision.
    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    const eventTypes = ledger.entries.map((e) => e.event.type);
    expect(eventTypes).toContain("evidence_written");
    expect(eventTypes).toContain("run_failed");
    expect(eventTypes).not.toContain("run_completed");
  });
});

describe("emitGeminiDeepThinkV18ArtifactsForRun — wired-adapter live-path helper (oracle-scb)", () => {
  it("derives capture from a wired adapter and writes the same artifact set", async () => {
    const sessionId = "gemini-live-session";
    const wired = geminiDeepThinkDomProviderWithFsm();
    // The wired adapter's FSM is at session_start; we don't drive a
    // real DOM run here — the helper accepts a verificationOverride
    // so tests can pin the verdict directly. Production callers pass
    // the verdict the FSM recorded after Deep Think activation.
    const result = await emitGeminiDeepThinkV18ArtifactsForRun({
      wired,
      sessionId,
      promptText: "tell me about Mars",
      answerText: "Mars is the fourth planet from the Sun.",
      stream: buildStreamCapture("Mars is the fourth planet from the Sun."),
      promptManifestSha256: PROMPT_HASH,
      sourceBaselineSha256: SOURCE_HASH,
      providerResultId: "pr-gemini-live",
      evidenceId: "ev-gemini-live",
      homeDir,
      runId: "run-gemini-live",
      verificationOverride: {
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["Standard", "High"],
        selectedThinkingLevel: "High",
        thinkingLevelControlExposed: true,
      },
    });

    // Evidence file lands at the expected path with Gemini fields.
    const evidence = JSON.parse(await readFile(result.evidenceFilePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(evidence.provider).toBe("gemini");
    expect(evidence.provider_slot).toBe("gemini_deep_think");
    expect(evidence.run_id).toBe("run-gemini-live");

    // Ledger has both milestones.
    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    const eventTypes = ledger.entries.map((e) => e.event.type);
    expect(eventTypes).toContain("evidence_written");
    expect(eventTypes).toContain("run_completed");

    // The wrapper does NOT skip — every flag indicates emission ran.
    expect(result.synthesisEligible).toBe(true);
    expect(result.providerResult.result.provider_result_id).toBe("pr-gemini-live");
  });
});
