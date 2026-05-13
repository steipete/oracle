// Thin wrapper that wires the ChatGPT Pro verification state machine
// into the browser provider surface. Keeping this here (rather than
// inside chatgptDomProvider.ts) preserves the boundary between the
// provider's runtime entry points and the v18 verification FSM.
//
// Consumers:
//   - oracle-bag (ChatGPT Pro formal-plan + synthesis routes) drives
//     the machine through its DOM probes.
//   - oracle-6ll (CLI doctor/lease wiring) reads the machine state to
//     decide whether to emit a verified-or-blocked envelope.

import {
  errorCodeForFailure,
  isFailureState,
  isSuccessState,
  type ChatGptProEvent,
  type ChatGptProMachine,
  type ChatGptProState,
} from "../state/chatgptPro.js";
import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";

export type {
  ChatGptProContext,
  ChatGptProEvent,
  ChatGptProFailureState,
  ChatGptProLegalState,
  ChatGptProMachine,
  ChatGptProState,
} from "../state/chatgptPro.js";
export {
  CHATGPT_PRO_FAILURE_STATES,
  CHATGPT_PRO_LEGAL_STATES,
  createChatGptProMachine,
  errorCodeForFailure,
  isFailureState,
  isProLabel,
  isSuccessState,
  legalStateRank,
  transition,
} from "../state/chatgptPro.js";

/**
 * Drive a machine through a sequence of events. The reducer short-
 * circuits on the first failure state — once an absorbing failure is
 * reached, remaining events are not applied so the resulting machine
 * preserves the original failure reason.
 */
export function applyChatGptProEvents(
  machine: ChatGptProMachine,
  events: readonly ChatGptProEvent[],
): ChatGptProMachine {
  let current = machine;
  for (const event of events) {
    current = current.send(event);
    if (isFailureState(current.state)) break;
  }
  return current;
}

/**
 * Convenience verdict object for emitting json_envelope.v1 results.
 * The caller still has to wrap this in an envelope; this helper just
 * surfaces the (verified | failureCode) summary.
 */
export interface ChatGptProVerdict {
  state: ChatGptProState;
  verified: boolean;
  errorCode: V18ErrorCode | null;
  failureReason: string | null;
  evidenceId: string | null;
}

export function machineVerdict(machine: ChatGptProMachine): ChatGptProVerdict {
  const verified = isSuccessState(machine.state);
  return {
    state: machine.state,
    verified,
    errorCode: isFailureState(machine.state) ? errorCodeForFailure(machine.state) : null,
    failureReason: machine.context.failureReason,
    evidenceId: machine.context.evidenceId,
  };
}
