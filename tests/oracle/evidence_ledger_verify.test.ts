import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
} from "../../src/oracle/evidence_ledger.js";
import {
  evidenceFilePath,
  evidenceIndexPath,
  readArtifactIndex,
  writeArtifactIndex,
  writeEvidence,
} from "../../src/oracle/v18/evidence.js";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
} from "../../src/oracle/v18/contracts.js";
import { verifyEvidenceLedger } from "../../src/oracle/evidence_ledger_verify.js";
import { runEvidenceLedgerVerify } from "../../src/cli/commands/evidence/ledger_verify.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;
const SESSION_ID = "session-ledger-verify";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-verify-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-ledger-verify-1",
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    mode_verified: true,
    next_command: null,
    observed_reasoning_effort_label: "Heavy",
    output_text_sha256: `sha256:${"b".repeat(64)}`,
    prompt_sha256: `sha256:${"c".repeat(64)}`,
    prompt_submitted_at: "2026-05-12T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "provider-result-ledger-verify",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "run-ledger-verify",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: `sha256:${"d".repeat(64)}`,
    transition_log_sha256: `sha256:${"e".repeat(64)}`,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-12T00:00:00Z",
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

async function writeEvidenceAndLedger(evidenceId = "evidence-ledger-verify-1"): Promise<void> {
  await writeEvidence(SESSION_ID, evidence({ evidence_id: evidenceId }), { homeDir });
  await appendEvidenceLedgerEvent(
    SESSION_ID,
    { type: "session_started", provider_slot: "chatgpt_pro_first_plan" },
    { homeDir },
  );
  await appendEvidenceLedgerEvent(
    SESSION_ID,
    { type: "evidence_written", evidence_id: evidenceId },
    { homeDir },
  );
}

describe("verifyEvidenceLedger", () => {
  testNonWindows("passes when the ledger chain, evidence file, and artifact index agree", async () => {
    await writeEvidenceAndLedger();

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(true);
    expect(result.chain_valid).toBe(true);
    expect(result.evidence_written_count).toBe(1);
    expect(result.files_checked).toBe(1);
    expect(result.artifact_index_present).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.file_checks[0]).toMatchObject({
      evidence_id: "evidence-ledger-verify-1",
      artifact_index_path: "evidence-ledger-verify-1.json",
      ok: true,
    });
  });

  testNonWindows("reports a broken prev_hash chain before trusting file checks", async () => {
    await writeEvidenceAndLedger();
    const ledgerPath = evidenceLedgerPath(SESSION_ID, homeDir);
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1]);
    second.prev_hash = `sha256:${"f".repeat(63)}0`;
    lines[1] = JSON.stringify(second);
    await writeFile(ledgerPath, `${lines.join("\n")}\n`, "utf8");

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(false);
    expect(result.chain_valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "evidence_ledger_chain_invalid",
      field: "evidence_ledger.chain",
    });
    expect(result.files_checked).toBe(0);
  });

  testNonWindows("fails when evidence_written lacks an evidence_id", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "evidence_written" }, { homeDir });

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("evidence_id_missing");
  });

  testNonWindows("fails when the referenced evidence file is missing", async () => {
    await writeEvidenceAndLedger();
    await unlink(evidenceFilePath(SESSION_ID, "evidence-ledger-verify-1", homeDir));

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "evidence_file_missing",
      evidence_id: "evidence-ledger-verify-1",
    });
    expect(result.file_checks[0]?.file_sha256).toBeNull();
  });

  testNonWindows("fails when artifact index sha256 does not match on-disk evidence bytes", async () => {
    await writeEvidenceAndLedger();
    await writeFile(
      evidenceFilePath(SESSION_ID, "evidence-ledger-verify-1", homeDir),
      `${JSON.stringify({ evidence_id: "evidence-ledger-verify-1", tampered: true })}\n`,
      "utf8",
    );

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("evidence_file_hash_mismatch");
    expect(result.file_checks[0]?.file_sha256).not.toBe(result.file_checks[0]?.index_sha256);
  });

  testNonWindows("fails when artifact index path points outside the evidence directory", async () => {
    await writeEvidenceAndLedger();
    const indexPath = evidenceIndexPath(SESSION_ID, homeDir);
    const index = await readArtifactIndex(indexPath);
    expect(index).not.toBeNull();
    await writeArtifactIndex(indexPath, {
      ...index!,
      artifacts: index!.artifacts.map((entry) => ({
        ...entry,
        path: "../escape.json",
      })),
    });

    const result = await verifyEvidenceLedger(SESSION_ID, { homeDir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("artifact_index_path_escape");
  });
});

describe("runEvidenceLedgerVerify", () => {
  testNonWindows("emits a success json envelope", async () => {
    await writeEvidenceAndLedger();
    const lines: string[] = [];

    const { envelope, result } = await runEvidenceLedgerVerify(
      { sessionId: SESSION_ID, homeDir, json: true },
      { log: (line) => lines.push(line) },
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(result?.ok).toBe(true);
    expect(JSON.parse(lines[0]).data.schema_version).toBe("evidence_ledger_verify.v1");
  });

  testNonWindows("emits a recovery envelope for the first inconsistency", async () => {
    await writeEvidenceAndLedger();
    await unlink(evidenceFilePath(SESSION_ID, "evidence-ledger-verify-1", homeDir));

    const { envelope } = await runEvidenceLedgerVerify(
      { sessionId: SESSION_ID, homeDir, json: true },
      { log: () => {} },
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("output_capture_unverified");
    expect(envelope.errors[0]?.message).toMatch(/does not exist/);
    expect(envelope.next_command).toMatch(/oracle evidence ledger show/);
    expect(envelope.fix_command).toMatch(/oracle evidence ledger rebuild/);
    expect(envelope.retry_safe).toBe(false);
  });
});
