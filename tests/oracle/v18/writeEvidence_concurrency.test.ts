import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { drainArtifactIndexLocksForTest } from "../../../src/oracle/v18/artifact_index_lock.js";
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  type BrowserEvidence,
} from "../../../src/oracle/v18/contracts.js";
import {
  evidenceFilePath,
  evidenceIndexPath,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  sha256OfBytes,
  writeEvidence,
} from "../../../src/oracle/v18/evidence.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-write-evidence-"));
});

afterEach(async () => {
  await drainArtifactIndexLocksForTest();
  await rm(homeDir, { recursive: true, force: true });
});

function hash(seed: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(seed, "utf8").digest("hex")}`;
}

function buildEvidence(
  evidenceId: string,
  redactionPolicy: BrowserEvidence["redaction_policy"] = "redacted",
): BrowserEvidence {
  return {
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    evidence_id: evidenceId,
    provider_slot: "chatgpt_pro_first_plan",
    provider: "chatgpt",
    requested_mode: "pro_extended_reasoning",
    mode_verified: true,
    verified_before_prompt_submit: true,
    verified_at: "2026-05-13T00:00:00.000Z",
    prompt_submitted_at: "2026-05-13T00:00:01.000Z",
    verification_method: "same_session_ui_observation_plus_selector_trace",
    capture_confidence: "high",
    redaction_policy: redactionPolicy,
    session_id_hash: hash(`${evidenceId}:session`),
    selector_manifest_version: "chatgpt-selectors.v1",
    transition_log_sha256: hash(`${evidenceId}:transition`),
    prompt_sha256: hash(`${evidenceId}:prompt`),
    output_text_sha256: hash(`${evidenceId}:output`),
    unsafe_artifacts_quarantined: true,
    created_at: "2026-05-13T00:00:02.000Z",
    run_id: "run-concurrent",
    provider_result_id: `provider-result-${evidenceId}`,
    verification_scope: "same_browser_session_before_prompt_submit",
    requested_reasoning_effort: "max_browser_available",
    observed_reasoning_effort_label: "Heavy",
    reasoning_effort_verified: true,
    effort_rank: "heavy",
    selected_effort_is_highest_visible: true,
    available_effort_labels_hash: hash(`${evidenceId}:labels`),
    browser_effort_strategy: "select_highest_visible",
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    next_command: null,
  };
}

describe("writeEvidence concurrent artifact-index updates", () => {
  testNonWindows("retains every normal evidence entry from concurrent writers", async () => {
    const sessionId = "sess-write-evidence-concurrent";
    const ids = Array.from({ length: 64 }, (_, index) => `evidence-concurrent-${index}`);

    await Promise.all(
      ids.map((id) =>
        writeEvidence(sessionId, buildEvidence(id), {
          homeDir,
          runId: "run-concurrent-normal",
        }),
      ),
    );

    const index = await readArtifactIndex(evidenceIndexPath(sessionId, homeDir));
    expect(index?.schema_version).toBe(ARTIFACT_INDEX_SCHEMA_VERSION);
    expect(index?.run_id).toBe("run-concurrent-normal");
    expect(index?.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(index?.artifacts).toHaveLength(ids.length);

    const byId = new Map(index!.artifacts.map((entry) => [entry.artifact_id, entry]));
    for (const id of ids) {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe("browser_evidence");
      expect(entry!.path).toBe(`${id}.json`);
      const raw = await readFile(evidenceFilePath(sessionId, id, homeDir), "utf8");
      expect(entry!.sha256).toBe(sha256OfBytes(raw.trimEnd()));
    }
  });

  testNonWindows("retains every unsafe_debug entry in the quarantine index only", async () => {
    const sessionId = "sess-write-evidence-quarantine-concurrent";
    const ids = Array.from({ length: 32 }, (_, index) => `evidence-quarantine-${index}`);

    await Promise.all(
      ids.map((id) =>
        writeEvidence(sessionId, buildEvidence(id, "unsafe_debug"), {
          homeDir,
          runId: "run-concurrent-quarantine",
        }),
      ),
    );

    expect(await readArtifactIndex(evidenceIndexPath(sessionId, homeDir))).toBeNull();
    const index = await readArtifactIndex(quarantineIndexPath(sessionId, homeDir));
    expect(index?.schema_version).toBe(ARTIFACT_INDEX_SCHEMA_VERSION);
    expect(index?.run_id).toBe("run-concurrent-quarantine");
    expect(index?.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(index?.artifacts).toHaveLength(ids.length);

    const byId = new Map(index!.artifacts.map((entry) => [entry.artifact_id, entry]));
    for (const id of ids) {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe("browser_evidence");
      expect(entry!.path).toBe(`${id}.json`);
      const raw = await readFile(quarantineFilePath(sessionId, id, homeDir), "utf8");
      expect(entry!.sha256).toBe(sha256OfBytes(raw.trimEnd()));
    }
  });
});
