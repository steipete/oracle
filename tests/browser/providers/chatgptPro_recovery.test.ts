import { describe, expect, test } from "vitest";

import {
  CHATGPT_PRO_PROVIDER_SLOTS,
  buildChatgptProRecoveryEnvelope,
  decideChatgptProResume,
  defaultChatgptProResumePolicy,
  isChatgptProSlot,
  normalizeConversationUrlHint,
  recoverChatgptProRun,
  snapshotChatgptProRun,
} from "@src/browser/providers/chatgptPro_recovery.ts";
import {
  LONG_RUN_STATE_SCHEMA_VERSION,
  PRO_THINKING_HARD_MAX_MS,
  PRO_THINKING_MIN_BACKGROUND_MS,
  assertNoAnswerNowSuggestion,
  buildRecoveryEnvelope,
  decideResume,
  defaultResumePolicy,
  longRunStateSnapshotSchema,
  parseSnapshot,
  serializeSnapshot,
  snapshotRunState,
  type LongRunStateSnapshot,
} from "@src/remote/long_run_state.ts";
import {
  applyReconnectEvent,
  initialRemoteRunState,
  type RemoteRunState,
} from "@src/remote/reconnect.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "@src/oracle/v18/index.ts";

const T0 = 1_700_000_000_000;

function buildRemoteState(overrides: Partial<RemoteRunState> = {}): RemoteRunState {
  const base = initialRemoteRunState({ sessionId: "sess-pro-recovery", startedAtMs: T0 });
  return { ...base, ...overrides };
}

describe("AGENTS.md invariants pinned in long_run_state", () => {
  test("hard max thinking budget matches AGENTS.md 1h Pro window", () => {
    expect(PRO_THINKING_HARD_MAX_MS).toBe(60 * 60 * 1000);
  });

  test("min background window matches AGENTS.md 10m soft floor", () => {
    expect(PRO_THINKING_MIN_BACKGROUND_MS).toBe(10 * 60 * 1000);
  });
});

describe("snapshotRunState + schema round-trip", () => {
  test("produces a typed snapshot conforming to long_run_state.v1", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro-recovery",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "thinking",
      remote: buildRemoteState({ observedReasoningLabel: "Heavy" }),
      evidence_id: "ev-1",
      conversation_url_hint: "/c/abc-123-def",
    });
    expect(snap.schema_version).toBe(LONG_RUN_STATE_SCHEMA_VERSION);
    expect(snap.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(snap.observed_reasoning_effort_label).toBe("Heavy");
    expect(snap.evidence_id).toBe("ev-1");
    expect(snap.conversation_url_hint).toBe("/c/abc-123-def");
    expect(snap.recover_command).toBe("oracle session sess-pro-recovery");
  });

  test("round-trips via serializeSnapshot / parseSnapshot", () => {
    const snap = snapshotRunState({
      session_id: "sess-1",
      provider_slot: "chatgpt_pro_synthesis",
      run_id: "run-2",
      observed_state: "background",
      remote: buildRemoteState(),
    });
    const serialized = serializeSnapshot(snap);
    const parsed = parseSnapshot(JSON.parse(serialized));
    expect(parsed).toEqual(snap);
  });

  test("rejects an invalid schema_version on parse", () => {
    const snap = snapshotRunState({
      session_id: "sess-1",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-3",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const bad = { ...snap, schema_version: "long_run_state.v0" };
    expect(() => longRunStateSnapshotSchema.parse(bad)).toThrow();
  });
});

