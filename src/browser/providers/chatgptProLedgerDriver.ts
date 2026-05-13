// Thin driver that wires the ChatGPT Pro FSM (oracle-php) to the
// append-only evidence ledger (oracle-jfq sub-piece 1). Each milestone
// transition produces one ledger entry; absorbing failures produce a
// `run_failed` entry tagged with the matching V18ErrorCode.
//
// The driver is purely additive — it never mutates the FSM (still
// pure) and never mutates the ledger module (still pure). It owns the
// mapping table between FSM states and ledger event types.

import { appendEvidenceLedgerEvent } from "../../oracle/evidence_ledger.js";
import {
  errorCodeForFailure,
  isFailureState,
  isSuccessState,
} from "../state/chatgptPro.js";
import type {
  ChatGptProEvent,
  ChatGptProLegalState,
  ChatGptProMachine,
  ChatGptProState,
} from "../state/chatgptPro.js";
import type { EvidenceLedgerEventType } from "../../oracle/evidence_ledger.js";

/**
 * FSM states that map directly to a documented ledger event type.
 * Intermediate states (session_start, chatgpt_model_menu_open,
 * pro_candidate_selected, extended_reasoning_candidate_selected,
 * response_waiting) intentionally do NOT emit ledger entries — the
 * ledger is for milestones, not every micro-transition.
 */
const STATE_TO_LEDGER_EVENT: Partial<
  Record<ChatGptProLegalState, EvidenceLedgerEventType>
> = {
  remote_or_local_browser_connected: "browser_attached",
  login_verified: "login_verified",
  mode_verified_same_session: "mode_verified_same_session",
  prompt_submitted: "prompt_submitted",
  output_captured: "response_arrived",
  evidence_written: "evidence_written",
  success: "run_completed",
};

export interface ChatGptProLedgerDriverOptions {
  readonly sessionId: string;
  readonly homeDir?: string;
  /** Provider slot to attach to every ledger entry. */
  readonly providerSlot?: string;
  /** Evidence id to attach to evidence_written / run_completed entries. */
  readonly evidenceId?: string;
  /** Override clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface DriverAppendResult {
  readonly eventType: EvidenceLedgerEventType | null;
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

export interface ChatGptProLedgerDriver {
  /** Current FSM machine (immutable; updated via send). */
  readonly machine: ChatGptProMachine;
  /** Last FSM state observed by the driver. */
  readonly previousState: ChatGptProState;
  /**
   * Send an event to the FSM AND, when the transition crosses a
   * milestone, append a ledger entry. Returns the new driver instance
   * + the append result so callers can inspect what was recorded.
   */
  sendWithLedger(event: ChatGptProEvent): Promise<{
    driver: ChatGptProLedgerDriver;
    appended: DriverAppendResult;
  }>;
}

/**
 * Build a fresh driver around an existing FSM machine. The driver
 * appends a `session_started` ledger entry immediately; subsequent
 * milestone transitions emit further entries via sendWithLedger.
 */
export async function startChatGptProLedger(
  machine: ChatGptProMachine,
  options: ChatGptProLedgerDriverOptions,
): Promise<ChatGptProLedgerDriver> {
  await appendEvidenceLedgerEvent(
    options.sessionId,
    {
      type: "session_started",
      provider_slot: options.providerSlot,
      timestamp: options.now?.().toISOString(),
      metadata: { fsm_state: machine.state },
    },
    { homeDir: options.homeDir, now: options.now },
  );
  return makeDriver(machine, machine.state, options);
}

function makeDriver(
  machine: ChatGptProMachine,
  previousState: ChatGptProState,
  options: ChatGptProLedgerDriverOptions,
): ChatGptProLedgerDriver {
  return {
    machine,
    previousState,
    async sendWithLedger(event) {
      const next = machine.send(event);
      const appended = await maybeAppendLedger({
        previous: previousState,
        next: next.state,
        machine: next,
        options,
      });
      return {
        driver: makeDriver(next, next.state, options),
        appended,
      };
    },
  };
}

interface MaybeAppendInput {
  readonly previous: ChatGptProState;
  readonly next: ChatGptProState;
  readonly machine: ChatGptProMachine;
  readonly options: ChatGptProLedgerDriverOptions;
}

async function maybeAppendLedger(input: MaybeAppendInput): Promise<DriverAppendResult> {
  if (input.previous === input.next) {
    return { eventType: null, skipped: true, skipReason: "noop transition" };
  }

  if (isFailureState(input.next)) {
    const code = errorCodeForFailure(input.next);
    await appendEvidenceLedgerEvent(
      input.options.sessionId,
      {
        type: "run_failed",
        provider_slot: input.options.providerSlot,
        timestamp: input.options.now?.().toISOString(),
        metadata: {
          fsm_state: input.next,
          previous_state: input.previous,
          error_code: code,
          failure_reason: input.machine.context.failureReason,
        },
      },
      { homeDir: input.options.homeDir, now: input.options.now },
    );
    return { eventType: "run_failed", skipped: false, skipReason: null };
  }

  if (isSuccessState(input.next)) {
    await appendEvidenceLedgerEvent(
      input.options.sessionId,
      {
        type: "run_completed",
        provider_slot: input.options.providerSlot,
        evidence_id: input.machine.context.evidenceId ?? input.options.evidenceId,
        timestamp: input.options.now?.().toISOString(),
        metadata: {
          fsm_state: input.next,
          model_label: input.machine.context.modelLabel,
          effort_tier: input.machine.context.effort?.tier ?? null,
        },
      },
      { homeDir: input.options.homeDir, now: input.options.now },
    );
    return { eventType: "run_completed", skipped: false, skipReason: null };
  }

  const eventType = STATE_TO_LEDGER_EVENT[input.next as ChatGptProLegalState];
  if (!eventType) {
    return { eventType: null, skipped: true, skipReason: "intermediate state" };
  }

  await appendEvidenceLedgerEvent(
    input.options.sessionId,
    {
      type: eventType,
      provider_slot: input.options.providerSlot,
      evidence_id:
        eventType === "evidence_written"
          ? input.machine.context.evidenceId ?? input.options.evidenceId
          : undefined,
      timestamp: input.options.now?.().toISOString(),
      metadata: buildLedgerMetadata(eventType, input),
    },
    { homeDir: input.options.homeDir, now: input.options.now },
  );
  return { eventType, skipped: false, skipReason: null };
}

function buildLedgerMetadata(
  eventType: EvidenceLedgerEventType,
  input: MaybeAppendInput,
): Record<string, unknown> {
  const ctx = input.machine.context;
  switch (eventType) {
    case "browser_attached":
      return { mode: ctx.mode };
    case "mode_verified_same_session":
      return {
        session_id_hash: ctx.sessionIdHash,
        model_label: ctx.modelLabel,
        effort_tier: ctx.effort?.tier ?? null,
        effort_selected: ctx.effort?.selected ?? null,
      };
    case "prompt_submitted":
      return { prompt_sha256: ctx.promptSha256 };
    case "response_arrived":
      return {
        output_text_sha256: ctx.outputTextSha256,
        output_bytes: ctx.outputBytes,
      };
    case "evidence_written":
      return { evidence_id: ctx.evidenceId };
    case "login_verified":
      return {};
    default:
      return {};
  }
}
