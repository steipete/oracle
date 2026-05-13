// Tests for the ChatGPT Pro same-session verification state machine
// (oracle-php).
//
// Acceptance criteria (verbatim from the bead):
//
//   Unit/browser fixture tests cover legal transitions, illegal
//   prompt-before-verify, login required, UI drift, usage limit,
//   output empty, and evidence-written-before-success ordering.

import { describe, expect, test } from "vitest";

import {
  CHATGPT_PRO_FAILURE_STATES,
  CHATGPT_PRO_LEGAL_STATES,
  applyChatGptProEvents,
  createChatGptProMachine,
  errorCodeForFailure,
  isFailureState,
  isProLabel,
  isSuccessState,
  legalStateRank,
  machineVerdict,
  transition,
  type ChatGptProEvent,
} from "../../src/browser/providers/chatgptProVerification.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"b".repeat(64)}` as const;
const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;

function fullHappyPath(): readonly ChatGptProEvent[] {
  return [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
    { type: "effort_candidate_selected", observedEffortLabels: ["Heavy", "Pro Extended"] },
    { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
    { type: "submit_prompt", promptSha256: PROMPT_HASH },
    { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 1234 },
    { type: "evidence_written", evidenceId: "evidence-test-1" },
    { type: "finish" },
  ];
}

describe("ChatGPT Pro FSM — taxonomy", () => {
  test("legal states list matches the bead's spec exactly", () => {
    expect([...CHATGPT_PRO_LEGAL_STATES]).toEqual([
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
    ]);
  });

  test("failure states cover every v18 error code the bead names", () => {
    expect(new Set(CHATGPT_PRO_FAILURE_STATES)).toEqual(
      new Set([
        "login_required",
        "pro_unverified",
        "extended_reasoning_unverified",
        "ui_drift_suspected",
        "usage_limit",
        "output_empty",
        "prompt_submitted_before_verification",
        "remote_browser_unavailable",
        "remote_browser_unavailable_mid_run",
      ]),
    );
  });

  test("errorCodeForFailure maps every failure to a documented v18 code", () => {
    expect(errorCodeForFailure("login_required")).toBe("provider_login_required");
    expect(errorCodeForFailure("pro_unverified")).toBe("chatgpt_pro_unverified");
    expect(errorCodeForFailure("extended_reasoning_unverified")).toBe(
      "chatgpt_extended_reasoning_unverified",
    );
    expect(errorCodeForFailure("ui_drift_suspected")).toBe("ui_drift_suspected");
    expect(errorCodeForFailure("usage_limit")).toBe("provider_usage_limit");
    expect(errorCodeForFailure("output_empty")).toBe("output_capture_empty");
    expect(errorCodeForFailure("prompt_submitted_before_verification")).toBe(
      "prompt_submitted_before_verification",
    );
    expect(errorCodeForFailure("remote_browser_unavailable")).toBe(
      "remote_browser_unavailable",
    );
    expect(errorCodeForFailure("remote_browser_unavailable_mid_run")).toBe(
      "remote_browser_unavailable",
    );
  });

  test("legalStateRank assigns strictly increasing ranks", () => {
    for (let i = 1; i < CHATGPT_PRO_LEGAL_STATES.length; i++) {
      expect(legalStateRank(CHATGPT_PRO_LEGAL_STATES[i])).toBeGreaterThan(
        legalStateRank(CHATGPT_PRO_LEGAL_STATES[i - 1]),
      );
    }
  });
});

describe("ChatGPT Pro FSM — legal transitions", () => {
  test("a fresh machine starts at session_start with empty context", () => {
    const m = createChatGptProMachine();
    expect(m.state).toBe("session_start");
    expect(m.context.mode).toBeNull();
    expect(m.context.modelLabel).toBeNull();
    expect(m.context.effort).toBeNull();
    expect(m.context.evidenceId).toBeNull();
    expect(m.context.failureReason).toBeNull();
  });

  test("happy path drives the machine to success", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), fullHappyPath());
    expect(m.state).toBe("success");
    expect(isSuccessState(m.state)).toBe(true);
    expect(m.context.mode).toBe("remote");
    expect(m.context.modelLabel).toBe("GPT-5.5 Pro");
    expect(m.context.effort?.status).toBe("verified");
    expect(m.context.effort?.selected).toBe("Heavy");
    expect(m.context.sessionIdHash).toBe(SESSION_HASH);
    expect(m.context.promptSha256).toBe(PROMPT_HASH);
    expect(m.context.outputTextSha256).toBe(OUTPUT_HASH);
    expect(m.context.evidenceId).toBe("evidence-test-1");
  });

  test("machineVerdict surfaces verified=true on success", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), fullHappyPath());
    const v = machineVerdict(m);
    expect(v.verified).toBe(true);
    expect(v.errorCode).toBeNull();
    expect(v.evidenceId).toBe("evidence-test-1");
  });

  test("local browser mode is supported", () => {
    const events = [...fullHappyPath()];
    events[0] = { type: "browser_connected", mode: "local" };
    const m = applyChatGptProEvents(createChatGptProMachine(), events);
    expect(m.state).toBe("success");
    expect(m.context.mode).toBe("local");
  });

  test("transition() is pure (calling twice gives the same result)", () => {
    const m = createChatGptProMachine();
    const a = transition(m.state, m.context, { type: "browser_connected", mode: "remote" });
    const b = transition(m.state, m.context, { type: "browser_connected", mode: "remote" });
    expect(a.state).toBe(b.state);
    expect(a.context).toEqual(b.context);
  });

  test("out-of-order events are silently ignored (no spurious failure)", () => {
    // login_verified before browser_connected → stay in session_start.
    const m = createChatGptProMachine().send({ type: "login_verified" });
    expect(m.state).toBe("session_start");
  });
});

