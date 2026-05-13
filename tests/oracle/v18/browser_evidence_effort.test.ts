import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  emitV18BrowserArtifacts,
  type EmitV18BrowserArtifactsInput,
  type LiveBrowserRunCapture,
} from "../../../src/browser/runLive_v18.js";
import { deriveBrowserEvidenceEffortFields } from "../../../src/oracle/v18/browser_evidence_effort.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const SESSION_ID = "session-4xg-effort";
const PROMPT_MANIFEST = `sha256:${"c".repeat(63)}1` as const;
const SOURCE_BASELINE = `sha256:${"d".repeat(63)}1` as const;
const LABELS_HASH = `sha256:${"e".repeat(63)}1` as const;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-4xg-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function capture(overrides: Partial<LiveBrowserRunCapture> = {}): LiveBrowserRunCapture {
  return {
    promptText: "Audit the v18 browser evidence effort fields.",
    answerText: "The highest visible effort verdict was used.",
    observedEffortLabels: ["Standard", "Heavy", "Ultra"],
    observedTurnIndex: 2,
    baselineTurns: 1,
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    captureConfidence: "high",
    ...overrides,
  };
}

function input(
  overrides: Partial<EmitV18BrowserArtifactsInput> = {},
): EmitV18BrowserArtifactsInput {
  return {
    sessionId: SESSION_ID,
    homeDir,
    providerSlot: "chatgpt_pro_synthesis",
    providerResultId: "provider-result-4xg",
    evidenceId: "evidence-4xg",
    accessPath: "oracle_browser_remote",
    capture: capture(),
    promptManifestSha256: PROMPT_MANIFEST,
    sourceBaselineSha256: SOURCE_BASELINE,
    runId: "run-4xg",
    ...overrides,
  };
}

describe("browser_evidence.v1 effort derivation", () => {
  test("derives success fields from the selected effort verdict", () => {
    const fields = deriveBrowserEvidenceEffortFields({
      status: "verified",
      availableEffortLabelsHash: LABELS_HASH,
      tier: "ultra",
      selected: "Ultra",
      selectorManifestVersion: "chatgpt-selectors.v1",
      selectedIsHighestVisible: true,
      errorCode: null,
    });

    expect(fields.reasoning_effort_verified).toBe(true);
    expect(fields.selected_effort_is_highest_visible).toBe(true);
    expect(fields.observed_reasoning_effort_label).toBe("Ultra");
    expect(fields.effort_rank).toBe("ultra");
    expect(fields.available_effort_labels_hash).toBe(LABELS_HASH);
    expect(fields.failure_code).toBeNull();
    expect(fields.next_command).toBeNull();
    expect(fields.fix_command).toBeNull();
  });

  testNonWindows(
    "persists the actual verified effort label instead of hardcoded Heavy",
    async () => {
      const result = await emitV18BrowserArtifacts(input());
      const persisted = JSON.parse(await readFile(result.evidenceFilePath, "utf8"));

      expect(result.effortVerdict.status).toBe("verified");
      expect(result.effortVerdict.selected).toBe("Ultra");
      expect(persisted.observed_reasoning_effort_label).toBe("Ultra");
      expect(persisted.observed_reasoning_effort_label).not.toBe("Heavy");
      expect(persisted.reasoning_effort_verified).toBe(true);
      expect(persisted.selected_effort_is_highest_visible).toBe(true);
      expect(persisted.available_effort_labels_hash).toBe(
        result.effortVerdict.availableEffortLabelsHash,
      );
      expect(persisted.selector_manifest_version).toBe(
        result.effortVerdict.selectorManifestVersion,
      );
      expect(result.providerResult.result.reasoning_effort_verified).toBe(true);
    },
  );

  testNonWindows(
    "empty observed labels do not produce verified Heavy browser evidence",
    async () => {
      const result = await emitV18BrowserArtifacts(
        input({
          capture: capture({ observedEffortLabels: [] }),
        }),
      );
      const persisted = JSON.parse(await readFile(result.evidenceFilePath, "utf8"));

      expect(result.effortVerdict.status).toBe("unverified");
      expect(result.providerResult.result.reasoning_effort_verified).toBe(false);
      expect(
        result.providerResult.blockedReasons.some(
          (reason) => reason.code === "chatgpt_extended_reasoning_unverified",
        ),
      ).toBe(true);

      expect(persisted.reasoning_effort_verified).toBe(false);
      expect(persisted.selected_effort_is_highest_visible).toBe(false);
      expect(persisted.observed_reasoning_effort_label).toBe("");
      expect(persisted.observed_reasoning_effort_label).not.toBe("Heavy");
      expect(persisted.available_effort_labels_hash).toBe(
        result.effortVerdict.availableEffortLabelsHash,
      );
      expect(persisted.failure_code).toBe("output_capture_unverified");
      expect(persisted.next_command).toBe("oracle doctor chatgpt --json");
      expect(result.synthesisEligible).toBe(false);
    },
  );
});
