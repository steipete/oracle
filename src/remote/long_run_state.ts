// Long-run state snapshotting + resume decision engine.
//
// Long ChatGPT Pro thinking windows (10m–1h per AGENTS.md) can outlive
// any local timeout. When that happens, Oracle MUST return recoverable
// background state — never false success — so the caller can reattach
// via `oracle session <id>`. This module is the generic substrate for
// that; the ChatGPT-specific behavior lives in
// `src/browser/providers/chatgptPro_recovery.ts`.
//
// Three responsibilities:
//
//   1. `LongRunStateSnapshot` — a typed, serializable projection of the
//      remote-run state so it can be persisted to session metadata and
//      reloaded later by a fresh process.
//   2. `decideResume(snapshot, now, policy)` — pure decision engine
//      that returns one of `complete | resumable_background |
//      resumable_attempt | unrecoverable`, each carrying
//      `next_command`, `fix_command`, `retry_safe`, and a v18
//      error_code where one applies.
//   3. `buildRecoveryEnvelope` — wraps the decision in a v18
//      `json_envelope.v1` so robot callers (and the CLI's `session`
//      command) can emit a uniform recovery surface.
//
// The module reads from `src/remote/reconnect.ts` for the
// `RemoteRunState` type but never modifies it; reconnect.ts is owned
// by my prior oracle-nyn work and is read-only here.

import { z } from "zod";

import { V18_BUNDLE_VERSION, type JsonEnvelope } from "../oracle/v18/contracts.js";
import {
  createEnvelope,
  createErrorEnvelope,
  type V18ErrorCode,
  type V18ErrorEntry,
} from "../oracle/v18/json_envelope.js";
import type { RemoteRunState } from "./reconnect.js";

export const LONG_RUN_STATE_SCHEMA_VERSION = "long_run_state.v1" as const;

/** Hard upper bound for "still thinking" Pro waits — matches AGENTS.md. */
export const PRO_THINKING_HARD_MAX_MS = 60 * 60 * 1000;

/** Minimum elapsed window before we accept a "Pro is still thinking" claim. */
export const PRO_THINKING_MIN_BACKGROUND_MS = 10 * 60 * 1000;

export type LongRunObservedState =
  | "thinking"
  | "reconnecting"
  | "background"
  | "completed"
  | "failed_retryable"
  | "failed_terminal";

export const longRunStateSnapshotSchema = z
  .object({
    schema_version: z.literal(LONG_RUN_STATE_SCHEMA_VERSION),
    bundle_version: z.literal(V18_BUNDLE_VERSION),
    session_id: z.string(),
    provider_slot: z.string(),
    run_id: z.string(),
    started_at_ms: z.number().int(),
    last_event_at_ms: z.number().int(),
    state: z.enum([
      "thinking",
      "reconnecting",
      "background",
      "completed",
      "failed_retryable",
      "failed_terminal",
    ]),
    attempts: z.number().int().nonnegative(),
    observed_reasoning_effort_label: z.string().nullable(),
    evidence_id: z.string().nullable(),
    conversation_url_hint: z.string().nullable(),
    recover_command: z.string(),
  })
  .passthrough();
export type LongRunStateSnapshot = z.infer<typeof longRunStateSnapshotSchema>;

export interface SnapshotInput {
  readonly session_id: string;
  readonly provider_slot: string;
  readonly run_id: string;
  readonly observed_state: LongRunObservedState;
  readonly remote: RemoteRunState;
  readonly evidence_id?: string | null;
  readonly conversation_url_hint?: string | null;
}

/**
 * Project a `RemoteRunState` (from reconnect.ts) + caller context into a
 * persistable `LongRunStateSnapshot`. Pure — never reads the clock; the
 * remote state already carries `lastHeartbeatMs` and `startedAtMs`.
 */
export function snapshotRunState(input: SnapshotInput): LongRunStateSnapshot {
  const draft: LongRunStateSnapshot = {
    schema_version: LONG_RUN_STATE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    session_id: input.session_id,
    provider_slot: input.provider_slot,
    run_id: input.run_id,
    started_at_ms: input.remote.startedAtMs,
    last_event_at_ms: input.remote.lastHeartbeatMs,
    state: input.observed_state,
    attempts: input.remote.attempts,
    observed_reasoning_effort_label: input.remote.observedReasoningLabel,
    evidence_id: input.evidence_id ?? null,
    conversation_url_hint: input.conversation_url_hint ?? null,
    recover_command: `oracle session ${input.session_id}`,
  };
  return longRunStateSnapshotSchema.parse(draft);
}