describe("decideResume (generic) — every state has the v18 recovery fields", () => {
  test.each([
    "thinking",
    "background",
    "reconnecting",
    "completed",
    "failed_retryable",
    "failed_terminal",
  ] as const)("state %s decision has next_command + retry_safe", (state) => {
    const snap = snapshotRunState({
      session_id: "sess-x",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-x",
      observed_state: state,
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 5 * 60 * 1000);
    expect(typeof decision.next_command).toBe("string");
    expect(decision.next_command).toBe("oracle session sess-x");
    expect(typeof decision.retry_safe).toBe("boolean");
  });
});

describe("decideResume — Pro thinking window semantics", () => {
  test("thinking within 10m is resumable_background (early signal)", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 5 * 60 * 1000);
    expect(decision.kind).toBe("resumable_background");
    expect(decision.retry_safe).toBe(true);
    expect(decision.user_visible_message).toMatch(/never\s+click\s+answer\s+now/i);
  });

  test("thinking past 1h is unrecoverable (over AGENTS.md budget)", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 65 * 60 * 1000);
    expect(decision.kind).toBe("unrecoverable");
    expect(decision.retry_safe).toBe(false);
    expect(decision.error_code).toBe("ui_drift_suspected");
  });

  test("background state mid-window is resumable_background with the recover command", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_synthesis",
      run_id: "run-1",
      observed_state: "background",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 30 * 60 * 1000);
    expect(decision.kind).toBe("resumable_background");
    expect(decision.next_command).toBe("oracle session sess-pro");
  });

  test("failed_retryable yields resumable_attempt", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "failed_retryable",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 1_000);
    expect(decision.kind).toBe("resumable_attempt");
    expect(decision.retry_safe).toBe(true);
  });

  test("failed_terminal yields unrecoverable with retry_safe=false", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "failed_terminal",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 1_000);
    expect(decision.kind).toBe("unrecoverable");
    expect(decision.retry_safe).toBe(false);
    expect(decision.error_code).toBe("output_capture_unverified");
  });

  test("reconnecting past maxAttempts yields unrecoverable with remote_browser_unavailable", () => {
    const snap = snapshotRunState({
      session_id: "sess-pro",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-1",
      observed_state: "reconnecting",
      remote: buildRemoteState({ attempts: 99 }),
    });
    const decision = decideResume(snap, T0 + 1_000, defaultResumePolicy());
    expect(decision.kind).toBe("unrecoverable");
    expect(decision.error_code).toBe("remote_browser_unavailable");
  });

  test("completed snapshot yields complete with render command", () => {
    const snap = snapshotRunState({
      session_id: "sess-done",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-done",
      observed_state: "completed",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 1_000);
    expect(decision.kind).toBe("complete");
    expect(decision.user_visible_message).toMatch(/oracle session sess-done --render/);
  });
});

