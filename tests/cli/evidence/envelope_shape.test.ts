// Regression suite for oracle-eaz: `oracle evidence show <session> --json`
// and `oracle evidence verify <session> --json` must emit a v1
// json_envelope, not the bare typed result. Every other --json CLI
// surface (capabilities, doctor, run, ledger) wraps via json_envelope.v1
// so robot consumers can branch on `ok` and read recovery fields
// without parsing prose; before this commit the two evidence surfaces
// printed raw EvidenceShowResult / EvidenceVerifyResult JSON.
//
// These tests pin the envelope shape end-to-end: real session
// fixtures on disk, real runEvidenceShow / runEvidenceVerify calls,
// envelope parsed back through the v18 strict refinement so any
// future drift in the failure-arm contract surfaces here too.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runEvidenceShow, runEvidenceVerify } from "../../../src/cli/commands/evidence/index.js";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  jsonEnvelopeSchema,
  jsonEnvelopeStrictSchema,
} from "../../../src/oracle/v18/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const HASH_E = `sha256:${"e".repeat(64)}`;

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function buildEvidence(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: "evidence-test",
    mode_verified: true,
    output_text_sha256: HASH_A,
    prompt_sha256: HASH_B,
    provider_result_id: "provider-result-test",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    selected_effort_is_highest_visible: true,
    session_id_hash: HASH_C,
    transition_log_sha256: HASH_D,
    unsafe_artifacts_quarantined: true,
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

function buildProviderResult(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: "evidence-test",
    prompt_manifest_sha256: HASH_E,
    provider_result_id: "provider-result-test",
    provider_slot: "chatgpt_pro_first_plan",
    result_text_sha256: HASH_A,
    source_baseline_sha256: HASH_C,
    ...overrides,
  };
}

async function withSession(
  files: Record<string, unknown | string>,
  entries: Array<Record<string, unknown>>,
  fn: (params: { oracleHome: string; sessionId: string }) => Promise<void>,
) {
  const oracleHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-eaz-test-"));
  const sessionId = "session-eaz";
  const sessionDir = path.join(oracleHome, "sessions", sessionId);
  const evidenceDir = path.join(sessionDir, "artifacts", "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const raw = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(path.join(evidenceDir, name), raw, "utf8");
  }
  await fs.writeFile(
    path.join(evidenceDir, "artifact-index.json"),
    `${JSON.stringify({ schema_version: "artifact_index.v1", artifacts: entries }, null, 2)}\n`,
    "utf8",
  );
  try {
    await fn({ oracleHome, sessionId });
  } finally {
    await fs.rm(oracleHome, { recursive: true, force: true });
  }
}

function captureJson(stdout: string[]): Record<string, unknown> {
  // The handlers write a single JSON.stringify(envelope, null, 2)
  // chunk. Join the captured chunks then parse — defends against any
  // future change to writeOutput's chunking.
  const joined = stdout.join("\n").trim();
  return JSON.parse(joined) as Record<string, unknown>;
}

