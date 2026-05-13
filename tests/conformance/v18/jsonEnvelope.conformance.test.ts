// Conformance harness for v18 `json_envelope.v1`.
//
// Loads the canonical schema and fixture from the v18 plan bundle, then
// runs three layers of checks:
//
//  1. Schema-derived MUST clauses (required fields, type constraints,
//     additionalProperties=true) against the hand-rolled validator in
//     ./harness.ts.
//  2. Helper round-trip: `createEnvelope` / `createErrorEnvelope` output
//     parses against both the JSON Schema validator AND the Zod parser
//     in `src/oracle/v18/contracts.ts`.
//  3. Spec §11/§12 recovery contract: failure envelopes carry
//     `blocked_reason`, `next_command`, `fix_command`, `retry_safe`, and
//     the named error codes from the v18 taxonomy.

import { describe, expect, test } from "vitest";

import {
  V18_ERROR_CODES,
  assertRecoveryContract,
  createEnvelope,
  createErrorEnvelope,
  isV18ErrorCode,
  jsonEnvelopeSchema,
  type V18ErrorCode,
} from "../../../src/oracle/v18/index.js";
import {
  isValid,
  loadJsonEnvelopeSchema,
  loadOkFixture,
  validateEnvelope,
  type JsonEnvelopeSchema,
} from "./harness.js";

let schema: JsonEnvelopeSchema;
let okFixture: Record<string, unknown>;

describe("json_envelope.v1 conformance harness", () => {
  test("loads schema and fixture from the v18 plan bundle", async () => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    expect(schema.type).toBe("object");
    expect(schema.required.length).toBeGreaterThanOrEqual(11);
    expect(schema.additionalProperties).toBe(true);
  });

  test("required field list matches spec §11", async () => {
    schema = await loadJsonEnvelopeSchema();
    const required = new Set(schema.required);
    for (const field of [
      "ok",
      "schema_version",
      "data",
      "meta",
      "blocked_reason",
      "next_command",
      "fix_command",
      "retry_safe",
      "errors",
      "warnings",
      "commands",
    ]) {
      expect(required.has(field), `schema.required must include ${field}`).toBe(true);
    }
  });

  test("canonical ok fixture validates against the schema", async () => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    expect(validateEnvelope(okFixture, schema)).toEqual([]);
    expect(okFixture.schema_version).toBe("json_envelope.v1");
  });

  test.each([
    "ok",
    "schema_version",
    "data",
    "meta",
    "blocked_reason",
    "next_command",
    "fix_command",
    "retry_safe",
    "errors",
    "warnings",
    "commands",
  ])("stripping required field %s is rejected", async (field) => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    const stripped: Record<string, unknown> = { ...okFixture };
    delete stripped[field];
    const failures = validateEnvelope(stripped, schema);
    expect(failures.some((f) => f.pointer === `/${field}`)).toBe(true);
  });

  test.each([
    { field: "ok", bad: "true" },
    { field: "schema_version", bad: 1 },
    { field: "errors", bad: {} },
    { field: "warnings", bad: "single-string-not-array" },
    { field: "commands", bad: [] },
    { field: "meta", bad: null },
    { field: "blocked_reason", bad: 0 },
    { field: "retry_safe", bad: "maybe" },
  ])("rejects $field with wrong type", async ({ field, bad }) => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    const mutated: Record<string, unknown> = { ...okFixture, [field]: bad };
    expect(isValid(mutated, schema)).toBe(false);
  });

  test("rejects non-object entries inside errors[]", async () => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    const mutated = { ...okFixture, errors: ["not-an-object"] };
    const failures = validateEnvelope(mutated, schema);
    expect(failures.some((f) => f.pointer.startsWith("/errors/"))).toBe(true);
  });

  test("rejects non-string entries inside warnings[]", async () => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    const mutated = { ...okFixture, warnings: [42] };
    const failures = validateEnvelope(mutated, schema);
    expect(failures.some((f) => f.pointer.startsWith("/warnings/"))).toBe(true);
  });

  test("additionalProperties=true preserves extension keys", async () => {
    schema = await loadJsonEnvelopeSchema();
    okFixture = await loadOkFixture();
    const withExtension = { ...okFixture, x_oracle_run_id: "run-abc" };
    expect(validateEnvelope(withExtension, schema)).toEqual([]);
  });
});

