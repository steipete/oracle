// Regression test for oracle-x2t: emitV18BrowserArtifacts must
// produce schema-valid v18 evidence + provider_result + ledger
// artifacts from BrowserRunResult-shaped inputs, and surface typed
// blockers when verification fails.
//
// Drives the REAL orchestrator (no mocks of the v18 layer); only the
// browser DOM/network is replaced by the scripted capture inputs.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  emitV18BrowserArtifacts,
  type EmitV18BrowserArtifactsInput,
  type LiveBrowserRunCapture,
} from "../../src/browser/runLive_v18.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import { evidenceIndexPath, readArtifactIndex } from "../../src/oracle/v18/evidence.js";
import { providerResultSchema } from "../../src/oracle/v18/contracts.js";
import { assertNoLeaks } from "../_helpers/secretLeakDetector.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;
const SESSION_ID = "session-x2t-live";

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-x2t-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const PROMPT_MANIFEST = `sha256:${"c".repeat(63)}1` as const;
const SOURCE_BASELINE = `sha256:${"d".repeat(63)}1` as const;

const HAPPY_CAPTURE: LiveBrowserRunCapture = {
  promptText: "Review the storage adapters for schema drift.",
  answerText: `# Storage adapters review

- alpha: confirmed schema alignment
- bravo: minor drift in versioning column

\`\`\`ts
const x: number = 42;
\`\`\`

See [drift report](https://example.invalid/drift).
`,
  observedEffortLabels: ["Heavy", "Pro Extended", "Thinking"],
  observedTurnIndex: 4,
  baselineTurns: 3,
  modeVerified: true,
  verifiedBeforePromptSubmit: true,
  captureConfidence: "high",
};

function happyInput(
  overrides: Partial<EmitV18BrowserArtifactsInput> = {},
): EmitV18BrowserArtifactsInput {
  return {
    sessionId: SESSION_ID,
    homeDir,
    providerSlot: "chatgpt_pro_first_plan",
    providerResultId: "provider-result-x2t-happy",
    evidenceId: "evidence-x2t-happy",
    accessPath: "oracle_browser_remote",
    capture: HAPPY_CAPTURE,
    promptManifestSha256: PROMPT_MANIFEST,
    sourceBaselineSha256: SOURCE_BASELINE,
    runId: "x2t-run",
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("emitV18BrowserArtifacts — happy path", () => {
  testNonWindows("produces every v18 artifact and synthesisEligible=true", async () => {
    const result = await emitV18BrowserArtifacts(happyInput());

    // Evidence on disk + schema-valid
    const evidenceRaw = await readFile(result.evidenceFilePath, "utf8");
    const evidenceParsed = JSON.parse(evidenceRaw);
    expect(evidenceParsed.schema_version).toBe("browser_evidence.v1");
    expect(evidenceParsed.evidence_id).toBe("evidence-x2t-happy");
    expect(evidenceParsed.provider_slot).toBe("chatgpt_pro_first_plan");
    expect(result.evidenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Artifact index contains the evidence entry
    const index = await readArtifactIndex(result.indexFilePath);
    expect(index?.artifacts.some((a) => a.artifact_id === "evidence-x2t-happy")).toBe(true);

    // Provider result is schema-valid and synthesis-eligible
    expect(result.providerResult.blockedReasons).toEqual([]);
    expect(result.providerResult.result.synthesis_eligible).toBe(true);
    expect(result.providerResult.result.status).toBe("success");
    expect(result.providerResult.result.access_path).toBe("oracle_browser_remote");
    expect(result.providerResult.result.evidence_id).toBe("evidence-x2t-happy");
    expect(providerResultSchema.safeParse(result.providerResult.result).success).toBe(true);

    // Hash consistency clean
    expect(result.consistency.consistent).toBe(true);
    expect(result.blockedErrorCodes).toEqual([]);
    expect(result.synthesisEligible).toBe(true);

    // Ledger captured evidence_written + run_completed milestones
    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(ledger.chainValid).toBe(true);
    const types = ledger.entries.map((e) => e.event.type);
    expect(types).toContain("evidence_written");
    expect(types).toContain("run_completed");
    const runCompleted = ledger.entries.find((e) => e.event.type === "run_completed");
    expect((runCompleted!.event.metadata as Record<string, unknown>).synthesis_eligible).toBe(true);
  });

  testNonWindows("evidence file on disk contains no raw secrets", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({ capture: { ...HAPPY_CAPTURE, promptText: "innocuous prompt" } }),
    );
    const raw = await readFile(result.evidenceFilePath, "utf8");
    // The on-disk bytes must not contain the raw prompt or answer text
    // (defense-in-depth via sanitizeBrowserEvidenceForWrite + v18
    // redactor). Only the sha256 references survive.
    expect(raw).not.toContain("innocuous prompt");
    expect(raw).not.toContain("alpha: confirmed");
    assertNoLeaks(raw, {
      fakes: [
        { name: "prompt-text", value: "innocuous prompt" },
        { name: "answer-text", value: "alpha: confirmed schema alignment" },
      ],
    });
  });

  testNonWindows("captureVerdict + effortVerdict are wired correctly", async () => {
    const result = await emitV18BrowserArtifacts(happyInput());
    expect(result.captureVerdict.status).toBe("captured");
    expect(result.captureVerdict.markdownPreserved).toBe(true);
    expect(result.effortVerdict.status).toBe("verified");
    expect(result.effortVerdict.tier).toBe("heavy");
    expect(result.effortVerdict.selected).toBe("Heavy");
  });

  testNonWindows("works for chatgpt_pro_synthesis slot too", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        providerSlot: "chatgpt_pro_synthesis",
        providerResultId: "provider-result-x2t-synth",
        evidenceId: "evidence-x2t-synth",
      }),
    );
    expect(result.providerResult.result.provider_slot).toBe("chatgpt_pro_synthesis");
    expect(result.synthesisEligible).toBe(true);
  });
});

