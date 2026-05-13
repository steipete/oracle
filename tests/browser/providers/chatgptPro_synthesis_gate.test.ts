import { describe, expect, test } from "vitest";
import {
  ChatGptProSynthesisGateError,
  assertChatGptProSynthesisReady,
  planChatGptProSynthesisSubmission,
  type ChatGptProSynthesisGateInput,
  type ChatGptProSynthesisLiveTab,
} from "../../../src/browser/providers/chatgptPro_synthesis_gate.js";
import {
  applyChatGptProEvents,
  createChatGptProMachine,
  type ChatGptProMachine,
} from "../../../src/browser/providers/chatgptProVerification.js";

const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;
const OTHER_SESSION_HASH = `sha256:${"d".repeat(64)}` as const;

function verifiedMachine(): ChatGptProMachine {
  return applyChatGptProEvents(createChatGptProMachine(), [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
    { type: "effort_candidate_selected", observedEffortLabels: ["Standard", "Heavy"] },
    { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
  ]);
}

function liveProTab(overrides: Partial<ChatGptProSynthesisLiveTab> = {}) {
  return {
    targetId: "target-secret-1",
    url: "https://chatgpt.com/c/private-conversation-id",
    conversationId: "private-conversation-id",
    currentModelLabel: "GPT-5.5 Pro",
    authenticated: true,
    promptReady: true,
    sendExists: true,
    state: "completed",
    fingerprint: "fingerprint-secret-1",
    observedAt: "2026-05-12T12:00:01.000Z",
    ...overrides,
  } satisfies ChatGptProSynthesisLiveTab;
}

function readyInput(
  overrides: Partial<ChatGptProSynthesisGateInput> = {},
): ChatGptProSynthesisGateInput {
  return {
    slot: "chatgpt_pro_synthesis",
    providerFamily: "chatgpt",
    accessPath: "oracle_browser_remote",
    machine: verifiedMachine(),
    liveTab: liveProTab(),
    cookies: {
      appliedCount: 2,
      source: "chrome-profile",
    },
    session: {
      sessionIdHash: SESSION_HASH,
      liveSessionIdHash: SESSION_HASH,
      verifiedAt: "2026-05-12T12:00:00.000Z",
      lastActivityAt: "2026-05-12T12:00:15.000Z",
      now: "2026-05-12T12:00:30.000Z",
      staleAfterMs: 60_000,
      verifiedTargetId: "target-secret-1",
      liveTargetId: "target-secret-1",
    },
    ...overrides,
  };
}

describe("ChatGPT Pro synthesis pre-submit gate", () => {
  test("allows synthesis submission after same-session Pro tab, cookies, and fresh verification", () => {
    const decision = planChatGptProSynthesisSubmission(readyInput());

    expect(decision).toMatchObject({
      schema_version: "chatgpt_pro_synthesis_gate.v1",
      ok: true,
      status: "ready_to_submit",
      can_submit_prompt: true,
      slot: "chatgpt_pro_synthesis",
      verified_before_prompt_submit: true,
      mode_verified_same_session: true,
      selected_effort_is_highest_visible: true,
      live_pro_tab_verified: true,
      cookies_present: true,
      session_fresh: true,
    });
    expect(decision.evidence_provenance.session_id_hash).toBe(SESSION_HASH);
    expect(decision.evidence_provenance.cookie_count).toBe(2);
    expect(decision.evidence_provenance.cookie_source).toBe("chrome-profile");
    expect(decision.evidence_provenance.live_tab_url_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("https://chatgpt.com/c/private-conversation-id");
    expect(serialized).not.toContain("private-conversation-id");
    expect(serialized).not.toContain("target-secret-1");
    expect(serialized).not.toContain("fingerprint-secret-1");
  });

  test("rejects direct API substitution for chatgpt_pro_synthesis before prompt submission", () => {
    const decision = planChatGptProSynthesisSubmission(
      readyInput({
        providerFamily: "openai",
        accessPath: "openai_api",
      }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.can_submit_prompt).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "provider_result.provider_family",
          code: "chatgpt_pro_unverified",
        }),
        expect.objectContaining({
          field: "provider_result.access_path",
          code: "chatgpt_pro_unverified",
        }),
      ]),
    );
  });

  test("blocks when no live ChatGPT Pro tab is attached", () => {
    const noTab = planChatGptProSynthesisSubmission(readyInput({ liveTab: null }));
    expect(noTab.ok).toBe(false);
    expect(noTab.live_pro_tab_verified).toBe(false);
    expect(noTab.blockers).toContainEqual(
      expect.objectContaining({
        field: "browser.live_tab",
        code: "remote_browser_unavailable",
      }),
    );

    const nonProTab = planChatGptProSynthesisSubmission(
      readyInput({ liveTab: liveProTab({ currentModelLabel: "GPT-5.5" }) }),
    );
    expect(nonProTab.ok).toBe(false);
    expect(nonProTab.blockers).toContainEqual(
      expect.objectContaining({
        field: "browser.live_tab.current_model_label",
        code: "chatgpt_pro_unverified",
      }),
    );
  });

  test("blocks missing cookies and unauthenticated tabs with redacted cookie provenance", () => {
    const decision = planChatGptProSynthesisSubmission(
      readyInput({
        liveTab: liveProTab({ authenticated: false }),
        cookies: {
          appliedCount: 0,
          inlineCount: 0,
          source: "ORACLE_BROWSER_COOKIES_JSON=secret-cookie-value",
        },
      }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.cookies_present).toBe(false);
    expect(decision.evidence_provenance.cookie_source).toBe("[redacted]");
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "browser.live_tab.authenticated",
          code: "provider_login_required",
        }),
        expect.objectContaining({
          field: "browser.cookies",
          code: "provider_login_required",
        }),
      ]),
    );
    expect(JSON.stringify(decision)).not.toContain("secret-cookie-value");
  });

  test("blocks stale or mismatched same-session verification", () => {
    const stale = planChatGptProSynthesisSubmission(
      readyInput({
        session: {
          sessionIdHash: SESSION_HASH,
          liveSessionIdHash: SESSION_HASH,
          verifiedAt: "2026-05-12T12:00:00.000Z",
          lastActivityAt: "2026-05-12T12:00:00.000Z",
          now: "2026-05-12T12:10:01.000Z",
          staleAfterMs: 60_000,
          verifiedTargetId: "target-secret-1",
          liveTargetId: "target-secret-1",
        },
      }),
    );
    expect(stale.ok).toBe(false);
    expect(stale.session_fresh).toBe(false);
    expect(stale.blockers).toContainEqual(
      expect.objectContaining({
        field: "browser.session.freshness",
        code: "prompt_submitted_before_verification",
      }),
    );

    const mismatch = planChatGptProSynthesisSubmission(
      readyInput({
        session: {
          sessionIdHash: SESSION_HASH,
          liveSessionIdHash: OTHER_SESSION_HASH,
          verifiedAt: "2026-05-12T12:00:00.000Z",
          lastActivityAt: "2026-05-12T12:00:30.000Z",
          now: "2026-05-12T12:00:31.000Z",
          staleAfterMs: 60_000,
          verifiedTargetId: "target-secret-1",
          liveTargetId: "target-secret-2",
        },
      }),
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "browser.session.live_session_id_hash" }),
        expect.objectContaining({ field: "browser.session.live_target_id" }),
      ]),
    );
  });

  test("blocks prompt-before-verify machine states and exposes typed assert failures", () => {
    const preVerify = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
    ]);

    const decision = planChatGptProSynthesisSubmission(
      readyInput({
        machine: preVerify,
        session: {
          sessionIdHash: null,
          liveSessionIdHash: null,
          verifiedAt: "2026-05-12T12:00:00.000Z",
          now: "2026-05-12T12:00:01.000Z",
        },
      }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.blockers).toContainEqual(
      expect.objectContaining({
        field: "chatgpt_pro.same_session_verification",
        code: "prompt_submitted_before_verification",
      }),
    );
    expect(() => assertChatGptProSynthesisReady(readyInput({ machine: preVerify }))).toThrow(
      ChatGptProSynthesisGateError,
    );
  });
});
