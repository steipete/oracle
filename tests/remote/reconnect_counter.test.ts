import { describe, expect, test } from "vitest";

import { buildHeartbeat } from "@src/remote/heartbeat.ts";
import {
  applyReconnectEvent,
  decideReconnect,
  defaultReconnectPolicy,
  initialRemoteRunState,
  type ReconnectPolicy,
  type RemoteRunState,
} from "@src/remote/reconnect.ts";

const T0 = 1_700_000_000_000;

const POLICY: ReconnectPolicy = {
  ...defaultReconnectPolicy(),
  maxAttempts: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  heartbeatMissDeadlineMs: 60_000,
};

function startState(): RemoteRunState {
  return initialRemoteRunState({ sessionId: "sess-reconnect-counter", startedAtMs: T0 });
}

function expectReattachAttempt(
  state: RemoteRunState,
  now: number,
  attempt: number,
): RemoteRunState {
  const decision = decideReconnect(state, now, POLICY);
  expect(decision.kind).toBe("reattach");
  if (decision.kind !== "reattach") {
    throw new Error(`expected reattach attempt ${attempt}`);
  }
  expect(decision.attempt).toBe(attempt);

  const started = applyReconnectEvent(state, {
    type: "reattach_started",
    at: now,
    reason: decision.reason,
  });
  expect(started.attempts).toBe(attempt);
  expect(started.reconnectAttemptInFlight).toBe(true);

  const heartbeat = buildHeartbeat({ state: started, decision, now });
  expect(heartbeat.state).toBe("reconnecting");
  expect(heartbeat.attempt).toBe(attempt);

  const duplicate = decideReconnect(started, now + 1, POLICY);
  expect(duplicate.kind).toBe("wait");
  if (duplicate.kind === "wait") {
    expect(duplicate.reason).toContain(`attempt ${attempt}/${POLICY.maxAttempts} in progress`);
  }

  return applyReconnectEvent(started, {
    type: "reattach_failed",
    at: now + 2,
    reason: "connection attempt failed",
  });
}

describe("remote reconnect failed-attempt counter", () => {
  test("failed target reattach attempts consume budget and then hand off", () => {
    let state = applyReconnectEvent(startState(), { type: "target_lost", at: T0 + 1_000 });

    for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt += 1) {
      state = expectReattachAttempt(state, T0 + attempt * 10_000, attempt);
      expect(state.targetLost).toBe(true);
      expect(state.reconnectAttemptInFlight).toBe(false);
    }

    const decision = decideReconnect(state, T0 + 60_000, POLICY);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.recoverCommand).toBe("oracle session sess-reconnect-counter");
      expect(decision.reason).toContain("max attempts reached");
    }
  });

  test("failed endpoint reattach attempts consume budget and then hand off", () => {
    let state = applyReconnectEvent(startState(), { type: "endpoint_lost", at: T0 + 1_000 });

    for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt += 1) {
      state = expectReattachAttempt(state, T0 + attempt * 10_000, attempt);
      expect(state.endpointLost).toBe(true);
    }

    const decision = decideReconnect(state, T0 + 60_000, POLICY);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.errorCode).toBe("remote_browser_unavailable");
    }
  });

  test("failed no-heartbeat precautionary attempts consume budget", () => {
    let state = startState();
    const firstMiss = T0 + POLICY.heartbeatMissDeadlineMs + 1;

    for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt += 1) {
      state = expectReattachAttempt(state, firstMiss + attempt * 10_000, attempt);
    }

    const decision = decideReconnect(state, firstMiss + 60_000, POLICY);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.reason).toContain("no heartbeat");
      expect(decision.errorCode).toBe("output_capture_unverified");
    }
  });

  test("successful recovery after a consumed attempt does not double-count", () => {
    let state = applyReconnectEvent(startState(), { type: "target_lost", at: T0 + 1_000 });
    const decision = decideReconnect(state, T0 + 2_000, POLICY);
    expect(decision.kind).toBe("reattach");

    state = applyReconnectEvent(state, { type: "reattach_started", at: T0 + 2_000 });
    expect(state.attempts).toBe(1);
    expect(state.reconnectAttemptInFlight).toBe(true);

    state = applyReconnectEvent(state, { type: "target_recovered", at: T0 + 3_000 });
    expect(state.targetLost).toBe(false);
    expect(state.reconnectAttemptInFlight).toBe(false);
    expect(state.attempts).toBe(1);

    const afterRecovery = decideReconnect(state, T0 + 4_000, POLICY);
    expect(afterRecovery.kind).toBe("wait");
  });
});
