// Integration test for oracle-2f0: wrapBrowserExecutorWithV18Emit
// must actually produce v18 evidence + ledger + provider_result on
// disk after a successful BrowserExecutor returns.
//
// Drives a fake BrowserExecutor (we don't have a real Chrome in CI)
// but every downstream layer — emit orchestrator, evidence writer,
// ledger appender, normalizer, hash-consistency cross-check — runs
// for real against a per-test temp homeDir.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  wrapBrowserExecutorWithV18Emit,
  type WrapBrowserExecutorWithV18EmitOptions,
} from "../../src/browser/runLive_emit_artifacts.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import {
  evidenceFilePath,
  evidenceIndexPath,
  readArtifactIndex,
} from "../../src/oracle/v18/evidence.js";
import type { BrowserExecutor } from "../../src/browser/leaseIntegration.js";
import type { LiveBrowserRunCapture } from "../../src/browser/runLive_v18.js";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browser/types.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;
const SESSION_ID = "session-2f0-emit";

const PROMPT_MANIFEST = `sha256:${"c".repeat(63)}1` as const;
const SOURCE_BASELINE = `sha256:${"d".repeat(63)}1` as const;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-2f0-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const HAPPY_ANSWER = `# Plan

- alpha
- bravo

\`\`\`ts
const x = 42;
\`\`\`
`;

function fakeExecutor(answer = HAPPY_ANSWER): BrowserExecutor {
  return async (options: BrowserRunOptions): Promise<BrowserRunResult> => {
    if (options.log) options.log("[browser] fake executor invoked");
    return {
      answerText: answer,
      answerMarkdown: answer,
      tookMs: 123,
      answerTokens: 50,
      answerChars: answer.length,
      tabUrl: options.config?.chatgptUrl ?? options.config?.url ?? "",
    };
  };
}

function chatGptOptions(
  overrides: Partial<BrowserRunOptions> = {},
): BrowserRunOptions {
  const config: BrowserSessionConfig = {
    chatgptUrl: "https://chatgpt.com/c/run-1",
  } as unknown as BrowserSessionConfig;
  return {
    prompt: "Review the storage adapters for schema drift.",
    config,
    sessionId: SESSION_ID,
    ...overrides,
  } as BrowserRunOptions;
}

function happyCapture(): LiveBrowserRunCapture {
  return {
    promptText: "Review the storage adapters for schema drift.",
    answerText: HAPPY_ANSWER,
    observedEffortLabels: ["Heavy", "Pro Extended"],
    observedTurnIndex: 4,
    baselineTurns: 3,
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    captureConfidence: "high",
  };
}

function emitOpts(
  overrides: Partial<WrapBrowserExecutorWithV18EmitOptions> = {},
): WrapBrowserExecutorWithV18EmitOptions {
  return {
    homeDir,
    promptManifestSha256: PROMPT_MANIFEST,
    sourceBaselineSha256: SOURCE_BASELINE,
    captureFor: () => happyCapture(),
    ...overrides,
  };
}

// ─── Happy path: artifacts appear on disk ───────────────────────────────────

describe("wrapBrowserExecutorWithV18Emit — happy path", () => {
  testNonWindows("successful ChatGPT run produces evidence file, index, ledger, and provider_result", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(fakeExecutor(), emitOpts());
    const result = await wrapped(chatGptOptions());

    // Original BrowserRunResult fields preserved.
    expect(result.answerText).toBe(HAPPY_ANSWER);
    expect(result.tookMs).toBe(123);

    // v18 emit outcome attached.
    expect(result.v18Emit?.attempted).toBe(true);
    expect(result.v18Emit?.emitError).toBeNull();
    expect(result.v18Emit?.artifacts).not.toBeNull();
    expect(result.v18Emit?.artifacts!.synthesisEligible).toBe(true);
    expect(result.v18Emit?.artifacts!.blockedErrorCodes).toEqual([]);

    // Evidence file landed on disk and parses as browser_evidence.v1.
    const evidenceId = `evidence-${SESSION_ID}-chatgpt_pro_first_plan`;
    const evidencePath = evidenceFilePath(SESSION_ID, evidenceId, homeDir);
    const raw = await readFile(evidencePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe("browser_evidence.v1");
    expect(parsed.evidence_id).toBe(evidenceId);
    expect(parsed.provider_slot).toBe("chatgpt_pro_first_plan");

    // Artifact index references the evidence entry.
    const index = await readArtifactIndex(evidenceIndexPath(SESSION_ID, homeDir));
    expect(index?.artifacts.some((a) => a.artifact_id === evidenceId)).toBe(true);

    // Ledger chain has evidence_written + run_completed.
    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(ledger.chainValid).toBe(true);
    const types = ledger.entries.map((e) => e.event.type);
    expect(types).toContain("evidence_written");
    expect(types).toContain("run_completed");

    // Provider result is schema-valid and links to the evidence id.
    const pr = result.v18Emit!.artifacts!.providerResult.result;
    expect(pr.schema_version).toBe("provider_result.v1");
    expect(pr.evidence_id).toBe(evidenceId);
    expect(pr.access_path).toBe("oracle_browser_remote");
    expect(pr.synthesis_eligible).toBe(true);
  });

  testNonWindows("captureFor hook receives the executor result", async () => {
    const captureSpy = vi.fn((_: BrowserRunOptions, result: BrowserRunResult) => {
      expect(result.answerText).toBe(HAPPY_ANSWER);
      return happyCapture();
    });
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({ captureFor: captureSpy }),
    );
    await wrapped(chatGptOptions());
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  testNonWindows("artifactIdFor hook lets callers control id provenance", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({
        artifactIdFor: () => ({
          evidenceId: "apr-issued-evidence-id",
          providerResultId: "apr-issued-result-id",
        }),
      }),
    );
    const result = await wrapped(chatGptOptions());
    expect(result.v18Emit?.artifacts!.providerResult.result.evidence_id).toBe(
      "apr-issued-evidence-id",
    );
    expect(result.v18Emit?.artifacts!.providerResult.result.provider_result_id).toBe(
      "apr-issued-result-id",
    );
  });

  testNonWindows("synthesis path uses explicit providerSlot override", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({ providerSlot: "chatgpt_pro_synthesis" }),
    );
    const result = await wrapped(chatGptOptions());
    expect(result.v18Emit?.artifacts!.providerResult.result.provider_slot).toBe(
      "chatgpt_pro_synthesis",
    );
  });
});