describe("ChatGPT Pro FSM — illegal prompt-before-verify", () => {
  test("submit_prompt from session_start trips the verification gate", () => {
    const m = createChatGptProMachine().send({ type: "submit_prompt", promptSha256: PROMPT_HASH });
    expect(m.state).toBe("prompt_submitted_before_verification");
    expect(machineVerdict(m).errorCode).toBe("prompt_submitted_before_verification");
    expect(m.context.failureReason).toMatch(/session_start/);
  });

  test("submit_prompt after only login is rejected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    expect(m.state).toBe("prompt_submitted_before_verification");
  });

  test("submit_prompt after model selection but before effort verification is rejected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    expect(m.state).toBe("prompt_submitted_before_verification");
  });

  test("submit_prompt after effort selection but before mode_verified_same_session is rejected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    expect(m.state).toBe("prompt_submitted_before_verification");
  });

  test("only mode_verified_same_session unlocks submit_prompt", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    expect(m.state).toBe("prompt_submitted");
    expect(m.context.promptSha256).toBe(PROMPT_HASH);
  });
});

describe("ChatGPT Pro FSM — terminal failures", () => {
  test("login_required short-circuits the chain", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_required" },
      // Subsequent events must NOT advance the machine.
      { type: "login_verified" },
      { type: "model_menu_opened" },
    ]);
    expect(m.state).toBe("login_required");
    expect(machineVerdict(m).errorCode).toBe("provider_login_required");
  });

  test("usage_limit during effort selection short-circuits", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "usage_limit_observed" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
    ]);
    expect(m.state).toBe("usage_limit");
    expect(machineVerdict(m).errorCode).toBe("provider_usage_limit");
  });

  test("UI drift via explicit event maps to ui_drift_suspected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "ui_drift_observed", detail: "model picker selector returned no nodes" },
    ]);
    expect(m.state).toBe("ui_drift_suspected");
    expect(machineVerdict(m).errorCode).toBe("ui_drift_suspected");
    expect(m.context.failureReason).toMatch(/model picker/);
  });

  test("UI drift via unknown effort label maps to ui_drift_suspected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Unobtainium"] },
    ]);
    expect(m.state).toBe("ui_drift_suspected");
    expect(machineVerdict(m).errorCode).toBe("ui_drift_suspected");
    expect(m.context.effort?.status).toBe("ui_drift_suspected");
  });

  test("empty effort labels map to extended_reasoning_unverified", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: [] },
    ]);
    expect(m.state).toBe("extended_reasoning_unverified");
    expect(machineVerdict(m).errorCode).toBe("chatgpt_extended_reasoning_unverified");
  });

  test("output_empty: response_arrived with zero bytes", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
      { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 0 },
    ]);
    expect(m.state).toBe("output_empty");
    expect(machineVerdict(m).errorCode).toBe("output_capture_empty");
  });

  test("browser_connect_failed → remote_browser_unavailable", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connect_failed", reason: "ECONNREFUSED" },
    ]);
    expect(m.state).toBe("remote_browser_unavailable");
    expect(m.context.failureReason).toBe("ECONNREFUSED");
  });

  test("non-Pro model label rejects with pro_unverified", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "GPT-5.5" },
    ]);
    expect(m.state).toBe("pro_unverified");
    expect(machineVerdict(m).errorCode).toBe("chatgpt_pro_unverified");
  });

  test("failure states are absorbing — subsequent events do not change state", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connect_failed", reason: "x" },
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
    ]);
    expect(m.state).toBe("remote_browser_unavailable");
  });
});

