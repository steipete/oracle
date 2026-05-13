// v18 `json_envelope.v1` helpers and error taxonomy.
//
// The Zod parser for the envelope lives in `./contracts.ts`. This module
// adds two things on top of that schema:
//
// 1. A typed builder (`createEnvelope`, `createErrorEnvelope`) that
//    populates every required field of `json_envelope.v1` so robot-facing
//    commands cannot accidentally omit one. The shape matches the schema
//    in `PLAN/oracle-vnext-plan-bundle-v18.0.0/contracts/json-envelope.schema.json`.
//
// 2. The named error code taxonomy required by v18 spec §12, plus the
//    contract that every error envelope carries `blocked_reason`,
//    `next_command`, `fix_command`, and `retry_safe` so callers never have
//    to parse prose for recovery state.

import { z } from "zod";

import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  jsonEnvelopeSchema,
  type JsonEnvelope,
} from "./contracts.js";

/**
 * The required error code taxonomy from v18 spec §12.
 *
 * Sourced from PLAN/oracle-vnext-plan-bundle-v18.0.0/spec.md §12 and the
 * `remote_browser_token_missing` extension recorded on oracle-0h7.
 *
 * Each value is a stable string identifier; do not rename without a
 * bundle-version bump in the plan bundle and a coordinated APR change.
 */
export const V18_ERROR_CODES = [
  "provider_login_required",
  "browser_lock_timeout",
  "remote_browser_unavailable",
  "remote_browser_auth_failed",
  "remote_browser_token_missing",
  "chatgpt_pro_unverified",
  "chatgpt_extended_reasoning_unverified",
  "gemini_deep_think_unverified",
  "ui_drift_suspected",
  "output_capture_empty",
  "output_capture_unverified",
  "provider_usage_limit",
  "prompt_submitted_before_verification",
] as const;

export type V18ErrorCode = (typeof V18_ERROR_CODES)[number];

const V18_ERROR_CODE_SET: ReadonlySet<string> = new Set(V18_ERROR_CODES);

export function isV18ErrorCode(value: unknown): value is V18ErrorCode {
  return typeof value === "string" && V18_ERROR_CODE_SET.has(value);
}

/** A single error entry inside the `errors[]` array of an envelope. */
export interface V18ErrorEntry {
  error_code: V18ErrorCode;
  message: string;
  /** Free-form structured detail for the error; do not put secrets here. */
  details?: Record<string, unknown>;
}

/**
 * Inputs to {@link createEnvelope}. Required-by-schema fields are required
 * here too; everything else has a deterministic empty default so the
 * resulting object always satisfies `json_envelope.v1`.
 */
export interface CreateEnvelopeInput {
  ok: boolean;
  data: JsonEnvelope["data"];
  meta: Record<string, unknown>;
  errors?: V18ErrorEntry[];
  warnings?: string[];
  commands?: Record<string, unknown>;
  blocked_reason?: string | null;
  next_command?: string | null;
  fix_command?: string | null;
  retry_safe?: boolean | null;
}

/**
 * Build a `json_envelope.v1` object. Every field required by the schema is
 * populated, including the nullable recovery fields (set to `null` when
 * not provided) so the shape is uniform whether `ok` is true or false.
 *
 * Pass an extension key via the `extensions` parameter when callers must
 * round-trip additional metadata; `additionalProperties: true` in the
 * schema means extensions survive validation, but they must not collide
 * with a core field name.
 */
export function createEnvelope(
  input: CreateEnvelopeInput,
  extensions: Record<string, unknown> = {},
): JsonEnvelope {
  const envelope: JsonEnvelope = {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: input.ok,
    data: input.data,
    meta: { ...input.meta },
    blocked_reason: input.blocked_reason ?? null,
    next_command: input.next_command ?? null,
    fix_command: input.fix_command ?? null,
    retry_safe: input.retry_safe ?? null,
    errors: (input.errors ?? []).map(toErrorRecord),
    warnings: [...(input.warnings ?? [])],
    commands: { ...(input.commands ?? {}) },
  };
  // Apply extensions last but never let them overwrite a core field; the
  // strict-core / permissive-extension policy is that unknown keys must
  // round-trip without flipping core decisions. See
  // PLAN/.../docs/contract-core-extension-policy.md.
  for (const [key, value] of Object.entries(extensions)) {
    if (key in envelope) continue;
    (envelope as Record<string, unknown>)[key] = value;
  }
  return envelope;
}

/**
 * Build a failure envelope. `ok` is forced to false, `retry_safe` is
 * required (no implicit `null` for failures — every v18 failure must
 * declare whether retry is safe), and `blocked_reason` defaults to the
 * first error's `error_code` so callers always have a machine-readable
 * blocker without having to read prose.
 */
export interface CreateErrorEnvelopeInput {
  errors: [V18ErrorEntry, ...V18ErrorEntry[]];
  meta: Record<string, unknown>;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean;
  blocked_reason?: string | null;
  warnings?: string[];
  commands?: Record<string, unknown>;
  data?: JsonEnvelope["data"];
}