describe("oracle evidence show --json — json_envelope.v1 shape (oracle-eaz)", () => {
  test("success envelope: ok=true, schema_version=json_envelope.v1, data carries the result", async () => {
    const evidence = buildEvidence();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: sha256(evidenceBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        await runEvidenceShow(
          sessionId,
          { json: true, oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const envelope = captureJson(stdout);

        // Envelope shell checks.
        expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
        expect(envelope.ok).toBe(true);
        expect(envelope.meta).toMatchObject({
          tool: "oracle evidence show",
          session_id: sessionId,
        });
        expect(envelope.blocked_reason).toBeNull();
        expect(envelope.next_command).toBeNull();
        expect(envelope.fix_command).toBeNull();
        expect(envelope.retry_safe).toBeNull();
        expect(envelope.errors).toEqual([]);
        expect(envelope.warnings).toEqual([]);
        expect(envelope.commands).toEqual({});

        // The base schema parses the on-the-wire bytes byte-for-byte.
        expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();

        // The data slot carries the EvidenceShowResult.
        const data = envelope.data as Record<string, unknown>;
        expect(data.session).toBe(sessionId);
        expect((data.index as Record<string, unknown>).schema_version).toBe("artifact_index.v1");
      },
    );
  });

  test("success envelope satisfies the strict schema (success arm has no extra invariants)", async () => {
    const evidence = buildEvidence();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: sha256(evidenceBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        await runEvidenceShow(
          sessionId,
          { json: true, oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const envelope = captureJson(stdout);
        const result = jsonEnvelopeStrictSchema.safeParse(envelope);
        expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
      },
    );
  });

  test("human (non-json) output is unchanged — no envelope wrapper bleeds into prose", async () => {
    const evidence = buildEvidence();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: sha256(evidenceBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        await runEvidenceShow(
          sessionId,
          { oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const joined = stdout.join("\n");
        expect(joined).toContain("Evidence index:");
        expect(joined).toContain("Artifacts: 1");
        expect(joined).not.toContain("schema_version");
        expect(joined).not.toContain("json_envelope");
      },
    );
  });
});

describe("oracle evidence verify --json — json_envelope.v1 shape (oracle-eaz)", () => {
  test("success envelope: ok=true with EvidenceVerifyResult in data", async () => {
    const evidence = buildEvidence();
    const providerResult = buildProviderResult();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    const providerResultBytes = `${JSON.stringify(providerResult, null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes, "provider-result.json": providerResultBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: sha256(evidenceBytes),
        },
        {
          artifact_id: "provider-result-test",
          kind: "provider_result",
          path: "artifacts/evidence/provider-result.json",
          sha256: sha256(providerResultBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        const result = await runEvidenceVerify(
          sessionId,
          { json: true, oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const envelope = captureJson(stdout);

        expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
        expect(envelope.ok).toBe(true);
        expect(envelope.meta).toMatchObject({
          tool: "oracle evidence verify",
          session_id: sessionId,
        });
        expect(envelope.errors).toEqual([]);
        expect(envelope.commands).toMatchObject({
          show: `oracle evidence show ${sessionId} --json`,
        });

        const data = envelope.data as Record<string, unknown>;
        expect(data.ok).toBe(true);
        expect(data.artifactCount).toBe(2);

        // The function still returns the typed result; only the
        // side-effect output changed.
        expect(result.ok).toBe(true);
      },
    );
  });

  test("failure envelope: ok=false with v18 recovery contract fields populated", async () => {
    const evidence = buildEvidence();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    // Deliberately wrong sha256 so the hash mismatch fires.
    const wrongSha = `sha256:${"f".repeat(64)}`;
    await withSession(
      { "evidence.json": evidenceBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: wrongSha,
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        const result = await runEvidenceVerify(
          sessionId,
          { json: true, oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const envelope = captureJson(stdout);

        expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
        expect(envelope.ok).toBe(false);
        // v18 §12 recovery contract: failures must declare retry_safe,
        // a blocked_reason, and a non-empty errors[] with a taxonomy
        // error_code + message.
        expect(envelope.retry_safe).toBe(false);
        expect(typeof envelope.blocked_reason).toBe("string");
        expect((envelope.blocked_reason as string).length).toBeGreaterThan(0);
        expect(envelope.next_command).toBe(`oracle evidence verify ${sessionId} --json`);
        expect(envelope.fix_command).toBe(`oracle evidence show ${sessionId} --json`);

        const errors = envelope.errors as Array<Record<string, unknown>>;
        expect(errors).toHaveLength(1);
        expect(errors[0].error_code).toBe("output_capture_unverified");
        expect(typeof errors[0].message).toBe("string");

        // Granular per-artifact codes survive inside details.
        const details = errors[0].details as Record<string, unknown>;
        expect(details.session_id).toBe(sessionId);
        const issueCodes = details.issue_codes as string[];
        expect(issueCodes).toContain("artifact_hash_mismatch");

        // The data slot still carries the typed EvidenceVerifyResult.
        const data = envelope.data as Record<string, unknown>;
        expect(data.ok).toBe(false);

        // Strict schema must accept the failure envelope.
        const parsed = jsonEnvelopeStrictSchema.safeParse(envelope);
        expect(
          parsed.success,
          parsed.success ? "" : JSON.stringify(parsed.error.issues),
        ).toBe(true);

        // The function return preserves the underlying typed result.
        expect(result.ok).toBe(false);
        expect(result.errors[0]?.code).toBe("artifact_hash_mismatch");
      },
    );
  });

  test("human (non-json) verify output is unchanged", async () => {
    const evidence = buildEvidence();
    const providerResult = buildProviderResult();
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    const providerResultBytes = `${JSON.stringify(providerResult, null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes, "provider-result.json": providerResultBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: sha256(evidenceBytes),
        },
        {
          artifact_id: "provider-result-test",
          kind: "provider_result",
          path: "artifacts/evidence/provider-result.json",
          sha256: sha256(providerResultBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const stdout: string[] = [];
        await runEvidenceVerify(
          sessionId,
          { oracleHomeDir: oracleHome },
          { stdout: (text) => stdout.push(text) },
        );
        const joined = stdout.join("\n");
        expect(joined).toContain("Evidence verify: ok");
        expect(joined).not.toContain("schema_version");
        expect(joined).not.toContain("json_envelope");
      },
    );
  });
});
