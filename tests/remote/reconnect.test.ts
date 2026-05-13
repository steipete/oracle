import { describe, expect, test } from "vitest";

import {
  RECONNECT_NEVER_CLICK_ANSWER_NOW,
  applyReconnectEvent,
  buildRemoteHandoff,
  decideReconnect,
  defaultReconnectPolicy,
  initialRemoteRunState,
  type ReconnectDecision,
  type ReconnectPolicy,
  type RemoteRunState,
} from "@src/remote/reconnect.ts";
import {
  REMOTE_HEARTBEAT_SCHEMA_VERSION,
  buildHeartbeat,
  heartbeatToLogLine,
  sanitizeHeartbeatExtra,
} from "@src/remote/heartbeat.ts";

const T0 = 1_700_000_000_000;

function startState(): RemoteRunState {
  return initialRemoteRunState({ sessionId: "sess-pro-1", startedAtMs: T0 });
}

describe("AGENTS.md invariants", () => {
  test("the never-click-Answer-now constant is exported and true", () => {
    // Compile-time + runtime assertion: the module advertises the
    // AGENTS.md guarantee so callers can grep for it.
    expect(RECONNECT_NEVER_CLICK_ANSWER_NOW).toBe(true);
  });

  test("default policy allows up to 1h of Pro thinking", () => {
    const policy = defaultReconnectPolicy();
    // AGENTS.md: wait 10m–1h for the real assistant response.
    expect(policy.maxTotalWaitMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(policy.maxTotalWaitMs).toBe(60 * 60 * 1000);
  });
});

describe("applyReconnectEvent (pure state transitions)", () => {
  test("heartbeat updates lastHeartbeatMs only", () => {
    const start = startState();
    const next = applyReconnectEvent(start, { type: "heartbeat", at: T0 + 30_000 });
    expect(next.lastHeartbeatMs).toBe(T0 + 30_000);
    expect(next.attempts).toBe(0);
    expect(next.targetLost).toBe(false);
  });

  test("target_lost / target_recovered toggles and increments attempts on recovery", () => {
    const lost = applyReconnectEvent(startState(), { type: "target_lost", at: T0 + 5_000 });
    expect(lost.targetLost).toBe(true);
    const recovered = applyReconnectEvent(lost, { type: "target_recovered", at: T0 + 10_000 });
    expect(recovered.targetLost).toBe(false);
    expect(recovered.attempts).toBe(1);
  });

  test("endpoint_lost / endpoint_recovered toggles and increments attempts on recovery", () => {
    const lost = applyReconnectEvent(startState(), { type: "endpoint_lost", at: T0 + 5_000 });
    expect(lost.endpointLost).toBe(true);
    const recovered = applyReconnectEvent(lost, { type: "endpoint_recovered", at: T0 + 10_000 });
    expect(recovered.endpointLost).toBe(false);
    expect(recovered.attempts).toBe(1);
  });

  test("prompt_thinking records the observed PICKER LABEL only — never reasoning text", () => {
    const next = applyReconnectEvent(startState(), {
      type: "prompt_thinking",
      at: T0 + 1_000,
      observedLabel: "Pro",
    });
    expect(next.thinking).toBe(true);
    expect(next.observedReasoningLabel).toBe("Pro");
    // Confirm we never store an event payload that contains content bytes.
    const serialized = JSON.stringify(next);
    expect(serialized).not.toMatch(/raw_output|assistant_text|response_text|thinking_text/);
  });

  test("result_received marks the run completed and clears thinking", () => {
    const thinking = applyReconnectEvent(startState(), {
      type: "prompt_thinking",
      at: T0,
      observedLabel: "Pro",
    });
    const done = applyReconnectEvent(thinking, { type: "result_received", at: T0 + 60_000 });
    expect(done.completed).toBe(true);
    expect(done.thinking).toBe(false);
  });
});

describe("decideReconnect — bead acceptance", () => {
  const policy: ReconnectPolicy = {
    ...defaultReconnectPolicy(),
    maxAttempts: 3,
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    heartbeatMissDeadlineMs: 60_000,
  };

  test("local timeout while thinking returns wait (Pro must keep cooking)", () => {
    let state = startState();
    state = applyReconnectEvent(state, {
      type: "prompt_thinking",
      at: T0 + 1_000,
      observedLabel: "Heavy",
    });
    state = applyReconnectEvent(state, { type: "heartbeat", at: T0 + 30_000 });
    const decision = decideReconnect(state, T0 + 60_000, policy);
    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reason).toContain("still thinking");
    }
  });

  test("target_lost triggers a reattach with exponential backoff", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "target_lost", at: T0 + 5_000 });
    const first = decideReconnect(state, T0 + 6_000, policy);
    expect(first.kind).toBe("reattach");
    if (first.kind === "reattach") {
      expect(first.attempt).toBe(1);
      expect(first.delayMs).toBe(1_000);
    }
    // Simulate one failed recovery, then a second target_lost.
    state = applyReconnectEvent(state, { type: "target_recovered", at: T0 + 7_000 });
    state = applyReconnectEvent(state, { type: "target_lost", at: T0 + 8_000 });
    const second = decideReconnect(state, T0 + 9_000, policy);
    expect(second.kind).toBe("reattach");
    if (second.kind === "reattach") {
      expect(second.attempt).toBe(2);
      expect(second.delayMs).toBe(2_000);
    }
  });

  test("endpoint_lost reports the remote_browser_unavailable v18 error code", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "endpoint_lost", at: T0 + 5_000 });
    const decision = decideReconnect(state, T0 + 6_000, policy);
    expect(decision.kind).toBe("reattach");
    if (decision.kind === "reattach") {
      expect(decision.errorCode).toBe("remote_browser_unavailable");
    }
  });

  test("target lost and then recovered resumes wait without further reattach", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "target_lost", at: T0 + 5_000 });
    state = applyReconnectEvent(state, { type: "target_recovered", at: T0 + 6_000 });
    const decision = decideReconnect(state, T0 + 7_000, policy);
    expect(decision.kind).toBe("wait");
  });

  test("exhausted attempts hand off to background with oracle session <id>", () => {
    let state = startState();
    // Drain attempts up to max
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      state = applyReconnectEvent(state, { type: "target_lost", at: T0 + i * 1000 });
      state = applyReconnectEvent(state, {
        type: "target_recovered",
        at: T0 + i * 1000 + 500,
      });
    }
    state = applyReconnectEvent(state, { type: "target_lost", at: T0 + 60_000 });
    const decision = decideReconnect(state, T0 + 61_000, policy);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.sessionId).toBe(state.sessionId);
      expect(decision.recoverCommand).toBe(`oracle session ${state.sessionId}`);
    }
  });

  test("maxTotalWaitMs exceeded hands off rather than spinning", () => {
    const state = startState();
    const decision = decideReconnect(state, T0 + policy.maxTotalWaitMs + 1, policy);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.errorCode).toBe("ui_drift_suspected");
    }
  });

  test("no-heartbeat past heartbeatMissDeadlineMs triggers precautionary reattach", () => {
    const state = startState();
    const decision = decideReconnect(state, T0 + policy.heartbeatMissDeadlineMs + 1, policy);
    expect(decision.kind).toBe("reattach");
    if (decision.kind === "reattach") {
      expect(decision.reason).toContain("no heartbeat");
    }
  });

  test("result_received yields complete and stops further work", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "result_received", at: T0 + 60_000 });
    const decision = decideReconnect(state, T0 + 60_001, policy);
    expect(decision.kind).toBe("complete");
  });

  test("buildRemoteHandoff stamps the canonical recover_command", () => {
    const handoff = buildRemoteHandoff(startState(), "test handoff");
    expect(handoff.recoverCommand).toBe("oracle session sess-pro-1");
    expect(handoff.reason).toBe("test handoff");
    expect(handoff.errorCode).toBeNull();
  });
});

