import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runEvidenceShow, runEvidenceVerify } from "../../../src/cli/commands/evidence/index.js";

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
  fn: (params: { oracleHome: string; sessionId: string; sessionDir: string }) => Promise<void>,
) {
  const oracleHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-evidence-test-"));
  const sessionId = "session-one";
  const sessionDir = path.join(oracleHome, "sessions", sessionId);
  const evidenceDir = path.join(sessionDir, "artifacts", "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const raw = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(path.join(evidenceDir, name), raw, "utf8");
  }
  await fs.writeFile(
    path.join(evidenceDir, "artifact-index.json"),
    `${JSON.stringify(
      {
        schema_version: "artifact_index.v1",
        artifacts: entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    await fn({ oracleHome, sessionId, sessionDir });
  } finally {
    await fs.rm(oracleHome, { recursive: true, force: true });
  }
}

describe("evidence CLI commands", () => {
  test("show prints a redacted evidence index without artifact bodies", async () => {
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
          raw_prompt: "do not print this",
          cookie: "do not print this either",
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const output: string[] = [];
        const result = await runEvidenceShow(
          sessionId,
          { oracleHomeDir: oracleHome },
          { stdout: (text) => output.push(text) },
        );

        expect(result.index.artifacts?.[0]).toMatchObject({
          artifact_id: "evidence-test",
          raw_prompt: "[redacted]",
          cookie: "[redacted]",
        });
        expect(output.join("\n")).toContain("Artifacts: 1");
        expect(output.join("\n")).toContain("browser_evidence evidence-test");
        expect(output.join("\n")).not.toContain("do not print this");
      },
    );
  });

  test("verify accepts valid evidence and provider-result linkage", async () => {
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
        const output: string[] = [];
        const result = await runEvidenceVerify(
          sessionId,
          { json: true, oracleHomeDir: oracleHome },
          { stdout: (text) => output.push(text) },
        );

        expect(result.ok).toBe(true);
        expect(result.verified).toHaveLength(2);
        expect(JSON.parse(output[0])).toMatchObject({ ok: true, artifactCount: 2 });
      },
    );
  });

  test("verify reports missing files and bad index hash shapes", async () => {
    await withSession(
      {},
      [
        {
          artifact_id: "missing",
          kind: "browser_evidence",
          path: "missing.json",
          sha256: HASH_A,
        },
        {
          artifact_id: "bad-hash",
          kind: "browser_evidence",
          path: "bad.json",
          sha256: "sha256:short",
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const result = await runEvidenceVerify(sessionId, { oracleHomeDir: oracleHome });

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toEqual(
          expect.arrayContaining(["artifact_missing", "artifact_hash_invalid"]),
        );
      },
    );
  });

  test("verify reports artifact hash mismatches", async () => {
    const evidenceBytes = `${JSON.stringify(buildEvidence(), null, 2)}\n`;
    await withSession(
      { "evidence.json": evidenceBytes },
      [
        {
          artifact_id: "evidence-test",
          kind: "browser_evidence",
          path: "evidence.json",
          sha256: HASH_A,
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const result = await runEvidenceVerify(sessionId, { oracleHomeDir: oracleHome });

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toContain("artifact_hash_mismatch");
      },
    );
  });

  test("verify rejects unsafe browser evidence that is not quarantined", async () => {
    const evidence = buildEvidence({ unsafe_artifacts_quarantined: false });
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
        const result = await runEvidenceVerify(sessionId, { oracleHomeDir: oracleHome });

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "evidence_verification_field_false",
              message: expect.stringContaining("unsafe_artifacts_quarantined"),
            }),
          ]),
        );
      },
    );
  });

  test("verify rejects mismatched provider result evidence linkage", async () => {
    const evidence = buildEvidence();
    const providerResult = buildProviderResult({ evidence_id: "other-evidence" });
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
          path: "provider-result.json",
          sha256: sha256(providerResultBytes),
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const result = await runEvidenceVerify(sessionId, { oracleHomeDir: oracleHome });

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toContain(
          "provider_result_evidence_id_mismatch",
        );
      },
    );
  });

  test("verify refuses artifact paths that escape the evidence root", async () => {
    await withSession(
      {},
      [
        {
          artifact_id: "escape",
          kind: "browser_evidence",
          path: "../outside.json",
          sha256: HASH_A,
        },
      ],
      async ({ oracleHome, sessionId }) => {
        const result = await runEvidenceVerify(sessionId, { oracleHomeDir: oracleHome });

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toContain("artifact_path_unsafe");
      },
    );
  });
});
