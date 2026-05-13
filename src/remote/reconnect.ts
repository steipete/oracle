// Remote-browser reconnect state machine.
//
// Long ChatGPT Pro thinking can outlive the local CDP/TCP attachment that
// dispatched the prompt. Per AGENTS.md we MUST wait 10m–1h for the real
// assistant turn and we MUST NOT click the "Answer now" placeholder. This
// module is the pure decision engine that drives reconnect attempts when
// the target navigates, the remote endpoint hiccups, or the local timeout
// trips while the assistant is still thinking — without ever performing
// I/O or clicking anything. Callers feed it events; it returns the next
// action (reattach, wait, hand-off to `oracle session <id>`, give up).
//
// Bead alignment (oracle-nyn): timeout-with-reattach, target lost +
// recovered, heartbeat-driven progress, incomplete-run session
// reattachment, and v18 FM-002 / FM-006.

import type { V18ErrorCode } from "../oracle/v18/index.js";

export const RECONNECT_NEVER_CLICK_ANSWER_NOW = true as const;

export type ReconnectEvent =
  | { type: "target_lost"; at: number; reason?: string }
  | { type: "target_recovered"; at: number; reason?: string }
  | { type: "endpoint_lost"; at: number; reason?: string }
  | { type: "endpoint_recovered"; at: number; reason?: string }
  | { type: "prompt_thinking"; at: number; observedLabel?: string }
  | { type: "prompt_settled"; at: number }
  | { type: "heartbeat"; at: number }
  | { type: "local_timeout"; at: number; reason?: string }
  | { type: "result_received"; at: number };

export interface ReconnectPolicy {
  /** Maximum wall-clock window we will keep trying to recover (ms). */
  readonly maxTotalWaitMs: number;
  /** Maximum reattach attempts before handing off to background. */
  readonly maxAttempts: number;
  /** Backoff for the first reattach. Doubles on each subsequent attempt. */
  readonly initialBackoffMs: number;
  /** Upper bound on backoff so very long runs don't grow it unbounded. */
  readonly maxBackoffMs: number;
  /** Quiet window after a heartbeat before we treat the target as lost. */
  readonly heartbeatMissDeadlineMs: number;
}

/**
 * Defaults align with AGENTS.md: allow up to 1h of Pro thinking, never
 * click "Answer now", and back off so the remote endpoint isn't
 * hammered. After 4 attempts we hand off rather than spinning.
 */
export function defaultReconnectPolicy(): ReconnectPolicy {
  return {
    maxTotalWaitMs: 60 * 60 * 1000, // 1h
    maxAttempts: 4,
    initialBackoffMs: 30 * 1000, // 30s
    maxBackoffMs: 5 * 60 * 1000, // 5m cap
    heartbeatMissDeadlineMs: 90 * 1000, // 90s
  };
}

export interface RemoteRunState {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly lastHeartbeatMs: number;
  readonly attempts: number;
  readonly targetLost: boolean;
  readonly endpointLost: boolean;
  readonly thinking: boolean;
  /** Most recently observed model-picker label, never the reasoning text. */
  readonly observedReasoningLabel: string | null;
  readonly completed: boolean;
}

export function initialRemoteRunState(input: {
  sessionId: string;
  startedAtMs: number;
}): RemoteRunState {
  return {
    sessionId: input.sessionId,
    startedAtMs: input.startedAtMs,
    lastHeartbeatMs: input.startedAtMs,
    attempts: 0,
    targetLost: false,
    endpointLost: false,
    thinking: false,
    observedReasoningLabel: null,
    completed: false,
  };
}

/**
 * Apply an event to the state, returning a new immutable state. Pure
 * function — no I/O, no clock reads. Callers supply timestamps via
 * `event.at` so tests can drive time deterministically.
 *
 * Reasoning text is never absorbed into the state — only the picker
 * label (e.g. "Heavy", "Pro") on `prompt_thinking` events. This keeps
 * the run log free of model output bytes, satisfying the bead's
 * "no reasoning-text logging" acceptance.
 */
export function applyReconnectEvent(
  state: RemoteRunState,
  event: ReconnectEvent,
): RemoteRunState {
  switch (event.type) {
    case "heartbeat":
      return { ...state, lastHeartbeatMs: event.at };
    case "target_lost":
      return { ...state, targetLost: true, lastHeartbeatMs: event.at };
    case "target_recovered":
      return {
        ...state,
        targetLost: false,
        attempts: state.attempts + 1,
        lastHeartbeatMs: event.at,
      };
    case "endpoint_lost":
      return { ...state, endpointLost: true, lastHeartbeatMs: event.at };
    case "endpoint_recovered":
      return {
        ...state,
        endpointLost: false,
        attempts: state.attempts + 1,
        lastHeartbeatMs: event.at,
      };
    case "prompt_thinking":
      return {
        ...state,
        thinking: true,
        lastHeartbeatMs: event.at,
        observedReasoningLabel: event.observedLabel ?? state.observedReasoningLabel,
      };
    case "prompt_settled":
      return { ...state, thinking: false, lastHeartbeatMs: event.at };
    case "local_timeout":
      // A local timeout does not flip lost/recovered; it just nudges the
      // state machine to reconsider whether we should background.
      return { ...state, lastHeartbeatMs: state.lastHeartbeatMs };
    case "result_received":
      return { ...state, completed: true, thinking: false, lastHeartbeatMs: event.at };
  }
}