// ─── Blocker paths ──────────────────────────────────────────────────────────

describe("emitV18BrowserArtifacts — blocker paths surface typed error codes", () => {
  testNonWindows("UI drift (unknown effort labels) blocks synthesis", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        capture: { ...HAPPY_CAPTURE, observedEffortLabels: ["Unobtainium", "Vibranium"] },
      }),
    );
    expect(result.synthesisEligible).toBe(false);
    expect(result.providerResult.blockedReasons.some((r) => r.code === "ui_drift_suspected")).toBe(
      true,
    );
    expect(result.effortVerdict.status).toBe("ui_drift_suspected");
    expect(result.providerResult.result.synthesis_eligible).toBe(false);
    expect(result.blockedErrorCodes).toContain("ui_drift_suspected");

    // Ledger surfaces run_failed for the blocked outcome.
    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    const types = ledger.entries.map((e) => e.event.type);
    expect(types).toContain("run_failed");
    expect(types).not.toContain("run_completed");
    const runFailed = ledger.entries.find((e) => e.event.type === "run_failed");
    expect((runFailed!.event.metadata as Record<string, unknown>).consistency_codes).toEqual([]);
    expect((runFailed!.event.metadata as Record<string, unknown>).provider_blocker_codes).toContain(
      "ui_drift_suspected",
    );
    expect((runFailed!.event.metadata as Record<string, unknown>).blocked_error_codes).toContain(
      "ui_drift_suspected",
    );
  });

  testNonWindows("unverified mode blocks with chatgpt_pro_unverified", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        capture: { ...HAPPY_CAPTURE, modeVerified: false },
      }),
    );
    expect(result.synthesisEligible).toBe(false);
    expect(
      result.providerResult.blockedReasons.some((r) => r.code === "chatgpt_pro_unverified"),
    ).toBe(true);
  });

  testNonWindows(
    "verified_before_prompt_submit=false blocks with the prompt_before_verification code",
    async () => {
      const result = await emitV18BrowserArtifacts(
        happyInput({
          capture: { ...HAPPY_CAPTURE, verifiedBeforePromptSubmit: false },
        }),
      );
      expect(result.synthesisEligible).toBe(false);
      expect(
        result.providerResult.blockedReasons.some(
          (r) => r.code === "prompt_submitted_before_verification",
        ),
      ).toBe(true);
    },
  );

  testNonWindows("empty captured text blocks with output_capture_empty", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        capture: { ...HAPPY_CAPTURE, answerText: "" },
      }),
    );
    expect(result.synthesisEligible).toBe(false);
    expect(result.captureVerdict.status).toBe("empty");
    expect(
      result.providerResult.blockedReasons.some((r) => r.code === "output_capture_empty"),
    ).toBe(true);
    expect(result.blockedErrorCodes).toContain("output_capture_empty");
  });

  testNonWindows("stale turn binding blocks with output_capture_unverified", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        capture: { ...HAPPY_CAPTURE, baselineTurns: 10, observedTurnIndex: 2 },
      }),
    );
    expect(result.synthesisEligible).toBe(false);
    expect(result.captureVerdict.status).toBe("stale_turn");
    expect(result.blockedErrorCodes).toContain("output_capture_unverified");
  });

  testNonWindows("empty effort labels surface evidence and provider blocker codes", async () => {
    const result = await emitV18BrowserArtifacts(
      happyInput({
        capture: { ...HAPPY_CAPTURE, observedEffortLabels: [] },
      }),
    );
    expect(result.synthesisEligible).toBe(false);
    expect(result.effortVerdict.status).toBe("unverified");
    expect(result.blockedErrorCodes).toContain("output_capture_unverified");
    expect(result.blockedErrorCodes).toContain("chatgpt_extended_reasoning_unverified");
  });
});

// ─── Persistence invariants ─────────────────────────────────────────────────

describe("emitV18BrowserArtifacts — persistence invariants", () => {
  testNonWindows(
    "artifact index entry sha256 matches the on-disk evidence bytes hash",
    async () => {
      const result = await emitV18BrowserArtifacts(happyInput());
      const index = await readArtifactIndex(result.indexFilePath);
      const entry = index?.artifacts.find((a) => a.artifact_id === "evidence-x2t-happy");
      expect(entry).toBeDefined();
      expect(entry!.sha256).toBe(result.evidenceSha256);
    },
  );

  testNonWindows("evidence index path is in the session's evidence directory", async () => {
    const result = await emitV18BrowserArtifacts(happyInput());
    expect(result.indexFilePath).toBe(evidenceIndexPath(SESSION_ID, homeDir));
    expect(result.evidenceFilePath).toContain(`/sessions/${SESSION_ID}/evidence/`);
  });

  testNonWindows("ledger chain stays valid across the orchestrated appends", async () => {
    await emitV18BrowserArtifacts(happyInput());
    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ledger.entries.length; i++) {
      expect(ledger.entries[i].prev_hash).toBe(ledger.entries[i - 1].entry_hash);
    }
  });
});
