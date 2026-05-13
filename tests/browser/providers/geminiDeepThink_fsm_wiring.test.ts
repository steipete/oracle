// Regression suite for oracle-svt: the production Gemini Deep Think
// DOM provider must drive every adapter call through the verification
// FSM in src/browser/state/geminiDeepThink.ts. The CRITICAL invariant:
// `submitPrompt` cannot reach the underlying adapter (the real
// `btn.click()` inside src/browser/providers/geminiDeepThinkDomProvider.ts)
// unless the machine has reached `deep_think_verified_same_session`.
//
// These tests use a faked ProviderDomAdapter so we can prove the
// wrapper's contract without touching Chrome — every call is observed,
// every transition is asserted.

import { describe, expect, it } from "vitest";

import type {
  ProviderDomAdapter,
  ProviderDomFlowContext,
  ProviderDomResponse,
} from "../../../src/browser/providerDomFlow.js";
import {
  GeminiDeepThinkFsmError,
  geminiDeepThinkDomProviderWithFsm,
  wireGeminiDeepThinkFsm,
} from "../../../src/browser/providers/geminiDeepThinkDomProvider.js";
import {
  GEMINI_DEEP_THINK_FAILURE_STATES,
  GEMINI_DEEP_THINK_LEGAL_STATES,
} from "../../../src/browser/state/geminiDeepThink.js";
import type {
  GeminiDeepThinkMachine,
  GeminiDeepThinkState,
} from "../../../src/browser/state/geminiDeepThink.js";

interface FakeAdapterCalls {
  waitForUi: number;
  selectMode: number;
  typePrompt: number;
  submitPrompt: number;
  waitForResponse: number;
  extractThoughts: number;
}

interface FakeAdapterOptions {
  waitForUiThrows?: Error;
  selectModeThrows?: Error;
  responseText?: string;
}

function makeFakeAdapter(options: FakeAdapterOptions = {}): {
  adapter: ProviderDomAdapter;
  calls: FakeAdapterCalls;
} {
  const calls: FakeAdapterCalls = {
    waitForUi: 0,
    selectMode: 0,
    typePrompt: 0,
    submitPrompt: 0,
    waitForResponse: 0,
    extractThoughts: 0,
  };
  const adapter: ProviderDomAdapter = {
    providerName: "gemini-web-fake",
    waitForUi: async () => {
      calls.waitForUi += 1;
      if (options.waitForUiThrows) throw options.waitForUiThrows;
    },
    selectMode: async () => {
      calls.selectMode += 1;
      if (options.selectModeThrows) throw options.selectModeThrows;
    },
    typePrompt: async () => {
      calls.typePrompt += 1;
    },
    submitPrompt: async () => {
      calls.submitPrompt += 1;
    },
    waitForResponse: async (): Promise<ProviderDomResponse> => {
      calls.waitForResponse += 1;
      return { text: options.responseText ?? "deep think response" };
    },
    extractThoughts: async () => {
      calls.extractThoughts += 1;
      return null;
    },
  };
  return { adapter, calls };
}

function makeCtx(overrides: Partial<ProviderDomFlowContext> = {}): ProviderDomFlowContext {
  const evaluate: ProviderDomFlowContext["evaluate"] = async <T>(
    _expr: string,
  ): Promise<T | undefined> => undefined;
  const delay: ProviderDomFlowContext["delay"] = async (_ms: number): Promise<void> => {};
  const log: ProviderDomFlowContext["log"] = () => {};
  return {
    prompt: "hello deep think",
    evaluate,
    delay,
    log,
    ...overrides,
  };
}