describe("buildRecoveryEnvelope — v18 json_envelope conformance", () => {
  test("resumable_background envelope passes jsonEnvelopeSchema and is ok=true", () => {
    const snap = snapshotRunState({
      session_id: "sess-env-1",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-env-1",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 5 * 60 * 1000);
    const envelope = buildRecoveryEnvelope(snap, decision);
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.next_command).toBe("oracle session sess-env-1");
    expect(envelope.retry_safe).toBe(true);
    expect(envelope.meta.run_id).toBe("run-env-1");
    expect(envelope.meta.session_id).toBe("sess-env-1");
    expect(envelope.meta.resume_kind).toBe("resumable_background");
  });

  test("unrecoverable envelope is ok=false with a v18 error code", () => {
    const snap = snapshotRunState({
      session_id: "sess-env-2",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-env-2",
      observed_state: "failed_terminal",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 1_000);
    const envelope = buildRecoveryEnvelope(snap, decision);
    expect(envelope.ok).toBe(false);
    expect(envelope.retry_safe).toBe(false);
    expect(envelope.blocked_reason).toBe(decision.reason);
    expect(envelope.errors.length).toBeGreaterThan(0);
    const code = (envelope.errors[0] as Record<string, unknown>).error_code;
    expect(typeof code).toBe("string");
  });
});

describe("assertNoAnswerNowSuggestion (AGENTS.md hard invariant)", () => {
  test("passes a benign envelope", () => {
    const envelope = buildRecoveryEnvelope(
      snapshotRunState({
        session_id: "sess-y",
        provider_slot: "chatgpt_pro_first_plan",
        run_id: "run-y",
        observed_state: "thinking",
        remote: buildRemoteState(),
      }),
      decideResume(
        snapshotRunState({
          session_id: "sess-y",
          provider_slot: "chatgpt_pro_first_plan",
          run_id: "run-y",
          observed_state: "thinking",
          remote: buildRemoteState(),
        }),
        T0 + 5 * 60 * 1000,
      ),
    );
    expect(() => assertNoAnswerNowSuggestion(envelope)).not.toThrow();
  });

  test("throws on an envelope that suggests clicking Answer now without negation", () => {
    const envelope = {
      schema_version: "json_envelope.v1" as const,
      ok: true,
      data: { advice: "Please click Answer now to continue." },
      meta: {},
      blocked_reason: null,
      next_command: null,
      fix_command: null,
      retry_safe: null,
      errors: [],
      warnings: [],
      commands: {},
    };
    expect(() => assertNoAnswerNowSuggestion(envelope)).toThrow(/AGENTS\.md violation/i);
  });
});

describe("ChatGPT Pro-specific recovery", () => {
  test("CHATGPT_PRO_PROVIDER_SLOTS includes both formal_plan and synthesis", () => {
    expect([...CHATGPT_PRO_PROVIDER_SLOTS]).toEqual([
      "chatgpt_pro_first_plan",
      "chatgpt_pro_synthesis",
    ]);
  });

  test("isChatgptProSlot rejects non-ChatGPT-Pro slots", () => {
    expect(isChatgptProSlot("chatgpt_pro_first_plan")).toBe(true);
    expect(isChatgptProSlot("gemini_deep_think")).toBe(false);
    expect(isChatgptProSlot("xai_grok_reasoning")).toBe(false);
    expect(isChatgptProSlot(undefined)).toBe(false);
  });

  test("normalizeConversationUrlHint accepts /c/<id> paths", () => {
    expect(normalizeConversationUrlHint("/c/abc-123-xyz")).toBe("/c/abc-123-xyz");
    expect(normalizeConversationUrlHint("  /c/abc-123-xyz  ")).toBe("/c/abc-123-xyz");
    expect(normalizeConversationUrlHint("https://chatgpt.com/c/abc-123-xyz")).toBe(
      "https://chatgpt.com/c/abc-123-xyz",
    );
  });

  test("normalizeConversationUrlHint rejects non-conversation strings", () => {
    expect(normalizeConversationUrlHint("https://example.com")).toBeNull();
    expect(normalizeConversationUrlHint("")).toBeNull();
    expect(normalizeConversationUrlHint(undefined)).toBeNull();
    expect(normalizeConversationUrlHint("/profile")).toBeNull();
  });

  test("snapshotChatgptProRun rejects non-ChatGPT-Pro slots", () => {
    expect(() =>
      snapshotChatgptProRun({
        session_id: "sess-pro",
        run_id: "run-pro",
        provider_slot: "gemini_deep_think" as never,
        observed_state: "thinking",
        remote: buildRemoteState(),
      }),
    ).toThrow(/provider_slot must be one of/);
  });

  test("decideChatgptProResume always carries the never-click-Answer-now phrase on background hand-off", () => {
    const snap = snapshotChatgptProRun({
      session_id: "sess-pro",
      run_id: "run-pro",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: buildRemoteState({ observedReasoningLabel: "Heavy" }),
      conversation_url_hint: "/c/abc-123",
    });
    const decision = decideChatgptProResume(snap, T0 + 30 * 60 * 1000);
    expect(decision.kind).toBe("resumable_background");
    expect(decision.user_visible_message).toMatch(/never\s+click\s+answer\s+now/i);
  });

  test("recoverChatgptProRun envelope passes assertNoAnswerNowSuggestion", () => {
    const result = recoverChatgptProRun({
      session_id: "sess-pro",
      run_id: "run-pro",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: buildRemoteState(),
      now: T0 + 30 * 60 * 1000,
    });
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.next_command).toBe("oracle session sess-pro");
    expect(result.envelope.retry_safe).toBe(true);
    // assertNoAnswerNowSuggestion is invoked inside; if it threw, this
    // test would never reach the next assertion.
    expect(() => assertNoAnswerNowSuggestion(result.envelope)).not.toThrow();
  });

  test("recoverChatgptProRun past 1h yields ok=false + unrecoverable envelope", () => {
    const result = recoverChatgptProRun({
      session_id: "sess-pro",
      run_id: "run-pro",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: buildRemoteState(),
      now: T0 + 65 * 60 * 1000,
    });
    expect(result.decision.kind).toBe("unrecoverable");
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.retry_safe).toBe(false);
  });

  test("policy override forces an earlier hard max for tight tests", () => {
    const tightPolicy = { ...defaultChatgptProResumePolicy(), hardMaxThinkingMs: 30_000 };
    const result = recoverChatgptProRun({
      session_id: "sess-pro",
      run_id: "run-pro",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: buildRemoteState(),
      now: T0 + 60_000, // 60s, past the tight policy's 30s max
      policy: tightPolicy,
    });
    expect(result.decision.kind).toBe("unrecoverable");
  });
});

describe("conversation_url_hint propagation", () => {
  test("the hint round-trips into the snapshot for reattach", () => {
    const snap = snapshotChatgptProRun({
      session_id: "sess-hint",
      run_id: "run-hint",
      provider_slot: "chatgpt_pro_synthesis",
      observed_state: "background",
      remote: buildRemoteState(),
      conversation_url_hint: "/c/conv-12345",
    });
    expect(snap.conversation_url_hint).toBe("/c/conv-12345");
  });

  test("invalid hints are stored as null", () => {
    const snap = snapshotChatgptProRun({
      session_id: "sess-hint",
      run_id: "run-hint",
      provider_slot: "chatgpt_pro_synthesis",
      observed_state: "background",
      remote: buildRemoteState(),
      conversation_url_hint: "garbage",
    });
    expect(snap.conversation_url_hint).toBeNull();
  });
});