export function parseSnapshot(input: unknown): LongRunStateSnapshot {
  return longRunStateSnapshotSchema.parse(input);
}

export function serializeSnapshot(snapshot: LongRunStateSnapshot): string {
  return JSON.stringify(snapshot);
}

// ─── Resume decision ─────────────────────────────────────────────────────────

export type ResumeKind =
  | "complete"
  | "resumable_background"
  | "resumable_attempt"
  | "unrecoverable";

export interface ResumeDecision {
  readonly kind: ResumeKind;
  readonly reason: string;
  readonly next_command: string;
  readonly fix_command: string | null;
  readonly retry_safe: boolean;
  readonly error_code: V18ErrorCode | null;
  /** User-visible message; never invents prose Oracle doesn't have evidence for. */
  readonly user_visible_message: string;
}

export interface ResumePolicy {
  /** Reject "still thinking" claims past this wall budget (defaults to AGENTS.md 1h). */
  readonly hardMaxThinkingMs: number;
  /** Below this wall, accept "thinking" as legitimate (defaults to 10m). */
  readonly thinkingMinBackgroundMs: number;
  /** Maximum reattach attempts before declaring unrecoverable. */
  readonly maxAttempts: number;
}

export function defaultResumePolicy(): ResumePolicy {
  return {
    hardMaxThinkingMs: PRO_THINKING_HARD_MAX_MS,
    thinkingMinBackgroundMs: PRO_THINKING_MIN_BACKGROUND_MS,
    maxAttempts: 6,
  };
}

const NEVER_CLICK_ANSWER_NOW = "AGENTS.md: never click Answer now; wait for the real Pro response.";

/**
 * Decide what a caller should do with a persisted snapshot. Pure — the
 * caller passes `now` so decisions are deterministic across processes.
 *
 * Decision rules (never returns "success" while assistant might still
 * be thinking; never advises clicking Answer now):
 *
 *   * `state === "completed"` → `complete`.
 *   * `state === "failed_terminal"` → `unrecoverable` with retry_safe=false.
 *   * `state === "failed_retryable"` → `resumable_attempt` with retry_safe=true.
 *   * `state === "thinking" | "background"` AND elapsed < hardMax →
 *     `resumable_background` with `oracle session <id>` recover.
 *   * `state === "thinking" | "background"` AND elapsed >= hardMax →
 *     `unrecoverable` (Pro thinking exceeded AGENTS.md budget; user
 *     must inspect the session manually).
 *   * `state === "reconnecting"` AND attempts >= maxAttempts →
 *     `unrecoverable`; else `resumable_attempt`.
 */
export function decideResume(
  snapshot: LongRunStateSnapshot,
  now: number,
  policy: ResumePolicy = defaultResumePolicy(),
): ResumeDecision {
  const elapsed = Math.max(0, now - snapshot.started_at_ms);
  const recover = snapshot.recover_command;

  if (snapshot.state === "completed") {
    return {
      kind: "complete",
      reason: "run already produced a result",
      next_command: recover,
      fix_command: null,
      retry_safe: true,
      error_code: null,
      user_visible_message: `Run ${snapshot.run_id} completed; replay with \`${recover} --render\`.`,
    };
  }

  if (snapshot.state === "failed_terminal") {
    return {
      kind: "unrecoverable",
      reason: "failure marked non-retryable",
      next_command: recover,
      fix_command: null,
      retry_safe: false,
      error_code: "output_capture_unverified",
      user_visible_message: `Run ${snapshot.run_id} ended without a usable result; inspect the session.`,
    };
  }

  if (snapshot.state === "failed_retryable") {
    return {
      kind: "resumable_attempt",
      reason: "retryable failure — caller may re-execute the same provider slot",
      next_command: recover,
      fix_command: null,
      retry_safe: true,
      error_code: null,
      user_visible_message: `Run ${snapshot.run_id} hit a retryable failure; retry safely.`,
    };
  }

  if (snapshot.state === "reconnecting") {
    if (snapshot.attempts >= policy.maxAttempts) {
      return {
        kind: "unrecoverable",
        reason: `reconnect attempts (${snapshot.attempts}) exhausted`,
        next_command: recover,
        fix_command: null,
        retry_safe: false,
        error_code: "remote_browser_unavailable",
        user_visible_message: `Run ${snapshot.run_id} could not reattach after ${snapshot.attempts} attempts.`,
      };
    }
    return {
      kind: "resumable_attempt",
      reason: "reconnect budget remains; safe to re-execute",
      next_command: recover,
      fix_command: null,
      retry_safe: true,
      error_code: null,
      user_visible_message: `Run ${snapshot.run_id} is reconnecting; ${recover} will resume.`,
    };
  }

  // thinking | background
  if (elapsed >= policy.hardMaxThinkingMs) {
    return {
      kind: "unrecoverable",
      reason: `wall time ${Math.round(elapsed / 1000)}s exceeds AGENTS.md Pro budget (${Math.round(policy.hardMaxThinkingMs / 1000)}s); manual inspection required`,
      next_command: recover,
      fix_command: null,
      retry_safe: false,
      error_code: "ui_drift_suspected",
      user_visible_message: `Run ${snapshot.run_id} has exceeded the 1h Pro thinking budget; inspect manually via \`${recover}\`.`,
    };
  }

  const within10mEarlySignal = elapsed < policy.thinkingMinBackgroundMs;
  return {
    kind: "resumable_background",
    reason: within10mEarlySignal
      ? "early in the Pro thinking window; background and reattach"
      : `Pro thinking window active (~${Math.round(elapsed / 60_000)}m elapsed); background and reattach`,
    next_command: recover,
    fix_command: null,
    retry_safe: true,
    error_code: null,
    user_visible_message: `Pro is still thinking on run ${snapshot.run_id}. ${NEVER_CLICK_ANSWER_NOW} Reattach via \`${recover}\`.`,
  };
}

