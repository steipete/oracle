import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_LAYOUT,
  FORBIDDEN_KEY_TEST,
  V18_BUNDLE_VERSION,
  artifactIndexSchema,
  canonicalJSON,
  evidenceDir,
  evidenceFilePath,
  evidenceIndexPath,
  listIndexedEvidence,
  listQuarantinedEvidence,
  quarantineDir,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  redactEvidencePayload,
  sha256OfBytes,
  writeEvidence,
} from "@src/oracle/v18/index.ts";

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

const testNonWindows = process.platform === "win32" ? test.skip : test;

// A minimal, schema-valid browser_evidence.v1 payload. Tests mutate it
// per-case (forbidden extension keys, different redaction policies, etc.).
function buildEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-test-session-1",
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

describe("FORBIDDEN_KEY_TEST", () => {
  test.each([
    "cookies",
    "Cookie",
    "set-cookie",
    "Set-Cookie",
    "cookie_jar",
    "account_email",
    "Account_Email",
    "email",
    "user_email",
    "raw_dom",
    "dom_html",
    "dom_snapshot",
    "html_snapshot",
    "screenshot",
    "screenshots",
    "screenshot_base64",
    "screenshot_data",
    "auth",
    "Authorization",
    "auth_headers",
    "bearer_token",
    "access_token",
    "session_token",
    "api_key",
    "raw_prompt",
    "prompt_text",
    "raw_output",
    "output_text",
    "assistant_text",
    "response_text",
  ])("recognizes %s as forbidden", (key) => {
    expect(FORBIDDEN_KEY_TEST(key)).toBe(true);
  });

  test.each([
    "prompt_sha256",
    "output_text_sha256",
    "provider_slot",
    "verified_at",
    "schema_version",
    "evidence_id",
    "selector_manifest_version",
    "mode_verified",
    "verified_before_prompt_submit",
    "redaction_policy",
  ])("does NOT match typed core field %s", (key) => {
    expect(FORBIDDEN_KEY_TEST(key)).toBe(false);
  });
});

describe("redactEvidencePayload", () => {
  test("strips forbidden top-level keys and records their paths", () => {
    const input = {
      provider_slot: "chatgpt_pro_first_plan",
      cookies: "session=abc; csrf=def",
      account_email: "agent@example.com",
      auth_headers: { Authorization: "Bearer secret" },
      raw_dom: "<html>secret</html>",
      screenshot: "data:image/png;base64,AAAA",
      raw_prompt: "private prompt",
      raw_output: "private output",
    };
    const result = redactEvidencePayload(input);
    expect(result.redacted).toEqual({ provider_slot: "chatgpt_pro_first_plan" });
    expect(result.removedPaths).toEqual(
      expect.arrayContaining([
        "cookies",
        "account_email",
        "auth_headers",
        "raw_dom",
        "screenshot",
        "raw_prompt",
        "raw_output",
      ]),
    );
  });

  test("walks nested objects and arrays", () => {
    const input = {
      meta: { run: "x", cookie: "stripme" },
      attachments: [
        { caption: "ok", screenshot: "raw" },
        { caption: "ok2", html_snapshot: "<div>" },
      ],
      headers: { authorization: "Bearer x", "Set-Cookie": "y" },
    };
    const { redacted, removedPaths } = redactEvidencePayload(input);
    expect(redacted).toEqual({
      meta: { run: "x" },
      attachments: [{ caption: "ok" }, { caption: "ok2" }],
      headers: {},
    });
    expect(removedPaths).toEqual(
      expect.arrayContaining([
        "meta.cookie",
        "attachments[0].screenshot",
        "attachments[1].html_snapshot",
        "headers.authorization",
        "headers.Set-Cookie",
      ]),
    );
  });

  test("does not mutate the input", () => {
    const input = { cookies: "c", inner: { account_email: "x@y.z", keep: 1 } };
    const cloneBefore = JSON.parse(JSON.stringify(input));
    redactEvidencePayload(input);
    expect(input).toEqual(cloneBefore);
  });

  test("leaves typed-core sha256 fields intact", () => {
    const evidence = buildEvidence();
    const { redacted, removedPaths } = redactEvidencePayload(evidence);
    expect(removedPaths).toEqual([]);
    expect((redacted as Record<string, unknown>).prompt_sha256).toBe(evidence.prompt_sha256);
    expect((redacted as Record<string, unknown>).output_text_sha256).toBe(
      evidence.output_text_sha256,
    );
  });
});

