import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { quarantineInvalidEvidenceArtifact } from "@src/browser/evidence-quarantine.ts";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
} from "@src/oracle/v18/contracts.ts";
import {
  evidenceIndexPath,
  listIndexedEvidence,
  listQuarantinedEvidence,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
} from "@src/oracle/v18/evidence.ts";
import {
  UnsafeEvidenceModeError,
  writeEvidenceWithMode,
} from "@src/oracle/v18/evidence_unsafe.ts";

function buildEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-unsafe-test",
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
    redaction_policy: "redacted",
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

describe("unsafe evidence mode gate", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-evidence-unsafe-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("safe mode writes redacted evidence to the normal index", async () => {
    const written = await writeEvidenceWithMode(
      "sess-safe",
      buildEvidence({ cookies: "session=secret" }),
      { homeDir },
    );

    expect(written.quarantined).toBe(false);
    expect(await listIndexedEvidence("sess-safe", homeDir)).toHaveLength(1);
    expect(await listQuarantinedEvidence("sess-safe", homeDir)).toEqual([]);
    expect(await readFile(written.path, "utf8")).not.toContain("session=secret");
  });

  test("unsafe_debug requires explicit unsafe mode", async () => {
    await expect(
      writeEvidenceWithMode(
        "sess-no-mode",
        buildEvidence({
          evidence_id: "unsafe-no-mode",
          redaction_policy: "unsafe_debug",
        }),
        { homeDir },
      ),
    ).rejects.toThrow(UnsafeEvidenceModeError);
    expect(await readArtifactIndex(evidenceIndexPath("sess-no-mode", homeDir))).toBeNull();
  });

  test("unsafe_debug requires acknowledgement even when unsafe mode is selected", async () => {
    await expect(
      writeEvidenceWithMode(
        "sess-no-ack",
        buildEvidence({
          evidence_id: "unsafe-no-ack",
          redaction_policy: "unsafe_debug",
        }),
        { homeDir, evidenceMode: "unsafe" },
      ),
    ).rejects.toThrow(/acknowledgement/i);
  });

  test("unsafe_debug is quarantined only after both unsafe flags are present", async () => {
    const written = await writeEvidenceWithMode(
      "sess-unsafe",
      buildEvidence({
        evidence_id: "unsafe-ok",
        redaction_policy: "unsafe_debug",
        cookies: "session=secret",
        raw_dom: "<html>secret</html>",
      }),
      { homeDir, evidenceMode: "unsafe", acknowledgeUnsafeEvidence: true },
    );

    expect(written.quarantined).toBe(true);
    expect(written.indexed).toBe(false);
    expect(written.path).toBe(quarantineFilePath("sess-unsafe", "unsafe-ok", homeDir));
    expect(await listIndexedEvidence("sess-unsafe", homeDir)).toEqual([]);
    const quarantineEntries = await listQuarantinedEvidence("sess-unsafe", homeDir);
    expect(quarantineEntries).toHaveLength(1);
    expect(quarantineEntries[0].artifact_id).toBe("unsafe-ok");
    const raw = await readFile(written.path, "utf8");
    expect(raw).not.toContain("session=secret");
    expect(raw).not.toContain("<html>secret</html>");
  });

  test.each(["doctor", "capabilities", "dry-run"])(
    "unsafe mode is forbidden for %s commands",
    async (commandKind) => {
      await expect(
        writeEvidenceWithMode(
          `sess-${commandKind}`,
          buildEvidence({
            evidence_id: `unsafe-${commandKind}`,
            redaction_policy: "unsafe_debug",
          }),
          {
            homeDir,
            evidenceMode: "unsafe",
            acknowledgeUnsafeEvidence: true,
            commandKind,
          },
        ),
      ).rejects.toThrow(/not allowed/i);
    },
  );
});

describe("browser evidence validation quarantine", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-evidence-quarantine-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("writes invalid evidence artifacts to quarantine only and redacts secrets", async () => {
    const result = await quarantineInvalidEvidenceArtifact({
      sessionId: "sess-invalid",
      evidenceId: "Bad Evidence/../../raw",
      homeDir,
      runId: "run-invalid",
      now: () => "2026-05-13T00:00:00.000Z",
      validationError: new Error("browser_evidence.prompt_sha256 is missing"),
      payload: {
        evidence_id: "Bad Evidence/../../raw",
        prompt: "visible",
        cookies: "session=secret",
        account_email: "agent@example.com",
        raw_dom: "<html>secret</html>",
        screenshot_base64: "base64-secret",
      },
    });

    expect(result.artifactId).toBe("bad-evidence-raw.invalid");
    expect(result.path).toBe(
      quarantineFilePath("sess-invalid", "bad-evidence-raw.invalid", homeDir),
    );
    expect(await readArtifactIndex(evidenceIndexPath("sess-invalid", homeDir))).toBeNull();
    expect(await listIndexedEvidence("sess-invalid", homeDir)).toEqual([]);

    const qIndex = await readArtifactIndex(quarantineIndexPath("sess-invalid", homeDir));
    expect(qIndex?.run_id).toBe("run-invalid");
    expect(qIndex?.artifacts).toHaveLength(1);
    expect(qIndex?.artifacts[0]).toMatchObject({
      artifact_id: "bad-evidence-raw.invalid",
      kind: "invalid_browser_evidence",
      path: "bad-evidence-raw.invalid.json",
      sha256: result.sha256,
    });

    const raw = await readFile(result.path, "utf8");
    expect(raw).toContain("browser_evidence.prompt_sha256 is missing");
    expect(raw).toContain("visible");
    expect(raw).not.toContain("session=secret");
    expect(raw).not.toContain("agent@example.com");
    expect(raw).not.toContain("<html>secret</html>");
    expect(raw).not.toContain("base64-secret");
    expect(result.removedPaths).toEqual(
      expect.arrayContaining([
        "payload.cookies",
        "payload.account_email",
        "payload.raw_dom",
        "payload.screenshot_base64",
      ]),
    );
  });
});