describe("integration with the existing reconnect state machine", () => {
  test("a reconnect-driven RemoteRunState projects cleanly into a snapshot", () => {
    let state = initialRemoteRunState({ sessionId: "sess-integ", startedAtMs: T0 });
    state = applyReconnectEvent(state, {
      type: "prompt_thinking",
      at: T0 + 1_000,
      observedLabel: "Pro",
    });
    state = applyReconnectEvent(state, { type: "heartbeat", at: T0 + 60_000 });
    const snap = snapshotChatgptProRun({
      session_id: state.sessionId,
      run_id: "run-integ",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: state,
    });
    expect(snap.observed_reasoning_effort_label).toBe("Pro");
    expect(snap.attempts).toBe(0);
    expect(snap.last_event_at_ms).toBe(T0 + 60_000);
    // Compose with the generic decider to validate the path.
    const decision = decideResume(snap, T0 + 5 * 60 * 1000);
    expect(decision.kind).toBe("resumable_background");
  });
});

describe("snapshot prevents false success", () => {
  test("no decision kind named 'success'; resumable_background is ok=true but state is not 'completed'", () => {
    const snap = snapshotRunState({
      session_id: "sess-no-false",
      provider_slot: "chatgpt_pro_first_plan",
      run_id: "run-no-false",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const decision = decideResume(snap, T0 + 30 * 60 * 1000);
    const envelope = buildRecoveryEnvelope(snap, decision);
    expect(decision.kind).not.toBe("complete");
    expect((envelope.data as Record<string, unknown>).snapshot).toMatchObject({
      state: "thinking",
    });
    // The "success" envelope is only emitted when state === "completed";
    // a thinking snapshot returns ok=true with resume_kind=
    // resumable_background. That is NOT false success because the
    // user_visible_message and meta.resume_kind both say the run is
    // still in progress.
    expect(envelope.meta.resume_kind).toBe("resumable_background");
  });
});

describe("buildChatgptProRecoveryEnvelope — invariant is always asserted", () => {
  test("returns an envelope and the AGENTS.md guard ran", () => {
    const snap = snapshotChatgptProRun({
      session_id: "sess-assert",
      run_id: "run-assert",
      provider_slot: "chatgpt_pro_synthesis",
      observed_state: "thinking",
      remote: buildRemoteState(),
    });
    const decision = decideChatgptProResume(snap, T0 + 5 * 60 * 1000);
    const envelope = buildChatgptProRecoveryEnvelope(snap, decision);
    // Envelope contains the literal warning phrase (which is fine
    // because it's a negation), but no positive Answer-now suggestion.
    const text = JSON.stringify(envelope);
    expect(text.toLowerCase()).toContain("never click answer now");
  });
});

describe("LongRunStateSnapshot is what gets persisted — no reasoning text leak", () => {
  test("snapshot serialization carries picker label but never raw reasoning bytes", () => {
    const snap = snapshotChatgptProRun({
      session_id: "sess-noleak",
      run_id: "run-noleak",
      provider_slot: "chatgpt_pro_first_plan",
      observed_state: "thinking",
      remote: buildRemoteState({ observedReasoningLabel: "Heavy" }),
    });
    const serialized = serializeSnapshot(snap);
    expect(serialized).toContain("Heavy");
    for (const banned of [
      /raw_output/i,
      /assistant_text/i,
      /Bearer\s/i,
      /authorization/i,
      /cookies?/i,
    ]) {
      expect(serialized).not.toMatch(banned);
    }
  });
});

describe("recover_command shape stays canonical", () => {
  test.each(["sess-a", "sess-with-dashes", "sess_with_underscores"])(
    "recover_command for %s is `oracle session %s`",
    (sessionId) => {
      const snap: LongRunStateSnapshot = snapshotRunState({
        session_id: sessionId,
        provider_slot: "chatgpt_pro_first_plan",
        run_id: "run-1",
        observed_state: "thinking",
        remote: buildRemoteState({ sessionId }),
      });
      expect(snap.recover_command).toBe(`oracle session ${sessionId}`);
    },
  );
});
