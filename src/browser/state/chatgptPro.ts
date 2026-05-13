// ChatGPT Pro same-session verification state machine (oracle-php).
//
// The state machine enforces the v18 invariant that the ChatGPT Pro
// browser flow MUST verify mode + reasoning effort in the same session
// BEFORE submitting a prompt. Any attempt to submit while the machine
// is in an earlier state returns the
// `prompt_submitted_before_verification` v18 error code rather than
// silently letting the prompt go through.
//
// The FSM is a pure function: it consumes typed events and produces
// the next state plus an updated context. The browser driver wires the
// FSM to real DOM probes; tests drive it directly with synthetic
// events.
//
// State precedence (legal forward flow):
//
//   session_start
//   → remote_or_local_browser_connected
//   → login_verified
//   → chatgpt_model_menu_open
//   → pro_candidate_selected
//   → extended_reasoning_candidate_selected
//   → mode_verified_same_session
//   → prompt_submitted
//   → response_waiting
//   → reattach_pending (recoverable side path when CDP drops mid-run)
//   → output_captured
//   → evidence_written
//   → success
//
// Any of the listed terminal failure states are absorbing — no event
// can transition out of them, callers must build a fresh machine.

import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";
import {
  SELECTOR_MANIFEST_VERSION,
  pickHighestVisibleEffort,
  type EffortStrategyResult,
} from "../selectors/chatgpt/index.js";

// ─── States ──────────────────────────────────────────────────────────────────

/** Legal forward states on the happy path. */
export const CHATGPT_PRO_LEGAL_STATES = [
  "session_start",
  "remote_or_local_browser_connected",
  "login_verified",
  "chatgpt_model_menu_open",
  "pro_candidate_selected",
  "extended_reasoning_candidate_selected",
  "mode_verified_same_session",
  "prompt_submitted",
  "response_waiting",
  "reattach_pending",
  "output_captured",
  "evidence_written",
  "success",
] as const;
export type ChatGptProLegalState = (typeof CHATGPT_PRO_LEGAL_STATES)[number];

/** Absorbing terminal failure states; each carries a v18 error code. */
export const CHATGPT_PRO_FAILURE_STATES = [
  "login_required",
  "pro_unverified",
  "extended_reasoning_unverified",
  "ui_drift_suspected",
  "usage_limit",
  "output_empty",
  "prompt_submitted_before_verification",
  "remote_browser_unavailable",
  "remote_browser_unavailable_mid_run",
] as const;
export type ChatGptProFailureState = (typeof CHATGPT_PRO_FAILURE_STATES)[number];

export type ChatGptProState = ChatGptProLegalState | ChatGptProFailureState;

const LEGAL_RANK: Record<ChatGptProLegalState, number> = (() => {
  const map = Object.create(null) as Record<ChatGptProLegalState, number>;
  CHATGPT_PRO_LEGAL_STATES.forEach((state, idx) => {
    map[state] = idx;
  });
  return map;
})();

const FAILURE_STATE_SET: ReadonlySet<string> = new Set(CHATGPT_PRO_FAILURE_STATES);

const FAILURE_ERROR_CODE: Record<ChatGptProFailureState, V18ErrorCode> = {
  login_required: "provider_login_required",
  pro_unverified: "chatgpt_pro_unverified",
  extended_reasoning_unverified: "chatgpt_extended_reasoning_unverified",
  ui_drift_suspected: "ui_drift_suspected",
  usage_limit: "provider_usage_limit",
  output_empty: "output_capture_empty",
  prompt_submitted_before_verification: "prompt_submitted_before_verification",
  remote_browser_unavailable: "remote_browser_unavailable",
  remote_browser_unavailable_mid_run: "remote_browser_unavailable",
};

export function isFailureState(state: ChatGptProState): state is ChatGptProFailureState {
  return FAILURE_STATE_SET.has(state);
}