describe("canonicalJSON + sha256OfBytes", () => {
  test("canonical JSON is key-order independent", () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
  });

  test("sha256OfBytes returns the sha256:<hex> shape", () => {
    const out = sha256OfBytes("hello");
    expect(out).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("evidence path helpers", () => {
  test("evidenceFilePath places redacted files under sessions/<id>/evidence/", () => {
    const dir = evidenceDir("sess-1", "/tmp/oracle-home");
    expect(dir).toBe(path.join("/tmp/oracle-home", "sessions", "sess-1", "evidence"));
    const file = evidenceFilePath("sess-1", "evidence-1", "/tmp/oracle-home");
    expect(file).toBe(path.join(dir, "evidence-1.json"));
  });

  test("quarantineFilePath lives under evidence/quarantine/", () => {
    const qdir = quarantineDir("sess-1", "/tmp/oracle-home");
    expect(qdir).toBe(
      path.join("/tmp/oracle-home", "sessions", "sess-1", "evidence", "quarantine"),
    );
    const qfile = quarantineFilePath("sess-1", "evidence-1", "/tmp/oracle-home");
    expect(qfile).toBe(path.join(qdir, "evidence-1.json"));
  });

  test("index paths point at index.json beside their kind of evidence", () => {
    expect(evidenceIndexPath("sess-1", "/tmp/oracle-home")).toBe(
      path.join("/tmp/oracle-home", "sessions", "sess-1", "evidence", "index.json"),
    );
    expect(quarantineIndexPath("sess-1", "/tmp/oracle-home")).toBe(
      path.join("/tmp/oracle-home", "sessions", "sess-1", "evidence", "quarantine", "index.json"),
    );
  });

  test("rejects unsafe session ids", () => {
    expect(() => evidenceDir("..", "/tmp")).toThrow(/Invalid session id/);
    expect(() => evidenceDir("a/b", "/tmp")).toThrow(/Invalid session id/);
    expect(() => evidenceDir("a\\b", "/tmp")).toThrow(/Invalid session id/);
  });

  test("rejects unsafe evidence ids", () => {
    expect(() => evidenceFilePath("sess-1", "../escape", "/tmp")).toThrow(/Invalid evidence id/);
    expect(() => evidenceFilePath("sess-1", "..\\escape", "/tmp")).toThrow(/Invalid evidence id/);
    expect(() => evidenceFilePath("sess-1", "", "/tmp")).toThrow(/Invalid evidence id/);
  });

  test("EVIDENCE_LAYOUT exposes the contractual constants", () => {
    expect(EVIDENCE_LAYOUT.SESSIONS_DIRNAME).toBe("sessions");
    expect(EVIDENCE_LAYOUT.EVIDENCE_DIRNAME).toBe("evidence");
    expect(EVIDENCE_LAYOUT.QUARANTINE_DIRNAME).toBe("quarantine");
    expect(EVIDENCE_LAYOUT.INDEX_FILENAME).toBe("index.json");
    expect(EVIDENCE_LAYOUT.EVIDENCE_KIND).toBe("browser_evidence");
  });
});

describe("writeEvidence + artifact index", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-evidence-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  testNonWindows("default policy writes a redacted file and indexes it", async () => {
    const evidence = buildEvidence({
      // adversarial extension keys at multiple levels
      cookies: "session=abc",
      account_email: "agent@example.com",
      auth_headers: { Authorization: "Bearer redact-me" },
      raw_dom: "<html>",
      screenshot: "data:image/png;base64,XYZ",
      raw_prompt: "leaked prompt",
      raw_output: "leaked output",
      evidence_privacy: {
        stores_account_identifiers: false,
        stores_cookies: false,
        stores_raw_dom: false,
        stores_raw_screenshots: false,
        debug_session_token: "should-not-survive",
      },
    });
    const written = await writeEvidence("sess-1", evidence, { homeDir });

    expect(written.quarantined).toBe(false);
    expect(written.indexed).toBe(true);
    expect(written.path).toBe(evidenceFilePath("sess-1", "evidence-test-session-1", homeDir));

    // Disk bytes must not contain any forbidden VALUE…
    const raw = await readFile(written.path, "utf8");
    for (const leakedValue of [
      "session=abc",
      "agent@example.com",
      "<html>",
      "data:image/png;base64,XYZ",
      "leaked prompt",
      "leaked output",
      "Bearer redact-me",
      "should-not-survive",
    ]) {
      expect(raw, `forbidden value "${leakedValue}" present in evidence`).not.toContain(
        leakedValue,
      );
    }
    // …and walking the parsed JSON, no KEY must match the forbidden pattern.
    const onDisk = JSON.parse(raw);
    const allKeys = collectKeys(onDisk);
    for (const key of allKeys) {
      expect(FORBIDDEN_KEY_TEST(key), `forbidden key "${key}" present in evidence`).toBe(false);
    }
    expect(written.removedPaths).toEqual(
      expect.arrayContaining([
        "cookies",
        "account_email",
        "auth_headers",
        "raw_dom",
        "screenshot",
        "raw_prompt",
        "raw_output",
        "evidence_privacy.debug_session_token",
      ]),
    );

    // sha256 in the index must match the canonical bytes on disk.
    const index = await readArtifactIndex(evidenceIndexPath("sess-1", homeDir));
    expect(index).not.toBeNull();
    expect(index!.schema_version).toBe(ARTIFACT_INDEX_SCHEMA_VERSION);
    expect(index!.artifacts).toHaveLength(1);
    const entry = index!.artifacts[0];
    expect(entry.artifact_id).toBe("evidence-test-session-1");
    expect(entry.kind).toBe("browser_evidence");
    expect(entry.path).toBe("evidence-test-session-1.json");
    expect(entry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry.sha256).toBe(written.sha256);
    const onDiskBytes = await readFile(written.path, "utf8");
    expect(sha256OfBytes(onDiskBytes.trimEnd())).toBe(entry.sha256);
  });

  testNonWindows("redaction is on by default — implicit policy === 'redacted'", async () => {
    const evidence = buildEvidence({ cookies: "session=abc" });
    expect(evidence.redaction_policy).toBe("redacted");
    const written = await writeEvidence("sess-2", evidence, { homeDir });
    const raw = await readFile(written.path, "utf8");
    expect(raw).not.toContain("session=abc");
    const parsed = JSON.parse(raw);
    for (const key of collectKeys(parsed)) {
      expect(FORBIDDEN_KEY_TEST(key), `forbidden key "${key}" survived redaction`).toBe(false);
    }
  });

  testNonWindows(
    "redaction_policy: off writes typed-core only (no extension keys to strip)",
    async () => {
      const evidence = buildEvidence({ redaction_policy: "off" });
      // No forbidden fields injected; result should be schema-typed core only.
      const written = await writeEvidence("sess-3", evidence, { homeDir });
      const raw = await readFile(written.path, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.redaction_policy).toBe("off");
      expect(parsed.evidence_id).toBe(evidence.evidence_id);
    },
  );

  testNonWindows("unsafe_debug goes to quarantine and is excluded from normal index", async () => {
    const evidence = buildEvidence({
      redaction_policy: "unsafe_debug",
      evidence_id: "evidence-debug-1",
    });
    const written = await writeEvidence("sess-4", evidence, {
      homeDir,
      evidenceMode: "unsafe",
      acknowledgeUnsafeEvidence: true,
    });

    expect(written.quarantined).toBe(true);
    expect(written.indexed).toBe(false);
    expect(written.path).toBe(quarantineFilePath("sess-4", "evidence-debug-1", homeDir));

    // Normal index never sees the quarantined entry.
    const normalIndex = await readArtifactIndex(evidenceIndexPath("sess-4", homeDir));
    expect(normalIndex).toBeNull();
    expect(await listIndexedEvidence("sess-4", homeDir)).toEqual([]);

    // Quarantine has its own index containing the entry.
    const qIndex = await readArtifactIndex(quarantineIndexPath("sess-4", homeDir));
    expect(qIndex).not.toBeNull();
    expect(qIndex!.artifacts).toHaveLength(1);
    expect(qIndex!.artifacts[0].artifact_id).toBe("evidence-debug-1");
    expect(await listQuarantinedEvidence("sess-4", homeDir)).toHaveLength(1);
  });

  testNonWindows("allowQuarantine=false rejects unsafe_debug payloads outright", async () => {
    const evidence = buildEvidence({ redaction_policy: "unsafe_debug" });
    await expect(
      writeEvidence("sess-5", evidence, { homeDir, allowQuarantine: false }),
    ).rejects.toThrow(/unsafe_debug/);
  });

  testNonWindows(
    "re-writing the same evidence_id replaces the index entry (no duplicates)",
    async () => {
      const first = buildEvidence({ evidence_id: "evidence-replay-1" });
      const second = buildEvidence({
        evidence_id: "evidence-replay-1",
        mode_verified: false,
      });
      await writeEvidence("sess-6", first, { homeDir });
      const written2 = await writeEvidence("sess-6", second, { homeDir });

      const index = await readArtifactIndex(evidenceIndexPath("sess-6", homeDir));
      expect(index!.artifacts).toHaveLength(1);
      expect(index!.artifacts[0].sha256).toBe(written2.sha256);
    },
  );

  testNonWindows("run_id from options propagates into the index envelope", async () => {
    const evidence = buildEvidence({ evidence_id: "evidence-run-1" });
    await writeEvidence("sess-7", evidence, { homeDir, runId: "run-abc" });
    const index = await readArtifactIndex(evidenceIndexPath("sess-7", homeDir));
    expect(index!.run_id).toBe("run-abc");
    expect(index!.bundle_version).toBe(V18_BUNDLE_VERSION);
  });

  test("rejects malformed evidence payload before touching disk", async () => {
    const evidence = buildEvidence({ prompt_sha256: "not-a-hash" });
    await expect(writeEvidence("sess-bad", evidence, { homeDir })).rejects.toThrow();
    // No directory should have been created.
    await expect(readFile(evidenceIndexPath("sess-bad", homeDir), "utf8")).rejects.toThrow();
  });
});

describe("artifact_index.v1 contract", () => {
  test("rejects entries with bad sha256", () => {
    expect(() =>
      artifactIndexSchema.parse({
        schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
        artifacts: [{ artifact_id: "a", kind: "browser_evidence", path: "a.json", sha256: "bad" }],
      }),
    ).toThrow();
  });

  test("accepts entries missing optional artifact_id (matches v17 premortem fixture)", () => {
    const parsed = artifactIndexSchema.parse({
      schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
      artifacts: [
        {
          kind: "v17_premortem_control",
          path: "fixtures/failure-mode-ledger.json",
          sha256: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].artifact_id).toBeUndefined();
  });
});