export type ReconnectDecision =
  | {
      readonly kind: "reattach";
      readonly attempt: number;
      readonly delayMs: number;
      readonly reason: string;
      readonly errorCode: V18ErrorCode | null;
    }
  | {
      readonly kind: "wait";
      readonly nextCheckInMs: number;
      readonly reason: string;
    }
  | {
      readonly kind: "background";
      readonly sessionId: string;
      readonly recoverCommand: string;
      readonly reason: string;
      readonly errorCode: V18ErrorCode | null;
    }
  | {
      readonly kind: "give_up";
      readonly reason: string;
      readonly errorCode: V18ErrorCode | null;
    }
  | { readonly kind: "complete"; readonly reason: string };

function backoffFor(attempt: number, policy: ReconnectPolicy): number {
  // attempt is 1-based at call-time: first reattach uses initialBackoff.
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialBackoffMs * 2 ** exponent;
  return Math.min(policy.maxBackoffMs, raw);
}

function recoverCommandFor(sessionId: string): string {
  return `oracle session ${sessionId}`;
}

/**
 * Pick the next action given the current state. Decision rules:
 *
 *   1. If the run already finished, emit `complete`.
 *   2. If we are over `maxTotalWaitMs`, return `background` with the
 *      `oracle session <id>` recovery command so the caller hands off
 *      instead of returning false success.
 *   3. If endpoint or target is currently lost AND we still have
 *      attempts left, return `reattach` with exponential backoff.
 *   4. If endpoint/target is lost but attempts are exhausted, also
 *      return `background` — never `give_up` while the assistant may
 *      still be thinking server-side.
 *   5. If the assistant is still thinking and we are within budget,
 *      return `wait` with a short next-check window.
 *   6. Otherwise (no signal in `heartbeatMissDeadlineMs`), trigger a
 *      precautionary reattach.
 */
export function decideReconnect(
  state: RemoteRunState,
  now: number,
  policy: ReconnectPolicy = defaultReconnectPolicy(),
): ReconnectDecision {
  if (state.completed) {
    return { kind: "complete", reason: "result already received" };
  }

  const elapsed = now - state.startedAtMs;
  if (elapsed > policy.maxTotalWaitMs) {
    return {
      kind: "background",
      sessionId: state.sessionId,
      recoverCommand: recoverCommandFor(state.sessionId),
      reason: `total wait ${Math.round(elapsed / 1000)}s exceeds policy budget`,
      errorCode: "ui_drift_suspected",
    };
  }

  const attemptsRemaining = policy.maxAttempts - state.attempts;
  const targetOrEndpointLost = state.targetLost || state.endpointLost;
  if (targetOrEndpointLost) {
    if (attemptsRemaining <= 0) {
      return {
        kind: "background",
        sessionId: state.sessionId,
        recoverCommand: recoverCommandFor(state.sessionId),
        reason: state.endpointLost
          ? "remote endpoint lost; max attempts reached, handing off to background"
          : "remote target lost; max attempts reached, handing off to background",
        errorCode: state.endpointLost ? "remote_browser_unavailable" : "ui_drift_suspected",
      };
    }
    const attempt = state.attempts + 1;
    return {
      kind: "reattach",
      attempt,
      delayMs: backoffFor(attempt, policy),
      reason: state.endpointLost
        ? `remote endpoint lost — reattach attempt ${attempt}/${policy.maxAttempts}`
        : `remote target lost — reattach attempt ${attempt}/${policy.maxAttempts}`,
      errorCode: state.endpointLost ? "remote_browser_unavailable" : null,
    };
  }

  const sinceHeartbeat = now - state.lastHeartbeatMs;
  if (sinceHeartbeat > policy.heartbeatMissDeadlineMs) {
    if (attemptsRemaining <= 0) {
      return {
        kind: "background",
        sessionId: state.sessionId,
        recoverCommand: recoverCommandFor(state.sessionId),
        reason: `no heartbeat for ${Math.round(sinceHeartbeat / 1000)}s; max attempts reached`,
        errorCode: "output_capture_unverified",
      };
    }
    const attempt = state.attempts + 1;
    return {
      kind: "reattach",
      attempt,
      delayMs: backoffFor(attempt, policy),
      reason: `no heartbeat for ${Math.round(sinceHeartbeat / 1000)}s; precautionary reattach ${attempt}/${policy.maxAttempts}`,
      errorCode: null,
    };
  }

  if (state.thinking) {
    return {
      kind: "wait",
      nextCheckInMs: policy.heartbeatMissDeadlineMs,
      reason: "assistant still thinking; holding for Pro completion",
    };
  }

  return {
    kind: "wait",
    nextCheckInMs: policy.heartbeatMissDeadlineMs,
    reason: "waiting for next heartbeat",
  };
}

/**
 * Convenience: build the canonical hand-off payload Oracle's CLI/MCP
 * surfaces emit when a remote run is incomplete but the assistant may
 * still be thinking. Mirrors `oracle status` lineage hints.
 */
export interface RemoteHandoff {
  readonly sessionId: string;
  readonly recoverCommand: string;
  readonly reason: string;
  readonly errorCode: V18ErrorCode | null;
}

export function buildRemoteHandoff(state: RemoteRunState, reason: string, errorCode: V18ErrorCode | null = null): RemoteHandoff {
  return {
    sessionId: state.sessionId,
    recoverCommand: recoverCommandFor(state.sessionId),
    reason,
    errorCode,
  };
}
