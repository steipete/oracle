import { describe, expect, test } from "vitest";

import {
  CHATGPT_PRO_FAILURE_STATES,
  CHATGPT_PRO_LEGAL_STATES,
  applyChatGptProEvents,
  createChatGptProMachine,
  errorCodeForFailure,
  machineVerdict,
  type ChatGptProMachine,
} from "../../../src/browser/providers/chatgptProVerification.js";
import {
  applyCdpDisconnectDecision,
  reattachBudgetExhaustedEvent,
  sessionLostEventFromProLongWaitDecision,
} from "../../../src/browser/providers/chatgptPro_cdp_disconnect.js";
import { decideProLongWait } from "../../../src/browser/output-capture/proLongWait.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"b".repeat(64)}` as const;
const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;
const REATTACHED_SESSION_HASH = `sha256:${"d".repeat(64)}` as const;

function verifiedMachine(): ChatGptProMachine {
  return applyChatGptProEvents(createChatGptProMachine(), [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
    { type: "effort_candidate_selected", observedEffortLabels: ["Heavy", "Pro Extended"] },
    { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
  ]);
}

function submittedMachine(): ChatGptProMachine {
  return verifiedMachine().send({ type: "submit_prompt", promptSha256: PROMPT_HASH });
}

describe("ChatGPT Pro CDP disconnect FSM recovery", () => {
  test("taxonomy includes the recoverable reattach state and terminal mid-run failure", () => {
    expect(CHATGPT_PRO_LEGAL_STATES).toContain("reattach_pending");
    expect(CHATGPT_PRO_FAILURE_STATES).toContain("remote_browser_unavailable_mid_run");
    expect(errorCodeForFailure("remote_browser_unavailable_mid_run")).toBe(
      "remote_browser_unavailable",
    );
  });

  test("maps proLongWait needs_reattach into session_lost and resumes response waiting", () => {
    const submitted = submittedMachine();
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 10 * 60 * 1000,
      state: "thinking",
      sessionIsReattachable: true,
      sessionId: "session-zwd",
      budgetMs: 10 * 60 * 1000,
    });

    const event = sessionLostEventFromProLongWaitDecision(decision);

    expect(decision.kind).toBe("reattach");
    expect(event).toMatchObject({
      type: "session_lost",
      recoveryCommand: "oracle session session-zwd --render",
    });

    const pending = applyCdpDisconnectDecision(submitted, decision);
    expect(pending.state).toBe("reattach_pending");
    expect(pending.context.stateBeforeReattach).toBe("prompt_submitted");
    expect(pending.context.reattachRecoveryCommand).toBe(
      "oracle session session-zwd --render",
    );
    expect(pending.context.failureReason).toContain("oracle session session-zwd --render");

    const resumed = pending.send({
      type: "reattach_succeeded",
      sessionIdHash: REATTACHED_SESSION_HASH,
    });
    expect(resumed.state).toBe("response_waiting");
    expect(resumed.context.sessionIdHash).toBe(REATTACHED_SESSION_HASH);
    expect(resumed.context.failureReason).toBeNull();
    expect(resumed.context.reattachRecoveryCommand).toBeNull();

    const completed = applyChatGptProEvents(resumed, [
      { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 123 },
      { type: "evidence_written", evidenceId: "evidence-zwd" },
      { type: "finish" },
    ]);
    expect(completed.state).toBe("success");
    expect(machineVerdict(completed).errorCode).toBeNull();
  });

  test("budget exhaustion from reattach_pending becomes remote_browser_unavailable_mid_run", () => {
    const pending = submittedMachine().send({
      type: "session_lost",
      reason: "CDP target closed",
      recoveryCommand: "oracle session session-zwd --render",
    });

    const failed = pending.send(reattachBudgetExhaustedEvent("reattach budget elapsed"));

    expect(failed.state).toBe("remote_browser_unavailable_mid_run");
    expect(machineVerdict(failed).errorCode).toBe("remote_browser_unavailable");
    expect(failed.context.failureReason).toBe("reattach budget elapsed");
  });

  test("submit_prompt stays rejected after partial reconnect that has not re-verified mode", () => {
    const pending = verifiedMachine().send({
      type: "session_lost",
      reason: "target detached before prompt",
      recoveryCommand: "oracle session session-zwd --render",
    });

    const partialReconnect = pending.send({ type: "browser_connected", mode: "remote" });
    expect(partialReconnect.state).toBe("reattach_pending");

    const attemptedSubmit = partialReconnect.send({
      type: "submit_prompt",
      promptSha256: PROMPT_HASH,
    });
    expect(attemptedSubmit.state).toBe("prompt_submitted_before_verification");
    expect(machineVerdict(attemptedSubmit).errorCode).toBe(
      "prompt_submitted_before_verification",
    );
    expect(attemptedSubmit.context.failureReason).toContain("reattach_pending");
  });
});