describe("createEnvelope helper", () => {
  test("produces a schema-conforming success envelope", async () => {
    schema = await loadJsonEnvelopeSchema();
    const env = createEnvelope({
      ok: true,
      data: { message: "ok" },
      meta: { tool: "oracle-test" },
    });
    expect(validateEnvelope(env, schema)).toEqual([]);
    expect(jsonEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.schema_version).toBe("json_envelope.v1");
    // Nullable recovery fields must exist as `null`, not missing.
    expect(env.blocked_reason).toBeNull();
    expect(env.next_command).toBeNull();
    expect(env.fix_command).toBeNull();
    expect(env.retry_safe).toBeNull();
    expect(env.errors).toEqual([]);
    expect(env.warnings).toEqual([]);
    expect(env.commands).toEqual({});
  });

  test("preserves extension keys but never overwrites core fields", async () => {
    schema = await loadJsonEnvelopeSchema();
    const env = createEnvelope(
      { ok: true, data: null, meta: { tool: "oracle-test" } },
      { x_run_id: "run-xyz", ok: "MUST_NOT_OVERRIDE" },
    );
    expect(validateEnvelope(env, schema)).toEqual([]);
    expect((env as Record<string, unknown>).x_run_id).toBe("run-xyz");
    expect(env.ok).toBe(true);
  });

  test("data accepts every schema-allowed shape", async () => {
    schema = await loadJsonEnvelopeSchema();
    for (const data of [null, "string-data", [] as unknown[], { x: 1 } as Record<string, unknown>]) {
      const env = createEnvelope({ ok: true, data, meta: {} });
      expect(validateEnvelope(env, schema)).toEqual([]);
    }
  });
});

describe("createErrorEnvelope helper and v18 error taxonomy", () => {
  test("V18_ERROR_CODES matches spec §12", () => {
    // The full list, including the remote_browser_token_missing extension
    // recorded on the bead description.
    expect([...V18_ERROR_CODES].sort()).toEqual(
      [
        "browser_lock_timeout",
        "chatgpt_extended_reasoning_unverified",
        "chatgpt_pro_unverified",
        "gemini_deep_think_unverified",
        "output_capture_empty",
        "output_capture_unverified",
        "prompt_submitted_before_verification",
        "provider_login_required",
        "provider_usage_limit",
        "remote_browser_auth_failed",
        "remote_browser_token_missing",
        "remote_browser_unavailable",
        "ui_drift_suspected",
      ].sort(),
    );
  });

  test("isV18ErrorCode accepts taxonomy codes and rejects unknown", () => {
    for (const code of V18_ERROR_CODES) {
      expect(isV18ErrorCode(code)).toBe(true);
    }
    expect(isV18ErrorCode("not_a_real_code")).toBe(false);
    expect(isV18ErrorCode(null)).toBe(false);
    expect(isV18ErrorCode(42)).toBe(false);
  });

  test.each<V18ErrorCode>([...V18_ERROR_CODES])(
    "failure envelope for %s carries the full recovery contract",
    async (code) => {
      schema = await loadJsonEnvelopeSchema();
      const env = createErrorEnvelope({
        errors: [{ error_code: code, message: `simulated ${code}` }],
        meta: { tool: "oracle-test" },
        next_command: "oracle browser sessions recover --provider chatgpt --json",
        fix_command: "oracle chatgpt doctor --pro --extended-reasoning --json",
        retry_safe: false,
      });
      // 1. JSON Schema (plan bundle) conformance.
      expect(validateEnvelope(env, schema)).toEqual([]);
      // 2. Zod (in-repo contract) conformance.
      expect(jsonEnvelopeSchema.safeParse(env).success).toBe(true);
      // 3. Recovery contract from spec §11.
      expect(env.ok).toBe(false);
      expect(env.blocked_reason).toBe(code);
      expect(env.next_command).toMatch(/^oracle /);
      expect(env.fix_command).toMatch(/^oracle /);
      expect(env.retry_safe).toBe(false);
      assertRecoveryContract(env);
    },
  );

  test("blocked_reason defaults to the first error code when caller omits it", () => {
    const env = createErrorEnvelope({
      errors: [
        { error_code: "chatgpt_pro_unverified", message: "verify failed" },
        { error_code: "ui_drift_suspected", message: "selector changed" },
      ],
      meta: { tool: "oracle-test" },
      next_command: "oracle chatgpt doctor --json",
      fix_command: "oracle chatgpt doctor --pro --extended-reasoning --json",
      retry_safe: true,
    });
    expect(env.blocked_reason).toBe("chatgpt_pro_unverified");
  });

  test("error entries preserve optional structured details", () => {
    const env = createErrorEnvelope({
      errors: [
        {
          error_code: "remote_browser_unavailable",
          message: "host unreachable",
          details: { host: "192.0.2.1", port: 9473 },
        },
      ],
      meta: {},
      next_command: null,
      fix_command: "oracle browser sessions recover --provider chatgpt --json",
      retry_safe: true,
    });
    const first = env.errors[0] as Record<string, unknown>;
    expect(first.error_code).toBe("remote_browser_unavailable");
    expect(first.details).toEqual({ host: "192.0.2.1", port: 9473 });
  });

  test("assertRecoveryContract throws when failure envelope is missing fields", () => {
    const broken = createEnvelope({
      ok: false,
      data: null,
      meta: {},
      errors: [{ error_code: "provider_login_required", message: "x" }],
    });
    // No blocked_reason / retry_safe explicitly set → assertRecoveryContract trips.
    expect(() => assertRecoveryContract(broken)).toThrow(/blocked_reason|retry_safe/);
  });
});