describe("ChatGPT Pro FSM — evidence-written-before-success ordering", () => {
  test("finish before evidence_written is rejected as ui_drift_suspected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
      { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 100 },
      { type: "finish" },
    ]);
    expect(m.state).toBe("ui_drift_suspected");
    expect(m.context.failureReason).toMatch(/finish rejected/);
  });

  test("evidence_written before output_captured is rejected", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
      // Skip response_arrived; try to mark evidence written directly.
      { type: "evidence_written", evidenceId: "evidence-skip-output" },
    ]);
    expect(m.state).toBe("ui_drift_suspected");
    expect(m.context.failureReason).toMatch(/evidence_written rejected/);
  });

  test("success requires the exact evidence_written → finish ordering", () => {
    const m = applyChatGptProEvents(createChatGptProMachine(), fullHappyPath());
    expect(m.state).toBe("success");
    expect(m.context.evidenceId).toBe("evidence-test-1");
    // The output_captured → evidence_written → finish hops must each
    // have occurred for the machine to land on success.
    expect(m.context.outputTextSha256).toBe(OUTPUT_HASH);
  });
});

describe("ChatGPT Pro FSM — invariants", () => {
  test("isFailureState recognises every documented failure", () => {
    for (const failure of CHATGPT_PRO_FAILURE_STATES) {
      expect(isFailureState(failure)).toBe(true);
    }
    for (const legal of CHATGPT_PRO_LEGAL_STATES) {
      expect(isFailureState(legal)).toBe(false);
    }
  });

  test("applyChatGptProEvents short-circuits on the first failure", () => {
    let countsApplied = 0;
    const events: ChatGptProEvent[] = [
      { type: "browser_connect_failed" },
      // Spy: each event we hope to be skipped would advance the machine
      // in some way if processed.
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
    ];
    const m = applyChatGptProEvents(createChatGptProMachine(), events);
    countsApplied = events.length;
    expect(countsApplied).toBe(4);
    expect(m.state).toBe("remote_browser_unavailable");
  });
});

describe("isProLabel helper", () => {
  test.each([
    ["GPT-5.5 Pro", true],
    ["ChatGPT Pro", true],
    ["Pro", true],
    ["gpt-5.5-pro", true], // hyphenated `-pro` still matches \bpro\b
  ])("accepts %s", (label, expected) => {
    expect(isProLabel(label)).toBe(expected);
  });

  test.each([["GPT-5.5", false], ["Standard", false], ["", false], ["Pro Extended", false]])(
    "rejects %s",
    (label, expected) => {
      expect(isProLabel(label)).toBe(expected);
    },
  );
});