// ─── Recovery envelope ───────────────────────────────────────────────────────

/**
 * Build a v18 `json_envelope.v1` recovery envelope from a snapshot +
 * decision. `complete` / `resumable_background` / `resumable_attempt`
 * emit success envelopes (`ok: true`) with `next_command` set so the
 * caller can chain into `oracle session <id>`; `unrecoverable` emits
 * a failure envelope with the matching v18 error code.
 *
 * Every envelope carries `next_command`, `fix_command`, and
 * `retry_safe` — the bead's "include …" requirement.
 */
export function buildRecoveryEnvelope(
  snapshot: LongRunStateSnapshot,
  decision: ResumeDecision,
): JsonEnvelope {
  const meta = {
    bundle_version: V18_BUNDLE_VERSION,
    schema_version: LONG_RUN_STATE_SCHEMA_VERSION,
    session_id: snapshot.session_id,
    run_id: snapshot.run_id,
    provider_slot: snapshot.provider_slot,
    observed_reasoning_effort_label: snapshot.observed_reasoning_effort_label,
    resume_kind: decision.kind,
  } as const;
  const commands = {
    session: snapshot.recover_command,
    capabilities: "oracle capabilities --json",
    remote_doctor: "oracle remote doctor --json",
  } as const;

  if (decision.kind === "unrecoverable") {
    const errorEntry: V18ErrorEntry = {
      error_code: decision.error_code ?? "ui_drift_suspected",
      message: decision.reason,
    };
    return createErrorEnvelope({
      errors: [errorEntry],
      meta,
      next_command: decision.next_command,
      fix_command: decision.fix_command,
      retry_safe: decision.retry_safe,
      blocked_reason: decision.reason,
      data: {
        snapshot: snapshot as unknown as Record<string, unknown>,
        decision: decision as unknown as Record<string, unknown>,
        user_visible_message: decision.user_visible_message,
      },
      commands,
    });
  }

  return createEnvelope({
    ok: true,
    data: {
      snapshot: snapshot as unknown as Record<string, unknown>,
      decision: decision as unknown as Record<string, unknown>,
      user_visible_message: decision.user_visible_message,
    } as unknown as Record<string, unknown>,
    meta,
    next_command: decision.next_command,
    fix_command: decision.fix_command,
    retry_safe: decision.retry_safe,
    commands,
  });
}

/**
 * Hard invariant for AGENTS.md: no recovery surface may suggest
 * clicking the "Answer now" placeholder. Throws if the user-visible
 * message or next/fix command ever references it.
 */
export function assertNoAnswerNowSuggestion(envelope: JsonEnvelope): void {
  const serialized = JSON.stringify(envelope).toLowerCase();
  if (serialized.includes("answer now")) {
    // The literal phrase "AGENTS.md: never click Answer now …" is fine;
    // it's an instruction NOT to click. Reject only suggestions that
    // omit the negation.
    if (!/never\s+click\s+answer\s+now/.test(serialized)) {
      throw new Error("recovery envelope contains an Answer-now suggestion (AGENTS.md violation)");
    }
  }
}