describe("buildHeartbeat — metadata + no reasoning text", () => {
  test("running heartbeat carries elapsed_ms, attempt, and a session id", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "heartbeat", at: T0 + 30_000 });
    const decision: ReconnectDecision = {
      kind: "wait",
      nextCheckInMs: 60_000,
      reason: "waiting for next heartbeat",
    };
    const hb = buildHeartbeat({ state, decision, now: T0 + 30_000 });
    expect(hb.schema_version).toBe(REMOTE_HEARTBEAT_SCHEMA_VERSION);
    expect(hb.session_id).toBe(state.sessionId);
    expect(hb.elapsed_ms).toBe(30_000);
    expect(hb.state).toBe("running");
    expect(hb.recover_command).toBeNull();
    expect(hb.blocked_reason).toBeNull();
    expect(hb.next_check_in_ms).toBe(60_000);
  });

  test("thinking state surfaces in the heartbeat without leaking the reasoning text", () => {
    let state = startState();
    state = applyReconnectEvent(state, {
      type: "prompt_thinking",
      at: T0 + 1_000,
      observedLabel: "Heavy",
    });
    const hb = buildHeartbeat({
      state,
      decision: {
        kind: "wait",
        nextCheckInMs: 60_000,
        reason: "assistant still thinking; holding for Pro completion",
      },
      now: T0 + 60_000,
    });
    expect(hb.state).toBe("thinking");
    expect(hb.extra).toEqual({ observed_reasoning_effort_label: "Heavy" });
    expect(heartbeatToLogLine(hb)).not.toMatch(/raw_output|assistant_text|response_text/);
  });

  test("reattach decision becomes a reconnecting heartbeat", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "endpoint_lost", at: T0 + 5_000 });
    const decision = decideReconnect(state, T0 + 6_000, defaultReconnectPolicy());
    const hb = buildHeartbeat({ state, decision, now: T0 + 6_000 });
    expect(hb.state).toBe("reconnecting");
    expect(hb.next_check_in_ms).toBeGreaterThan(0);
  });

  test("background decision exposes recover_command for outer agents", () => {
    let state = startState();
    state = applyReconnectEvent(state, { type: "endpoint_lost", at: T0 });
    // Exhaust attempts via target-recovered cycles
    for (let i = 0; i < defaultReconnectPolicy().maxAttempts; i += 1) {
      state = applyReconnectEvent(state, { type: "endpoint_recovered", at: T0 + (i + 1) * 1000 });
      state = applyReconnectEvent(state, { type: "endpoint_lost", at: T0 + (i + 1) * 1000 + 1 });
    }
    const decision = decideReconnect(state, T0 + 60_000, defaultReconnectPolicy());
    expect(decision.kind).toBe("background");
    const hb = buildHeartbeat({ state, decision, now: T0 + 60_000 });
    expect(hb.state).toBe("background");
    expect(hb.recover_command).toBe(`oracle session ${state.sessionId}`);
    expect(hb.blocked_reason).toBeTruthy();
  });
});