export function createErrorEnvelope(
  input: CreateErrorEnvelopeInput,
  extensions: Record<string, unknown> = {},
): JsonEnvelope {
  return createEnvelope(
    {
      ok: false,
      data: input.data ?? null,
      meta: input.meta,
      errors: input.errors,
      warnings: input.warnings,
      commands: input.commands,
      blocked_reason: input.blocked_reason ?? input.errors[0].error_code,
      next_command: input.next_command,
      fix_command: input.fix_command,
      retry_safe: input.retry_safe,
    },
    extensions,
  );
}

/**
 * Lightweight runtime guard: throws if the envelope is missing any of the
 * v18 recovery contract fields for a failure. Use this in CI / unit tests
 * to assert helper output meets the spec without reaching for the full
 * Zod parser.
 */
export function assertRecoveryContract(env: JsonEnvelope): void {
  if (env.ok) return;
  if (env.blocked_reason == null) {
    throw new Error("v18 failure envelope is missing blocked_reason");
  }
  if (env.retry_safe == null) {
    throw new Error("v18 failure envelope is missing retry_safe");
  }
  if (env.errors.length === 0) {
    throw new Error("v18 failure envelope is missing errors[]");
  }
  for (const [index, entry] of env.errors.entries()) {
    if (typeof entry !== "object" || entry == null) {
      throw new Error(`v18 failure envelope errors[${index}] is not an object`);
    }
    const code = (entry as Record<string, unknown>).error_code;
    if (typeof code !== "string") {
      throw new Error(`v18 failure envelope errors[${index}] is missing error_code`);
    }
  }
}

function toErrorRecord(entry: V18ErrorEntry): Record<string, unknown> {
  const record: Record<string, unknown> = {
    error_code: entry.error_code,
    message: entry.message,
  };
  if (entry.details) {
    record.details = entry.details;
  }
  return record;
}

// ─── strict failure-arm refinement ─────────────────────────────────────────
//
// jsonEnvelopeSchema in ./contracts.ts intentionally stays permissive — it
// validates shape but not the v18 recovery contract for failures. Schema
// consumers that don't also call assertRecoveryContract were accepting
// malformed `ok=false` envelopes (errors[] empty, retry_safe null, etc.),
// which let unrecoverable robot errors slip through unnoticed.
//
// jsonEnvelopeStrictSchema layers a discriminated refinement on top: the
// success arm (ok=true) parses identically to the base schema, while the
// failure arm (ok=false) enforces every v18 §12 invariant at parse time so
// callers can rely on parse success as proof of recoverability.

/**
 * Schema for a single entry inside `errors[]` of a v18 failure envelope.
 *
 * Strict-core / permissive-extension: `error_code` must be drawn from the
 * v18 taxonomy and `message` must be non-empty, but extra keys round-trip
 * via `.passthrough()` so callers can carry structured detail.
 */
export const v18ErrorEntrySchema = z
  .object({
    error_code: z.enum(V18_ERROR_CODES),
    message: z.string().min(1, "v18 error entry message must be non-empty"),
  })
  .passthrough();

/**
 * Strict variant of {@link jsonEnvelopeSchema}: rejects malformed
 * `ok=false` envelopes that violate the v18 recovery contract.
 *
 * Failure-arm invariants (all enforced at parse time):
 * - `errors` must be a non-empty array.
 * - Each `errors[i]` must carry an `error_code` from {@link V18_ERROR_CODES}
 *   and a non-empty `message`.
 * - `retry_safe` must be a boolean (no `null` — every failure must declare
 *   whether retry is safe).
 * - `blocked_reason` must be a non-empty string (no `null`, no `""`).
 *
 * Success envelopes (ok=true) pass through unchanged; their recovery
 * fields stay nullable per the base schema. The inferred TypeScript type
 * matches {@link JsonEnvelope} exactly — this is a runtime narrowing, not
 * a type change.
 */
export const jsonEnvelopeStrictSchema = jsonEnvelopeSchema.superRefine((envelope, ctx) => {
  if (envelope.ok) return;
  if (envelope.retry_safe === null || typeof envelope.retry_safe !== "boolean") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retry_safe"],
      message: "v18 failure envelope requires retry_safe to be a boolean (not null)",
    });
  }
  if (typeof envelope.blocked_reason !== "string" || envelope.blocked_reason.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocked_reason"],
      message: "v18 failure envelope requires a non-empty blocked_reason string",
    });
  }
  if (!Array.isArray(envelope.errors) || envelope.errors.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errors"],
      message: "v18 failure envelope requires errors[] to be a non-empty array",
    });
    return;
  }
  for (let index = 0; index < envelope.errors.length; index += 1) {
    const result = v18ErrorEntrySchema.safeParse(envelope.errors[index]);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ["errors", index, ...issue.path],
      });
    }
  }
});

/**
 * Parse and validate an envelope under the strict failure-arm contract.
 *
 * Thin wrapper around {@link jsonEnvelopeStrictSchema}.safeParse — included
 * for symmetry with {@link assertRecoveryContract}, which checks the same
 * invariants but throws instead of returning a result object.
 */
export function parseJsonEnvelopeStrict(value: unknown): z.ZodSafeParseResult<JsonEnvelope> {
  return jsonEnvelopeStrictSchema.safeParse(value);
}