// ─── Skip paths: non-v18 routes pass through ───────────────────────────────

describe("wrapBrowserExecutorWithV18Emit — skip paths", () => {
  testNonWindows("non-ChatGPT URL bypasses emit and returns the raw result", async () => {
    const config = { url: "https://example.invalid/page" } as unknown as BrowserSessionConfig;
    const wrapped = wrapBrowserExecutorWithV18Emit(fakeExecutor(), emitOpts());
    const result = await wrapped({ ...chatGptOptions(), config } as BrowserRunOptions);
    expect(result.answerText).toBe(HAPPY_ANSWER);
    expect(result.v18Emit?.attempted).toBe(false);
    expect(result.v18Emit?.skippedReason).toMatch(/non-v18 route/);
  });

  testNonWindows("providerSlot=null forces a skip even on ChatGPT URLs", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({ providerSlot: null }),
    );
    const result = await wrapped(chatGptOptions());
    expect(result.v18Emit?.attempted).toBe(false);
    expect(result.v18Emit?.skippedReason).toMatch(/explicitly set to null/);
  });

  testNonWindows("missing sessionId skips emit (cannot anchor evidence)", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(fakeExecutor(), emitOpts());
    const result = await wrapped({
      ...chatGptOptions(),
      sessionId: undefined,
    } as BrowserRunOptions);
    expect(result.v18Emit?.attempted).toBe(false);
    expect(result.v18Emit?.skippedReason).toMatch(/missing sessionId/);
  });
});

// ─── Blocker propagation ───────────────────────────────────────────────────

describe("wrapBrowserExecutorWithV18Emit — blocker propagation", () => {
  testNonWindows("UI drift in capture surfaces blockedErrorCodes without failing the run", async () => {
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({
        captureFor: () => ({
          ...happyCapture(),
          observedEffortLabels: ["Unobtainium"],
        }),
      }),
    );
    const result = await wrapped(chatGptOptions());
    // Original answer still returned — captured text is still useful
    // even when v18 verification fails.
    expect(result.answerText).toBe(HAPPY_ANSWER);
    expect(result.v18Emit?.attempted).toBe(true);
    expect(result.v18Emit?.artifacts?.synthesisEligible).toBe(false);
    const blockerCodes = result.v18Emit?.artifacts?.providerResult.blockedReasons.map(
      (r) => r.code,
    );
    expect(blockerCodes).toContain("ui_drift_suspected");

    // Ledger surfaces run_failed for the blocked outcome.
    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    const types = ledger.entries.map((e) => e.event.type);
    expect(types).toContain("run_failed");
    expect(types).not.toContain("run_completed");
  });

  testNonWindows("emit error does NOT mask a successful executor result", async () => {
    // Force an emit failure by passing a homeDir that points at a
    // path the writer cannot create under (a regular file, not a
    // directory).
    const blockerPath = path.join(homeDir, "block");
    await (await import("node:fs/promises")).writeFile(blockerPath, "x", "utf8");
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({ homeDir: blockerPath }),
    );
    const result = await wrapped(chatGptOptions());
    expect(result.answerText).toBe(HAPPY_ANSWER);
    expect(result.v18Emit?.attempted).toBe(true);
    expect(result.v18Emit?.emitError).toBeInstanceOf(Error);
    expect(result.v18Emit?.artifacts).toBeNull();
  });
});

// ─── Log surface ────────────────────────────────────────────────────────────

describe("wrapBrowserExecutorWithV18Emit — operator-visible logging", () => {
  testNonWindows("emit success line names eligibility + evidence id", async () => {
    const lines: string[] = [];
    const logger = ((m?: string) => {
      if (typeof m === "string") lines.push(m);
    }) as BrowserRunOptions["log"];
    const wrapped = wrapBrowserExecutorWithV18Emit(fakeExecutor(), emitOpts());
    await wrapped({ ...chatGptOptions(), log: logger } as BrowserRunOptions);
    expect(lines.some((l) => l.includes("v18 artifacts: eligible"))).toBe(true);
    expect(lines.some((l) => l.includes(`evidence=evidence-${SESSION_ID}`))).toBe(true);
  });

  testNonWindows("blocker log names the v18 error codes", async () => {
    const lines: string[] = [];
    const logger = ((m?: string) => {
      if (typeof m === "string") lines.push(m);
    }) as BrowserRunOptions["log"];
    const wrapped = wrapBrowserExecutorWithV18Emit(
      fakeExecutor(),
      emitOpts({
        captureFor: () => ({ ...happyCapture(), modeVerified: false }),
      }),
    );
    await wrapped({ ...chatGptOptions(), log: logger } as BrowserRunOptions);
    expect(lines.some((l) => l.includes("blocked:"))).toBe(true);
    expect(lines.some((l) => l.includes("chatgpt_pro_unverified"))).toBe(true);
  });
});
