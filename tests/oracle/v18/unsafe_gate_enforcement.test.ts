import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BROWSER_EVIDENCE_SCHEMA_VERSION, V18_BUNDLE_VERSION } from "@src/oracle/v18/contracts.ts";
import {
  evidenceIndexPath,
  listIndexedEvidence,
  listQuarantinedEvidence,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  writeEvidence,
} from "@src/oracle/v18/evidence.ts";
import { UnsafeEvidenceModeError } from "@src/oracle/v18/evidence_unsafe.ts";

function buildEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "unsafe-gate-test",
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
    provider_result_id: "provider-result-test",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "unsafe_debug",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "run-test",
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

describe("production unsafe evidence gate enforcement", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-unsafe-gate-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("writeEvidence rejects unsafe_debug by default before creating indexes", async () => {
    await expect(writeEvidence("sess-default", buildEvidence(), { homeDir })).rejects.toThrow(
      UnsafeEvidenceModeError,
    );

    expect(await readArtifactIndex(evidenceIndexPath("sess-default", homeDir))).toBeNull();
    expect(await readArtifactIndex(quarantineIndexPath("sess-default", homeDir))).toBeNull();
  });

  test("legacy allowQuarantine flag alone does not authorize unsafe_debug", async () => {
    await expect(
      writeEvidence("sess-legacy", buildEvidence(), { homeDir, allowQuarantine: true }),
    ).rejects.toThrow(UnsafeEvidenceModeError);

    expect(await listIndexedEvidence("sess-legacy", homeDir)).toEqual([]);
    expect(await listQuarantinedEvidence("sess-legacy", homeDir)).toEqual([]);
  });

  test("unsafe_debug lands in quarantine only with mode and acknowledgement", async () => {
    const written = await writeEvidence(
      "sess-authorized",
      buildEvidence({ evidence_id: "unsafe-authorized" }),
      {
        homeDir,
        evidenceMode: "unsafe",
        acknowledgeUnsafeEvidence: true,
      },
    );

    expect(written.quarantined).toBe(true);
    expect(written.indexed).toBe(false);
    expect(written.path).toBe(quarantineFilePath("sess-authorized", "unsafe-authorized", homeDir));
    expect(await listIndexedEvidence("sess-authorized", homeDir)).toEqual([]);
    expect(await listQuarantinedEvidence("sess-authorized", homeDir)).toHaveLength(1);
  });

  test.each(["doctor", "capabilities", "dry-run"])(
    "production writer forbids unsafe mode for %s commands",
    async (commandKind) => {
      await expect(
        writeEvidence("sess-forbidden", buildEvidence(), {
          homeDir,
          evidenceMode: "unsafe",
          acknowledgeUnsafeEvidence: true,
          commandKind,
        }),
      ).rejects.toThrow(/not allowed/i);
    },
  );

  test("unsafe_debug still requires quarantine declaration when unsafe mode is acknowledged", async () => {
    await expect(
      writeEvidence(
        "sess-no-quarantine-declaration",
        buildEvidence({ unsafe_artifacts_quarantined: false }),
        {
          homeDir,
          evidenceMode: "unsafe",
          acknowledgeUnsafeEvidence: true,
        },
      ),
    ).rejects.toThrow(/unsafe_artifacts_quarantined=true/);
  });
});
