// Regression test for oracle-ejv: redaction must apply even when
// browser_evidence.v1 declares `redaction_policy: "off"`.
//
// Bug: src/oracle/v18/evidence.ts.writeEvidence skips
// redactEvidencePayload entirely when policy is "off", letting
// passthrough extension keys (cookies, raw_dom, auth_headers,
// screenshot_base64, localStorage, sessionStorage) land in the
// normal evidence directory and artifact index.
//
// Fix (this commit): src/browser/evidence_redact_always.ts adds
// `redactBrowserEvidenceAlways` and `sanitizeBrowserEvidenceForWrite`
// — defense-in-depth helpers the browser layer should run BEFORE
// handing payloads to writeEvidence. Tests prove that the sanitised
// payload is safe to write regardless of the declared policy.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  assertNoForbiddenExtensionKeys,
  findForbiddenExtensionKeys,
  redactBrowserEvidenceAlways,
  sanitizeBrowserEvidenceForWrite,
} from "../../src/browser/evidence_redact_always.js";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserEvidenceSchema,
  evidenceFilePath,
  writeEvidence,
} from "../../src/oracle/v18/index.js";
import { assertNoLeaks } from "../_helpers/secretLeakDetector.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ejv-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const FAKES = [
  { name: "session-cookie", value: "session=PHPSESSID-leak-me-9X8b" },
  { name: "bearer", value: "Bearer leak-bearer-token-1234567890" },
  { name: "raw-dom", value: "<html><body>hidden DOM with PII</body></html>" },
  { name: "screenshot-bytes", value: "data:image/png;base64,LEAKAAAA" },
  { name: "localstorage-value", value: "ls-leak-1234abcdef" },
  { name: "sessionstorage-value", value: "ss-leak-5678fedcba" },
];

function leakyExtensions(): Record<string, unknown> {
  return {
    cookies: FAKES[0].value,
    auth_headers: { Authorization: FAKES[1].value },
    raw_dom: FAKES[2].value,
    screenshot_base64: FAKES[3].value,
    localStorage: { authToken: FAKES[4].value },
    sessionStorage: { csrf: FAKES[5].value },
  };
}

function buildEvidenceWithPolicy(
  policy: "redacted" | "off" | "unsafe_debug",
): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-13T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: `evidence-ejv-${policy}`,
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
    prompt_submitted_at: "2026-05-13T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "provider-result-ejv",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: policy,
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "ejv-run",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: `sha256:${"d".repeat(64)}`,
    transition_log_sha256: `sha256:${"e".repeat(64)}`,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-13T00:00:00Z",
    verified_before_prompt_submit: true,
    ...leakyExtensions(),
  };
}

// ─── Pure redactor ──────────────────────────────────────────────────────────

