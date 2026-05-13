// ChatGPT Pro–specific recovery layer for long Pro thinking runs.
//
// Specializes the generic `src/remote/long_run_state.ts` substrate
// with ChatGPT-Pro conventions:
//
//   * AGENTS.md says Pro thinking can take 10m–1h and we MUST NOT
//     click the "Answer now" placeholder. The recovery envelope here
//     surfaces that policy in `user_visible_message` and runs the
//     hard `assertNoAnswerNowSuggestion` invariant.
//   * ChatGPT conversations carry a `/c/<conversation_id>` URL when
//     the user navigates back; we record that as an optional
//     `conversation_url_hint` so the reattach surface can resume in
//     the same tab.
//   * "background" + "thinking" snapshots produce the canonical
//     `oracle session <id>` recover_command — the same hand-off used
//     by `src/remote/reconnect.ts` so a robot caller sees one shape.
//
// Read-only on `src/remote/reconnect.ts` and
// `src/browser/providers/chatgptDomProvider.ts` per the bead's domain
// rules; this module composes their types but never modifies them.

import type { RemoteRunState } from "../../remote/reconnect.js";
import {
  PRO_THINKING_HARD_MAX_MS,
  PRO_THINKING_MIN_BACKGROUND_MS,
  assertNoAnswerNowSuggestion,
  buildRecoveryEnvelope,
  decideResume,
  defaultResumePolicy,
  snapshotRunState,
  type LongRunObservedState,
  type LongRunStateSnapshot,
  type ResumeDecision,
  type ResumePolicy,
} from "../../remote/long_run_state.js";
import type { JsonEnvelope } from "../../oracle/v18/contracts.js";

export const CHATGPT_PRO_PROVIDER_SLOTS = [
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
] as const;
export type ChatgptProSlot = (typeof CHATGPT_PRO_PROVIDER_SLOTS)[number];

const CHATGPT_PRO_SLOT_SET: ReadonlySet<string> = new Set(CHATGPT_PRO_PROVIDER_SLOTS);

export function isChatgptProSlot(slot: unknown): slot is ChatgptProSlot {
  return typeof slot === "string" && CHATGPT_PRO_SLOT_SET.has(slot);
}

const CONVERSATION_URL_PATTERN = /\/c\/[a-zA-Z0-9-]{6,}/;

/** Validate a ChatGPT `/c/<id>` URL hint. Returns the trimmed value or null. */
export function normalizeConversationUrlHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return CONVERSATION_URL_PATTERN.test(trimmed) ? trimmed : null;
}

export interface ChatgptProSnapshotInput {
  readonly session_id: string;
  readonly run_id: string;
  readonly provider_slot: ChatgptProSlot;
  readonly observed_state: LongRunObservedState;
  readonly remote: RemoteRunState;
  readonly evidence_id?: string | null;
  readonly conversation_url_hint?: string | null;
}

/**
 * Snapshot a ChatGPT Pro run with slot validation + URL-hint
 * normalization. Throws when the provider_slot is not one of the two
 * ChatGPT Pro slots — keeps this layer honest about its scope.
 */
export function snapshotChatgptProRun(input: ChatgptProSnapshotInput): LongRunStateSnapshot {
  if (!isChatgptProSlot(input.provider_slot)) {
    throw new Error(
      `chatgptPro_recovery.snapshotChatgptProRun: provider_slot must be one of ${CHATGPT_PRO_PROVIDER_SLOTS.join(", ")}, got "${String(input.provider_slot)}"`,
    );
  }
  const conversation_url_hint = normalizeConversationUrlHint(input.conversation_url_hint);
  return snapshotRunState({
    session_id: input.session_id,
    provider_slot: input.provider_slot,
    run_id: input.run_id,
    observed_state: input.observed_state,
    remote: input.remote,
    evidence_id: input.evidence_id ?? null,
    conversation_url_hint,
  });
}

/**
 * Default policy for ChatGPT Pro: AGENTS.md 10m–1h thinking window.
 * Exposed as a function so tests can override with a tight policy.
 */
export function defaultChatgptProResumePolicy(): ResumePolicy {
  return {
    ...defaultResumePolicy(),
    hardMaxThinkingMs: PRO_THINKING_HARD_MAX_MS,
    thinkingMinBackgroundMs: PRO_THINKING_MIN_BACKGROUND_MS,
  };
}

/**
 * Compute the recovery decision for a ChatGPT Pro snapshot. Reuses the
 * generic decider but post-processes the user-visible message to call
 * out the AGENTS.md never-click-Answer-now invariant on every
 * resumable_background hand-off so the message itself can be shown
 * to a human without further interpolation.
 */
export function decideChatgptProResume(
  snapshot: LongRunStateSnapshot,
  now: number,
  policy: ResumePolicy = defaultChatgptProResumePolicy(),
): ResumeDecision {
  if (!isChatgptProSlot(snapshot.provider_slot)) {
    throw new Error(
      `chatgptPro_recovery.decideChatgptProResume: snapshot is for slot "${snapshot.provider_slot}", not a ChatGPT Pro slot`,
    );
  }
  const decision = decideResume(snapshot, now, policy);
  // The generic decider already includes the AGENTS.md phrasing in
  // resumable_background messages. Belt-and-suspenders: for any
  // resumable kind, ensure the phrase is present so callers can copy
  // the message into a human-facing UI without losing the warning.
  if (
    decision.kind === "resumable_background" &&
    !/never\s+click\s+answer\s+now/i.test(decision.user_visible_message)
  ) {
    return {
      ...decision,
      user_visible_message: `${decision.user_visible_message} AGENTS.md: never click Answer now; wait for the real Pro response.`,
    };
  }
  return decision;
}

/**
 * Build the v18 `json_envelope.v1` recovery envelope for a ChatGPT Pro
 * snapshot. Always runs the `assertNoAnswerNowSuggestion` invariant
 * before returning — a regression that ever advised Answer now would
 * throw here rather than reach the wire.
 */
export function buildChatgptProRecoveryEnvelope(
  snapshot: LongRunStateSnapshot,
  decision: ResumeDecision,
): JsonEnvelope {
  const envelope = buildRecoveryEnvelope(snapshot, decision);
  assertNoAnswerNowSuggestion(envelope);
  return envelope;
}

/**
 * One-shot helper: snapshot → decide → envelope. Most callers want
 * this; the lower-level pieces are exposed for unit tests + custom
 * pipelines.
 */
export interface RecoverChatgptProRunInput extends ChatgptProSnapshotInput {
  readonly now: number;
  readonly policy?: ResumePolicy;
}

export interface RecoverChatgptProRunResult {
  readonly snapshot: LongRunStateSnapshot;
  readonly decision: ResumeDecision;
  readonly envelope: JsonEnvelope;
}

export function recoverChatgptProRun(
  input: RecoverChatgptProRunInput,
): RecoverChatgptProRunResult {
  const snapshot = snapshotChatgptProRun(input);
  const decision = decideChatgptProResume(
    snapshot,
    input.now,
    input.policy ?? defaultChatgptProResumePolicy(),
  );
  const envelope = buildChatgptProRecoveryEnvelope(snapshot, decision);
  return { snapshot, decision, envelope };
}