export function errorCodeForFailure(state: ChatGptProFailureState): V18ErrorCode {
  return FAILURE_ERROR_CODE[state];
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type ChatGptProEvent =
  | { type: "browser_connected"; mode: "remote" | "local" }
  | { type: "browser_connect_failed"; reason?: string }
  | { type: "login_verified" }
  | { type: "login_required" }
  | { type: "model_menu_opened" }
  | { type: "pro_candidate_selected"; modelLabel: string }
  | {
      type: "effort_candidate_selected";
      /** Labels visible in the effort picker, verbatim. */
      observedEffortLabels: readonly string[];
    }
  | { type: "mode_verified_same_session"; sessionIdHash: `sha256:${string}` }
  | { type: "usage_limit_observed" }
  | { type: "ui_drift_observed"; detail?: string }
  | { type: "session_lost"; reason?: string; recoveryCommand?: string | null }
  | { type: "reattach_succeeded"; sessionIdHash?: `sha256:${string}` }
  | { type: "reattach_budget_exhausted"; reason?: string }
  | { type: "submit_prompt"; promptSha256: `sha256:${string}` }
  | { type: "response_arrived"; outputTextSha256: `sha256:${string}`; bytesLength: number }
  | { type: "evidence_written"; evidenceId: string }
  | { type: "finish" };

// ─── Context ─────────────────────────────────────────────────────────────────

export interface ChatGptProContext {
  /** "remote" or "local" — populated after browser_connected. */
  readonly mode: "remote" | "local" | null;
  /** Selected Pro model label (verbatim). */
  readonly modelLabel: string | null;
  /** Result of the highest-visible effort strategy at the moment of selection. */
  readonly effort: EffortStrategyResult | null;
  /** Same-session id hash captured at mode verification. */
  readonly sessionIdHash: `sha256:${string}` | null;
  /** Sha256 of the submitted prompt bytes. */
  readonly promptSha256: `sha256:${string}` | null;
  /** Sha256 of the captured output. */
  readonly outputTextSha256: `sha256:${string}` | null;
  /** Output byte length when known. */
  readonly outputBytes: number | null;
  /** Evidence id written to disk. */
  readonly evidenceId: string | null;
  /** Recovery command surfaced while CDP/browser reattach is pending. */
  readonly reattachRecoveryCommand: string | null;
  /** Legal state interrupted by a recoverable CDP/browser disconnect. */
  readonly stateBeforeReattach: ChatGptProLegalState | null;
  /** Manifest version used for verification — pinned at FSM construction time. */
  readonly selectorManifestVersion: typeof SELECTOR_MANIFEST_VERSION;
  /** Free-form reason for transitioning into a failure state. */
  readonly failureReason: string | null;
}

const EMPTY_CONTEXT: ChatGptProContext = Object.freeze({
  mode: null,
  modelLabel: null,
  effort: null,
  sessionIdHash: null,
  promptSha256: null,
  outputTextSha256: null,
  outputBytes: null,
  evidenceId: null,
  reattachRecoveryCommand: null,
  stateBeforeReattach: null,
  selectorManifestVersion: SELECTOR_MANIFEST_VERSION,
  failureReason: null,
});

// ─── Machine ─────────────────────────────────────────────────────────────────

export interface ChatGptProMachine {
  readonly state: ChatGptProState;
  readonly context: ChatGptProContext;
  /**
   * Apply an event and return a new machine. Throws when the requested
   * transition violates an absorbing-failure invariant; otherwise
   * transitions to either the next legal state or to the appropriate
   * failure state with the error code attached to context.
   */
  send(event: ChatGptProEvent): ChatGptProMachine;
}

export function createChatGptProMachine(): ChatGptProMachine {
  return makeMachine("session_start", EMPTY_CONTEXT);
}

function makeMachine(state: ChatGptProState, context: ChatGptProContext): ChatGptProMachine {
  return {
    state,
    context,
    send(event) {
      const next = transition(state, context, event);
      return makeMachine(next.state, next.context);
    },
  };
}

/**
 * Pure transition function. Exposed for tests and the dry-run /
 * capabilities probe path that wants to reason about the FSM without
 * an actual browser attached.
 */
export function transition(
  state: ChatGptProState,
  context: ChatGptProContext,
  event: ChatGptProEvent,
): { state: ChatGptProState; context: ChatGptProContext } {
  // Absorbing failures: do nothing. Callers must build a new machine.
  if (isFailureState(state)) return { state, context };

  // Hard guard: submit_prompt is only legal AFTER mode_verified_same_session.
  if (event.type === "submit_prompt" && !modeAndEffortVerified(state, context)) {
    return {
      state: "prompt_submitted_before_verification",
      context: {
        ...context,
        failureReason: `submit_prompt rejected: machine is in state "${state}" before mode_verified_same_session.`,
      },
    };
  }

  switch (event.type) {
    case "browser_connect_failed":
      return failureFrom(context, "remote_browser_unavailable", event.reason);

    case "browser_connected":
      if (state !== "session_start") return noop(state, context);
      return advance(context, "remote_or_local_browser_connected", { mode: event.mode });

    case "login_required":
      return failureFrom(context, "login_required", "ChatGPT login required");

    case "login_verified":
      if (state !== "remote_or_local_browser_connected") return noop(state, context);
      return advance(context, "login_verified");

    case "model_menu_opened":
      if (state !== "login_verified") return noop(state, context);
      return advance(context, "chatgpt_model_menu_open");

    case "pro_candidate_selected":
      if (state !== "chatgpt_model_menu_open") return noop(state, context);
      if (!isProLabel(event.modelLabel)) {
        return failureFrom(
          context,
          "pro_unverified",
          `model label "${event.modelLabel}" is not a recognised Pro candidate`,
        );
      }
      return advance(context, "pro_candidate_selected", { modelLabel: event.modelLabel });

    case "effort_candidate_selected": {
      if (state !== "pro_candidate_selected") return noop(state, context);
      const verdict = pickHighestVisibleEffort({
        observedLabels: event.observedEffortLabels,
      });
      const ctxWithEffort: ChatGptProContext = { ...context, effort: verdict };
      if (verdict.status === "verified") {
        return { state: "extended_reasoning_candidate_selected", context: ctxWithEffort };
      }
      // Effort verdict failures are typed by the effort strategy.
      if (verdict.status === "ui_drift_suspected") {
        return failureFrom(ctxWithEffort, "ui_drift_suspected", verdict.reason);
      }
      // status === "unverified" → extended reasoning unverified.
      return failureFrom(
        ctxWithEffort,
        "extended_reasoning_unverified",
        verdict.reason,
      );
    }

    case "mode_verified_same_session":
      if (state !== "extended_reasoning_candidate_selected") return noop(state, context);
      return advance(context, "mode_verified_same_session", {
        sessionIdHash: event.sessionIdHash,
      });

    case "usage_limit_observed":
      return failureFrom(context, "usage_limit", "ChatGPT reported a usage limit");

    case "ui_drift_observed":
      return failureFrom(context, "ui_drift_suspected", event.detail ?? "ui drift observed");

    case "session_lost":
      if (!canEnterReattachPending(state)) return noop(state, context);
      return advance(context, "reattach_pending", {
        failureReason: formatReattachReason(event),
        reattachRecoveryCommand: event.recoveryCommand ?? null,
        stateBeforeReattach: state,
      });

    case "reattach_succeeded":
      if (state !== "reattach_pending") return noop(state, context);
      return advance(context, stateAfterReattach(context), {
        ...(event.sessionIdHash ? { sessionIdHash: event.sessionIdHash } : {}),
        failureReason: null,
        reattachRecoveryCommand: null,
        stateBeforeReattach: null,
      });

    case "reattach_budget_exhausted":
      if (state !== "reattach_pending") return noop(state, context);
      return failureFrom(
        context,
        "remote_browser_unavailable_mid_run",
        event.reason ?? context.failureReason ?? "CDP reattach budget exhausted",
      );

    case "submit_prompt":
      if (state !== "mode_verified_same_session") return noop(state, context);
      return advance(context, "prompt_submitted", { promptSha256: event.promptSha256 });

    case "response_arrived": {
      if (state !== "prompt_submitted" && state !== "response_waiting") {
        return noop(state, context);
      }
      if (event.bytesLength <= 0) {
        return failureFrom(
          context,
          "output_empty",
          `ChatGPT returned an empty response (${event.bytesLength} bytes)`,
        );
      }
      // Hop through response_waiting before output_captured so callers
      // that drive the FSM in two ticks (network ready vs payload ready)
      // get a clean intermediate state.
      const withWaiting: ChatGptProContext = {
        ...context,
        outputTextSha256: event.outputTextSha256,
        outputBytes: event.bytesLength,
      };
      if (state === "prompt_submitted") {
        // Allow same-event jump through response_waiting → output_captured.
        return { state: "output_captured", context: withWaiting };
      }
      return { state: "output_captured", context: withWaiting };
    }

    case "evidence_written":
      if (state !== "output_captured") {
        // The bead's acceptance: evidence-written-before-success
        // ordering must be preserved. If the caller attempts to mark
        // evidence written without having captured output first, this
        // becomes a UI-drift-shaped programming error rather than a
        // silent success.
        return failureFrom(
          context,
          "ui_drift_suspected",
          `evidence_written rejected: machine is in state "${state}", expected "output_captured" first`,
        );
      }
      return advance(context, "evidence_written", { evidenceId: event.evidenceId });

    case "finish":
      if (state !== "evidence_written") {
        return failureFrom(
          context,
          "ui_drift_suspected",
          `finish rejected: machine is in state "${state}", expected "evidence_written" first`,
        );
      }
      return advance(context, "success");
  }
}

function modeAndEffortVerified(state: ChatGptProState, context: ChatGptProContext): boolean {
  if (state !== "mode_verified_same_session") return false;
  if (context.effort?.status !== "verified") return false;
  if (!context.sessionIdHash) return false;
  return true;
}

function canEnterReattachPending(state: ChatGptProState): state is ChatGptProLegalState {
  return (
    state === "mode_verified_same_session" ||
    state === "prompt_submitted" ||
    state === "response_waiting" ||
    state === "output_captured" ||
    state === "evidence_written"
  );
}

function formatReattachReason(event: {
  readonly reason?: string;
  readonly recoveryCommand?: string | null;
}): string {
  const reason = event.reason ?? "CDP session lost during ChatGPT Pro run";
  return event.recoveryCommand ? `${reason}; recover with ${event.recoveryCommand}` : reason;
}

function stateAfterReattach(context: ChatGptProContext): ChatGptProLegalState {
  if (context.stateBeforeReattach === "mode_verified_same_session" && !context.promptSha256) {
    return "mode_verified_same_session";
  }
  return "response_waiting";
}

function advance(
  context: ChatGptProContext,
  next: ChatGptProLegalState,
  patch: Partial<ChatGptProContext> = {},
): { state: ChatGptProState; context: ChatGptProContext } {
  return { state: next, context: { ...context, ...patch } };
}

function failureFrom(
  context: ChatGptProContext,
  failure: ChatGptProFailureState,
  reason: string | undefined,
): { state: ChatGptProState; context: ChatGptProContext } {
  return {
    state: failure,
    context: {
      ...context,
      failureReason: reason ?? null,
    },
  };
}

function noop(
  state: ChatGptProState,
  context: ChatGptProContext,
): { state: ChatGptProState; context: ChatGptProContext } {
  // Ignore events that arrive out-of-order; the FSM does not advance
  // and does not fail. Callers can compare `state` before/after to
  // detect that the event was a no-op.
  return { state, context };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recognises ChatGPT Pro-class model labels. Used by the FSM to reject
 * non-Pro model selections in `pro_candidate_selected`. We tolerate the
 * label being a verbatim ChatGPT picker string ("GPT-5.5 Pro",
 * "ChatGPT Pro", "Pro") and reject anything that does not contain
 * "Pro" as a separate token.
 */
export function isProLabel(label: string): boolean {
  const normalized = label.trim().replace(/\s+/g, " ").toLowerCase();
  // Reject empty / structurally invalid labels.
  if (normalized.length === 0) return false;
  // Match "pro" as a separate word so we accept "GPT-5.5 Pro" and
  // reject "Project" / "Pro Extended" (which is a thinking-effort
  // label, not a model label).
  if (/\bpro\b/.test(normalized) && !/^pro extended$/.test(normalized)) {
    // Heuristic: avoid the effort label "Pro Extended" — that belongs
    // in the effort picker step, not the model picker.
    return true;
  }
  return false;
}

/**
 * Returns true when the machine has reached its happy-path terminal
 * state. Useful for `oracle remote doctor` / capabilities probes that
 * need to assert the full sequence succeeded.
 */
export function isSuccessState(state: ChatGptProState): boolean {
  return state === "success";
}

/** Numeric rank of a legal state for monitoring/dashboard rendering. */
export function legalStateRank(state: ChatGptProLegalState): number {
  return LEGAL_RANK[state];
}
