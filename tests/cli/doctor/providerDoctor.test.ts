import { describe, expect, test } from "vitest";
import {
  runChatGptDoctor,
  type ProviderProbeResult,
} from "../../../src/cli/commands/doctor/chatgpt.js";
import { runGeminiDoctor } from "../../../src/cli/commands/doctor/gemini.js";
import type { SessionMetadata } from "../../../src/sessionStore.js";

const passProbe =
  (code: string): (() => Promise<ProviderProbeResult>) =>
  async () => ({
    status: "pass",
    code,
    message: `${code} ok`,
  });

function session(provider: "chatgpt" | "gemini", status = "completed"): SessionMetadata {
  const model = provider === "gemini" ? "gemini-3-pro" : "gpt-5.2-pro";
  return {
    id: `${provider}-session`,
    createdAt: "2026-05-13T00:00:00.000Z",
    startedAt: "2026-05-13T00:01:00.000Z",
    completedAt: "2026-05-13T00:02:00.000Z",
    status,
    mode: "browser",
    model,
    options: {
      model,
      prompt: "doctor fixture",
      browserConfig: {
        desiredModel: provider === "gemini" ? "Gemini 3 Pro" : "GPT-5.2 Pro",
      },
    },
    browser: {
      runtime: {
        tabUrl: provider === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/",
        conversationId: `${provider}-conversation`,
      },
    },
  } as SessionMetadata;
}

function store(provider: "chatgpt" | "gemini", status = "completed") {
  return {
    listSessions: async () => [session(provider, status)],
  };
}

describe("ChatGPT provider doctor", () => {
  test("reports login required as a typed blocker", async () => {
    const result = await runChatGptDoctor({
      pro: true,
      extendedReasoning: true,
      sessionStore: store("chatgpt"),
      cookieSyncProbe: passProbe("cookie_sync_ok"),
      keytarProbe: passProbe("keytar_ok"),
      uiProbe: async () => ({ status: "login_required" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: "provider_login_required", status: "fail" }),
    ]);
    expect(result.fix_command).toContain("chatgpt.com");
  });

  test("reports UI drift without downgrading to an API route", async () => {
    const result = await runChatGptDoctor({
      sessionStore: store("chatgpt"),
      cookieSyncProbe: passProbe("cookie_sync_ok"),
      keytarProbe: passProbe("keytar_ok"),
      uiProbe: async () => ({
        status: "ui_drift_suspected",
        selectorManifestVersion: "chatgpt-pro-v1",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("chatgpt_ui_drift_suspected");
    expect(JSON.stringify(result)).not.toContain("engine api");
  });

  test("fails when required remote browser is unavailable", async () => {
    const result = await runChatGptDoctor({
      remoteBrowser: "required",
      sessionStore: store("chatgpt"),
      cookieSyncProbe: passProbe("cookie_sync_ok"),
      keytarProbe: passProbe("keytar_ok"),
      uiProbe: async () => ({ status: "remote_browser_unavailable" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("remote_browser_unavailable");
    expect(result.next_command).toBe("oracle remote doctor --json");
  });

  test("passes when protected mode and highest effort are verified", async () => {
    const output: string[] = [];
    const result = await runChatGptDoctor(
      {
        json: true,
        pro: true,
        extendedReasoning: true,
        sessionStore: store("chatgpt"),
        cookieSyncProbe: passProbe("cookie_sync_ok"),
        keytarProbe: passProbe("keytar_ok"),
        uiProbe: async () => ({
          status: "verified",
          observedModeLabel: "Pro",
          observedEffortLabel: "Heavy",
          effortRank: "highest_visible",
        }),
      },
      { stdout: (text) => output.push(text) },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
    expect(JSON.parse(output[0])).toMatchObject({ ok: true, provider: "chatgpt" });
  });

  test("blocks when the highest effort control is missing", async () => {
    const result = await runChatGptDoctor({
      sessionStore: store("chatgpt"),
      cookieSyncProbe: passProbe("cookie_sync_ok"),
      keytarProbe: passProbe("keytar_ok"),
      uiProbe: async () => ({ status: "missing_effort_control" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("missing_effort_control");
  });
});

describe("Gemini provider doctor", () => {
  test("reports login required when auth is unavailable", async () => {
    const result = await runGeminiDoctor({
      deepThink: true,
      sessionStore: store("gemini"),
      authProbe: async () => ({
        status: "fail",
        code: "provider_login_required",
        message: "Gemini auth missing",
      }),
      uiProbe: async () => ({ status: "verified" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("provider_login_required");
  });

  test("reports UI drift for Deep Think route checks", async () => {
    const result = await runGeminiDoctor({
      deepThink: true,
      sessionStore: store("gemini"),
      authProbe: passProbe("gemini_auth_ok"),
      uiProbe: async () => ({
        status: "ui_drift_suspected",
        selectorManifestVersion: "gemini-deep-think-v1",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("gemini_ui_drift_suspected");
  });

  test("fails when required remote browser is unavailable", async () => {
    const result = await runGeminiDoctor({
      remoteBrowser: "required",
      sessionStore: store("gemini"),
      authProbe: passProbe("gemini_auth_ok"),
      uiProbe: async () => ({ status: "remote_browser_unavailable" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("remote_browser_unavailable");
  });

  test("passes when auth, last session, and Deep Think controls are reachable", async () => {
    const result = await runGeminiDoctor({
      deepThink: true,
      env: { GEMINI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      sessionStore: store("gemini"),
      uiProbe: async () => ({
        status: "verified",
        observedModeLabel: "Gemini 3 Pro",
        observedEffortLabel: "Deep Think",
        effortRank: "highest_visible",
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.checks.map((check) => check.code)).toContain("gemini_api_key_configured");
    expect(result.checks.map((check) => check.code)).toContain("recent_provider_session_reachable");
  });

  test("blocks when Deep Think effort control is missing", async () => {
    const result = await runGeminiDoctor({
      deepThink: true,
      sessionStore: store("gemini"),
      authProbe: passProbe("gemini_auth_ok"),
      uiProbe: async () => ({ status: "missing_effort_control" }),
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.map((check) => check.code)).toContain("missing_effort_control");
  });
});