describe("wireGeminiDeepThinkFsm — adapter wrapper invariants (oracle-svt)", () => {
  it("happy path drives the FSM into output_captured_nonempty", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await wired.waitForResponse(ctx);

    expect(calls.waitForUi).toBe(1);
    expect(calls.selectMode).toBe(1);
    expect(calls.typePrompt).toBe(1);
    expect(calls.submitPrompt).toBe(1);
    expect(calls.waitForResponse).toBe(1);

    const verdict = wired.getVerdict();
    expect(verdict.verified).toBe(false); // success requires evidence_written + finish
    expect(verdict.errorCode).toBeNull();
    expect(verdict.state).toBe<GeminiDeepThinkState>("output_captured_nonempty");
  });

  it("CRITICAL: submitPrompt without selectMode never invokes the underlying adapter", async () => {
    // This is the heart of the bug oracle-svt addresses: the live
    // executor previously called the bare provider directly, so a UI
    // drift that bypassed Deep Think activation could still click the
    // send button. The wrapper MUST gate the click.
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    // Deliberately skip selectMode — the FSM is now in `login_verified`,
    // not `deep_think_verified_same_session`.
    await wired.typePrompt(ctx);

    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);
    // The underlying adapter's submitPrompt must NOT have been called.
    expect(calls.submitPrompt, "underlying submitPrompt was invoked").toBe(0);

    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("prompt_submitted_before_verification");
    expect(verdict.errorCode).toBe("prompt_submitted_before_verification");
  });

  it("login-style error during waitForUi lands FSM in login_required", async () => {
    const { adapter, calls } = makeFakeAdapter({
      waitForUiThrows: new Error(
        "Gemini is showing a sign-in flow. Please sign in in Chrome and retry.",
      ),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await expect(wired.waitForUi(ctx)).rejects.toThrow(/sign-in flow/);
    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("login_required");
    expect(verdict.errorCode).toBe("provider_login_required");
    expect(calls.selectMode + calls.submitPrompt).toBe(0);
  });

  it("non-login waitForUi failure lands FSM in ui_drift_suspected", async () => {
    const { adapter } = makeFakeAdapter({
      waitForUiThrows: new Error("Timed out waiting for Gemini UI prompt input to become ready."),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    await expect(wired.waitForUi(makeCtx())).rejects.toThrow(/Timed out/);
    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("ui_drift_suspected");
    expect(verdict.errorCode).toBe("ui_drift_suspected");
  });

  it("selectMode failure lands FSM in ui_drift_suspected and gates submitPrompt", async () => {
    const { adapter, calls } = makeFakeAdapter({
      selectModeThrows: new Error('Unable to select "Deep Think" from Gemini tools menu.'),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await expect(wired.selectMode!(ctx)).rejects.toThrow(/Deep Think/);
    expect(wired.getVerdict().state).toBe<GeminiDeepThinkState>("ui_drift_suspected");

    // Even though the wrapper is in a failure state, the test confirms
    // that submitPrompt does NOT silently call the underlying click.
    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);
    expect(calls.submitPrompt).toBe(0);
  });

  it("empty response transitions FSM to output_empty failure", async () => {
    const { adapter } = makeFakeAdapter({ responseText: "" });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await expect(wired.waitForResponse(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);

    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("output_empty");
    expect(verdict.errorCode).toBe("output_capture_empty");
  });

  it("onTransition observer fires after each FSM transition", async () => {
    const transitions: GeminiDeepThinkState[] = [];
    const { adapter } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter, {
      onTransition: (m: GeminiDeepThinkMachine) => transitions.push(m.state),
    });
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await wired.waitForResponse(ctx);

    // The exact transition list — proves we walk every state on the
    // happy path through the legal-state ladder.
    expect(transitions).toEqual([
      "remote_or_local_browser_connected",
      "login_verified",
      "gemini_model_candidate_selected",
      "deep_think_menu_open",
      "deep_think_candidate_selected",
      "deep_think_verified_same_session",
      "prompt_submitted",
      "response_streaming",
      "output_captured_nonempty",
    ] satisfies GeminiDeepThinkState[]);
  });

  it("geminiDeepThinkDomProviderWithFsm() returns a fresh machine each call", () => {
    const a = geminiDeepThinkDomProviderWithFsm();
    const b = geminiDeepThinkDomProviderWithFsm();
    expect(a.getMachine()).not.toBe(b.getMachine());
    expect(a.getMachine().state).toBe<GeminiDeepThinkState>("session_start");
    expect(b.getMachine().state).toBe<GeminiDeepThinkState>("session_start");
    // Both must implement the public ProviderDomAdapter contract.
    expect(a.providerName).toBe("gemini-web");
    expect(typeof a.submitPrompt).toBe("function");
  });

  it("FSM state types match the source-of-truth state list", () => {
    // Belt-and-suspenders: catches drift between this test's expected
    // transitions and the FSM's legal/failure lists.
    expect(GEMINI_DEEP_THINK_LEGAL_STATES).toContain("deep_think_verified_same_session");
    expect(GEMINI_DEEP_THINK_LEGAL_STATES).toContain("output_captured_nonempty");
    expect(GEMINI_DEEP_THINK_FAILURE_STATES).toContain("prompt_submitted_before_verification");
    expect(GEMINI_DEEP_THINK_FAILURE_STATES).toContain("output_empty");
  });
});
