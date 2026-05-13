import type { CaptureVerdict } from "../output-capture/captureVerdict.js";
import type { ProLongWaitDecision } from "../output-capture/proLongWait.js";
import type { ChatGptProEvent, ChatGptProMachine } from "../state/chatgptPro.js";

/**
 * Convert a recoverable output-capture reattach verdict into the FSM event that
 * parks the run in reattach_pending. Non-reattach verdicts are intentionally
 * ignored by this adapter.
 */
export function sessionLostEventFromCaptureVerdict(
  verdict: CaptureVerdict,
): ChatGptProEvent | null {
  if (verdict.status !== "needs_reattach") return null;
  return {
    type: "session_lost",
    reason: verdict.reason,
    recoveryCommand: verdict.recoveryCommand,
  };
}

/**
 * Wire proLongWait's budget-exhausted needs_reattach decision into the ChatGPT
 * Pro FSM without making the long-wait scheduler depend on FSM internals.
 */
export function sessionLostEventFromProLongWaitDecision(
  decision: ProLongWaitDecision,
): ChatGptProEvent | null {
  if (decision.kind !== "reattach") return null;
  return sessionLostEventFromCaptureVerdict(decision.verdict);
}

export function applyCdpDisconnectDecision(
  machine: ChatGptProMachine,
  decision: ProLongWaitDecision,
): ChatGptProMachine {
  const event = sessionLostEventFromProLongWaitDecision(decision);
  return event ? machine.send(event) : machine;
}

export function reattachBudgetExhaustedEvent(reason?: string): ChatGptProEvent {
  return reason
    ? { type: "reattach_budget_exhausted", reason }
    : { type: "reattach_budget_exhausted" };
}
