// Remote-browser heartbeat metadata.
//
// `src/heartbeat.ts` already provides a generic timer loop. This module
// adds the remote-specific *message shape* and a sanitizer that guards
// against accidentally logging reasoning text from a long Pro run. The
// emitted JSON is the only signal an outer agent / CI sees during a 10m–1h
// Pro thinking window, so it must:
//
//   * include enough metadata to drive `oracle session <id>` reattach,
//   * use a stable schema so robot callers can parse it,
//   * NEVER contain assistant_text / response_text / thinking_text /
//     raw_output bytes — Pro reasoning is sensitive and the bead's
//     no-reasoning-text-logging rule is hard.
//
// We reuse the forbidden-key policy from `src/oracle/v18/evidence.ts`
// (FORBIDDEN_KEY_TEST) so heartbeat sanitization stays aligned with the
// evidence-redaction policy a downstream auditor expects.

import { FORBIDDEN_KEY_TEST } from "../oracle/v18/index.js";
import type { ReconnectDecision, RemoteRunState } from "./reconnect.js";

export const REMOTE_HEARTBEAT_SCHEMA_VERSION = "remote_heartbeat.v1" as const;

export type RemoteHeartbeatState =
  | "running"
  | "thinking"
  | "reconnecting"
  | "background"
  | "complete";

export interface RemoteHeartbeat {
  readonly schema_version: typeof REMOTE_HEARTBEAT_SCHEMA_VERSION;
  readonly emitted_at: string;
  readonly session_id: string;
  readonly elapsed_ms: number;
  readonly state: RemoteHeartbeatState;
  readonly attempt: number;
  /** Hint to the outer loop about when to check in next (ms). */
  readonly next_check_in_ms: number | null;
  readonly blocked_reason: string | null;
  /**
   * `oracle session <id>` style command the caller can hand to a user
   * when the run goes background. Null while the run is healthy.
   */
  readonly recover_command: string | null;
  /**
   * Optional non-sensitive metadata — picker labels, attempt counts,
   * etc. NEVER reasoning text. Use `sanitizeHeartbeatExtra` before
   * setting this field on a heartbeat constructed by hand.
   */
  readonly extra?: Record<string, unknown>;
}

export interface BuildHeartbeatInput {
  readonly state: RemoteRunState;
  readonly decision: ReconnectDecision;
  readonly now: number;
  readonly extra?: Record<string, unknown>;
}

function heartbeatStateFromDecision(
  state: RemoteRunState,
  decision: ReconnectDecision,
): RemoteHeartbeatState {
  switch (decision.kind) {
    case "complete":
      return "complete";
    case "background":
      return "background";
    case "reattach":
      return "reconnecting";
    case "give_up":
      return "background";
    case "wait":
    default:
      return state.thinking ? "thinking" : "running";
  }
}

function decisionRecoveryFields(decision: ReconnectDecision): {
  blocked_reason: string | null;
  recover_command: string | null;
  next_check_in_ms: number | null;
} {
  switch (decision.kind) {
    case "background":
      return {
        blocked_reason: decision.reason,
        recover_command: decision.recoverCommand,
        next_check_in_ms: null,
      };
    case "reattach":
      return {
        blocked_reason: decision.reason,
        recover_command: null,
        next_check_in_ms: decision.delayMs,
      };
    case "wait":
      return {
        blocked_reason: null,
        recover_command: null,
        next_check_in_ms: decision.nextCheckInMs,
      };
    case "give_up":
      return {
        blocked_reason: decision.reason,
        recover_command: null,
        next_check_in_ms: null,
      };
    case "complete":
      return { blocked_reason: null, recover_command: null, next_check_in_ms: null };
  }
}

/** Walk a payload and strip any property whose key would leak reasoning text. */
export function sanitizeHeartbeatExtra(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((entry) => sanitizeHeartbeatExtra(entry));
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (FORBIDDEN_KEY_TEST(key)) {
        continue;
      }
      out[key] = sanitizeHeartbeatExtra(value);
    }
    return out;
  }
  return input;
}

/**
 * Build a `RemoteHeartbeat` payload from current state + the latest
 * reconnect decision. The result is JSON-safe and free of reasoning
 * text: `state.observedReasoningLabel` is a model-picker label
 * (e.g. "Pro", "Heavy") which is metadata, not generated content.
 */
export function buildHeartbeat(input: BuildHeartbeatInput): RemoteHeartbeat {
  const recovery = decisionRecoveryFields(input.decision);
  const heartbeat: RemoteHeartbeat = {
    schema_version: REMOTE_HEARTBEAT_SCHEMA_VERSION,
    emitted_at: new Date(input.now).toISOString(),
    session_id: input.state.sessionId,
    elapsed_ms: Math.max(0, input.now - input.state.startedAtMs),
    state: heartbeatStateFromDecision(input.state, input.decision),
    attempt: input.state.attempts,
    next_check_in_ms: recovery.next_check_in_ms,
    blocked_reason: recovery.blocked_reason,
    recover_command: recovery.recover_command,
  };
  if (input.extra !== undefined) {
    const sanitized = sanitizeHeartbeatExtra(input.extra);
    if (sanitized && typeof sanitized === "object" && Object.keys(sanitized).length > 0) {
      return { ...heartbeat, extra: sanitized as Record<string, unknown> };
    }
  }
  // Fold observed picker label in as metadata when present — purely a label.
  if (input.state.observedReasoningLabel) {
    return {
      ...heartbeat,
      extra: { observed_reasoning_effort_label: input.state.observedReasoningLabel },
    };
  }
  return heartbeat;
}

/**
 * Serialize a heartbeat as a single line of JSON suitable for streaming
 * over the existing remote `runs` SSE / NDJSON channel.
 */
export function heartbeatToLogLine(heartbeat: RemoteHeartbeat): string {
  return JSON.stringify(heartbeat);
}