describe("redactBrowserEvidenceAlways — pure function", () => {
  test("strips every forbidden extension key regardless of policy", () => {
    for (const policy of ["redacted", "off", "unsafe_debug"] as const) {
      const result = redactBrowserEvidenceAlways(buildEvidenceWithPolicy(policy));
      const serialised = JSON.stringify(result.redacted);
      for (const fake of FAKES) {
        expect(serialised, `${policy}: ${fake.name} leaked`).not.toContain(fake.value);
      }
      expect(result.removedPaths.length).toBeGreaterThan(0);
    }
  });

  test("removedPaths reports each stripped field", () => {
    const result = redactBrowserEvidenceAlways(buildEvidenceWithPolicy("off"));
    for (const expected of ["cookies", "auth_headers", "raw_dom", "screenshot_base64"]) {
      expect(result.removedPaths).toContain(expected);
    }
  });

  test("evidence_privacy.stores_* declarations are preserved (carve-out)", () => {
    const result = redactBrowserEvidenceAlways(buildEvidenceWithPolicy("off"));
    const privacy = (result.redacted as Record<string, unknown>).evidence_privacy as Record<
      string,
      unknown
    >;
    expect(privacy.stores_cookies).toBe(false);
    expect(privacy.stores_raw_dom).toBe(false);
    expect(privacy.stores_raw_screenshots).toBe(false);
  });

  test("content-addressed digest keys (_sha256 / _hash) are preserved", () => {
    const result = redactBrowserEvidenceAlways(buildEvidenceWithPolicy("off"));
    const out = result.redacted as Record<string, unknown>;
    expect(out.prompt_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.output_text_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.session_id_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ─── Hard pre-write guard ──────────────────────────────────────────────────

describe("assertNoForbiddenExtensionKeys", () => {
  test("passes for a clean payload", () => {
    const clean = {
      schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      mode_verified: true,
      prompt_sha256: `sha256:${"a".repeat(64)}`,
    };
    expect(() => assertNoForbiddenExtensionKeys(clean)).not.toThrow();
  });

  test("throws on raw cookies at the top level", () => {
    expect(() =>
      assertNoForbiddenExtensionKeys({ cookies: FAKES[0].value }),
    ).toThrow(/forbidden extension key/i);
  });

  test("throws on nested auth_headers", () => {
    expect(() =>
      assertNoForbiddenExtensionKeys({ extra: { auth_headers: { Authorization: "x" } } }),
    ).toThrow(/forbidden extension key/i);
  });

  test("throws on screenshot_base64 (audit-finding extension)", () => {
    expect(() =>
      assertNoForbiddenExtensionKeys({ screenshot_base64: FAKES[3].value }),
    ).toThrow(/forbidden extension key/i);
  });

  test("throws on localStorage / sessionStorage (audit-finding extensions)", () => {
    expect(() => assertNoForbiddenExtensionKeys({ localStorage: { x: 1 } })).toThrow();
    expect(() => assertNoForbiddenExtensionKeys({ sessionStorage: { x: 1 } })).toThrow();
  });

  test("findForbiddenExtensionKeys returns structured hits, not exceptions", () => {
    const hits = findForbiddenExtensionKeys({
      cookies: "x",
      nested: { auth_headers: "y" },
    });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.key).sort()).toEqual(["auth_headers", "cookies"]);
    expect(hits.find((h) => h.key === "auth_headers")?.pointer).toBe("/nested/auth_headers");
  });
});

// ─── End-to-end: sanitised + writeEvidence ──────────────────────────────────

describe("sanitizeBrowserEvidenceForWrite + writeEvidence — round-trip", () => {
  testNonWindows("policy=off + leaky extensions: sanitised payload writes a clean file", async () => {
    const leaky = buildEvidenceWithPolicy("off");
    const sanitised = sanitizeBrowserEvidenceForWrite(leaky);
    // Re-parse the sanitised payload back through the schema — must succeed.
    const reparsed = browserEvidenceSchema.parse(sanitised.redacted);
    expect(reparsed.evidence_id).toBe("evidence-ejv-off");

    const written = await writeEvidence("ejv-session", sanitised.redacted, { homeDir });
    expect(written.quarantined).toBe(false);
    expect(written.path).toBe(
      evidenceFilePath("ejv-session", "evidence-ejv-off", homeDir),
    );

    const raw = await readFile(written.path, "utf8");
    // Defense-in-depth: not a single fake value appears in the on-disk
    // bytes, regardless of the declared redaction_policy.
    assertNoLeaks(raw, { fakes: FAKES });
  });

  testNonWindows("control: same payload via writeEvidence WITHOUT sanitization DOES leak (proves the bug + the fix)", async () => {
    const leaky = buildEvidenceWithPolicy("off");
    const written = await writeEvidence("ejv-control", leaky, { homeDir });
    const raw = await readFile(written.path, "utf8");
    // This is the audit-finding bug surface: writeEvidence's policy=off
    // path skips redaction. We assert at least one leak survives so any
    // future change that accidentally "fixes" the bug at the v18 layer
    // surfaces here (and the always-on guard becomes belt-and-suspenders).
    const leaked = FAKES.some((f) => raw.includes(f.value));
    expect(leaked, "writeEvidence policy=off should leak without sanitization (audit finding)").toBe(
      true,
    );
  });

  testNonWindows("policy=redacted: v18 redactor catches its own forbidden set; always-on guard catches the rest", async () => {
    // The v18 redactor in src/oracle/v18/evidence.ts strips cookie /
    // auth_header / raw_dom / screenshot substrings already, but NOT
    // localStorage / sessionStorage (audit-finding gap). The always-on
    // helper catches the extras even when the v18 redactor is already
    // running.
    const leaky = buildEvidenceWithPolicy("redacted");
    const sanitised = sanitizeBrowserEvidenceForWrite(leaky);
    const written = await writeEvidence("ejv-redacted", sanitised.redacted, { homeDir });
    const raw = await readFile(written.path, "utf8");
    // The combined guard removes every fake including the v18 gaps.
    assertNoLeaks(raw, { fakes: FAKES });
  });

  testNonWindows("always-on redactor is idempotent (safe to run twice)", () => {
    const leaky = buildEvidenceWithPolicy("off");
    const once = redactBrowserEvidenceAlways(leaky);
    const twice = redactBrowserEvidenceAlways(once.redacted);
    expect(twice.removedPaths).toEqual([]);
    expect(twice.redacted).toEqual(once.redacted);
  });
});