describe("sanitizeHeartbeatExtra strips forbidden reasoning-text keys", () => {
  test("recursively drops keys flagged by FORBIDDEN_KEY_TEST", () => {
    const dirty = {
      observed_reasoning_effort_label: "Heavy",
      raw_output: "should be redacted",
      meta: {
        assistant_text: "should be redacted too",
        cookie: "should be redacted",
        nested: { response_text: "x", count: 3 },
      },
      attempts: 1,
    };
    const cleaned = sanitizeHeartbeatExtra(dirty);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toMatch(/raw_output|assistant_text|cookie|response_text/);
    expect(cleaned).toEqual({
      observed_reasoning_effort_label: "Heavy",
      meta: { nested: { count: 3 } },
      attempts: 1,
    });
  });

  test("explicit reasoning-text-bearing extras are sanitized when supplied to buildHeartbeat", () => {
    const state = startState();
    const decision: ReconnectDecision = {
      kind: "wait",
      nextCheckInMs: 60_000,
      reason: "ok",
    };
    const hb = buildHeartbeat({
      state,
      decision,
      now: T0,
      extra: {
        attempts_remaining: 3,
        raw_output: "leaked",
        assistant_text: "leaked2",
      },
    });
    expect(JSON.stringify(hb)).not.toMatch(/raw_output|assistant_text|leaked/);
    expect(hb.extra).toEqual({ attempts_remaining: 3 });
  });
});

describe("incomplete-run reattachment", () => {
  test("budget exhaustion produces a session-anchored handoff (no false success)", () => {
    const state = startState();
    const policy: ReconnectPolicy = {
      ...defaultReconnectPolicy(),
      maxTotalWaitMs: 10_000,
    };
    const decision = decideReconnect(state, T0 + 11_000, policy);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.sessionId).toBe(state.sessionId);
      expect(decision.recoverCommand).toBe(`oracle session ${state.sessionId}`);
      // Confirm the decision never advises clicking Answer now.
      expect(decision.reason).not.toMatch(/Answer now/i);
    }
  });
});
