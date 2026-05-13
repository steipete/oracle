import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  wrapBrowserExecutorWithV18Emit,
  type WrapBrowserExecutorWithV18EmitOptions,
} from "../../src/browser/runLive_emit_artifacts.js";
import type { BrowserExecutor } from "../../src/browser/leaseIntegration.js";
import type { LiveBrowserRunCapture } from "../../src/browser/runLive_v18.js";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browser/types.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import { evidenceFilePath } from "../../src/oracle/v18/evidence.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const SESSION_ID = "session-ieh-failure";
const PROMPT = "Run a protected browser pass that fails before output.";
const PROMPT_MANIFEST = `sha256:${"e".repeat(64)}` as const;
const SOURCE_BASELINE = `sha256:${"f".repeat(64)}` as const;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ieh-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function throwingExecutor(error: Error): BrowserExecutor {
  return async () => {
    throw error;
  };
}

function chatGptOptions(overrides: Partial<BrowserRunOptions> = {}): BrowserRunOptions {
  const config = {
    chatgptUrl: "https://chatgpt.com/c/failure-emission",
  } as BrowserSessionConfig;
  return {
    prompt: PROMPT,
    config,
    sessionId: SESSION_ID,
    ...overrides,
  } as BrowserRunOptions;
}

function failureCapture(options: BrowserRunOptions, result: BrowserRunResult): LiveBrowserRunCapture {
  return {
    promptText: options.prompt,
    answerText: result.answerText,
    observedEffortLabels: [],
    observedTurnIndex: 0,
    baselineTurns: 0,
    modeVerified: false,
    verifiedBeforePromptSubmit: false,
    captureConfidence: "low",
  };
}

function emitOpts(
  overrides: Partial<WrapBrowserExecutorWithV18EmitOptions> = {},
): WrapBrowserExecutorWithV18EmitOptions {
  return {
    homeDir,
    promptManifestSha256: PROMPT_MANIFEST,
    sourceBaselineSha256: SOURCE_BASELINE,
    captureFor: failureCapture,
    ...overrides,
  };
}

describe("wrapBrowserExecutorWithV18Emit — failure path emission", () => {
  testNonWindows("throwing executor still emits failure evidence, then rethrows", async () => {
    const planned = new Error("planned browser executor failure");
    const captureSpy = vi.fn((options: BrowserRunOptions, result: BrowserRunResult) => {
      expect(result.answerText).toBe("");
      expect(result.answerMarkdown).toBe("");
      expect(result.answerChars).toBe(0);
      expect(result.answerTokens).toBe(0);
      expect(result.tookMs).toBeGreaterThanOrEqual(0);
      return failureCapture(options, result);
    });
    const wrapped = wrapBrowserExecutorWithV18Emit(
      throwingExecutor(planned),
      emitOpts({ captureFor: captureSpy }),
    );

    await expect(wrapped(chatGptOptions())).rejects.toBe(planned);
    expect(captureSpy).toHaveBeenCalledTimes(1);

    const evidenceId = `evidence-${SESSION_ID}-chatgpt_pro_first_plan`;
    const rawEvidence = await readFile(evidenceFilePath(SESSION_ID, evidenceId, homeDir), "utf8");
    const evidence = JSON.parse(rawEvidence) as Record<string, unknown>;
    expect(evidence.schema_version).toBe("browser_evidence.v1");
    expect(evidence.evidence_id).toBe(evidenceId);
    expect(evidence.mode_verified).toBe(false);
    expect(evidence.verified_before_prompt_submit).toBe(false);
    expect(evidence.capture_confidence).toBe("low");
    expect(evidence.failure_code).toBe("output_capture_unverified");

    const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.map((entry) => entry.event.type)).toEqual([
      "evidence_written",
      "run_failed",
    ]);
    const failure = ledger.entries.find((entry) => entry.event.type === "run_failed");
    const metadata = failure?.event.metadata as Record<string, unknown> | undefined;
    expect(metadata?.synthesis_eligible).toBe(false);
    expect(metadata?.blocked_error_codes).toEqual(
      expect.arrayContaining(["output_capture_unverified", "output_capture_empty"]),
    );
  });
});
