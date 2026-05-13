import { describe, expect, test } from "vitest";

import {
  applyChatGptProEvents,
  createChatGptProMachine,
  machineVerdict,
} from "../../src/browser/providers/chatgptProVerification.js";
import {
  applyGeminiDeepThinkEvents,
  createGeminiDeepThinkMachine,
  geminiDeepThinkMachineVerdict,
} from "../../src/browser/providers/geminiDeepThink_verification.js";
import {
  FIXTURE_OUTPUT_HASH,
  FIXTURE_PROMPT_HASH,
  FIXTURE_SESSION_HASH,
  chatGptEventsFromFixture,
  extractChatGptModeProbe,
  extractGeminiModeProbe,
  geminiEventsFromFixture,
  loadBrowserFixture,
} from "../_helpers/browserFixture.js";

const CONFORMANCE_REQUIREMENTS = [
  {
    id: "chatgpt-pro-success",
    level: "MUST",
    fixture: "chatgpt/pro-heavy-success",
    expectation: "ChatGPT Pro + highest-visible effort reaches success.",
  },
  {
    id: "chatgpt-wrong-mode",
    level: "MUST",
    fixture: "chatgpt/wrong-mode",
    expectation: "Wrong ChatGPT model is a typed Pro verification failure.",
  },
  {
    id: "chatgpt-effort-ui-drift",
    level: "MUST",
    fixture: "chatgpt/effort-ui-drift",
    expectation: "Unknown effort labels surface ui_drift_suspected.",
  },
  {
    id: "chatgpt-missing-effort-control",
    level: "MUST",
    fixture: "chatgpt/missing-effort-control",
    expectation: "Missing effort controls do not unlock prompt submission.",
  },
  {
    id: "gemini-deep-think-success",
    level: "MUST",
    fixture: "gemini/deep-think-success",
    expectation: "Gemini Deep Think selected without thinking control reaches success.",
  },
  {
    id: "gemini-control-missing",
    level: "MUST",
    fixture: "gemini/control-missing",
    expectation: "Missing Deep Think control is a typed Gemini verification failure.",
  },
  {
    id: "gemini-verified-false",
    level: "MUST",
    fixture: "gemini/verified-false",
    expectation: "Visible but unselected Deep Think does not verify.",
  },
  {
    id: "gemini-high-thinking-control",
    level: "SHOULD",
    fixture: "gemini/high-thinking-control",
    expectation: "When Gemini exposes thinking-level controls, high is selected.",
  },
] as const;

describe("browser mode verification fixture conformance matrix", () => {
  test("every requirement has a captured HTML fixture", async () => {
    const covered = new Set<string>();
    for (const row of CONFORMANCE_REQUIREMENTS) {
      const [provider, fixture] = row.fixture.split("/") as ["chatgpt" | "gemini", string];
      const snapshot = await loadBrowserFixture(provider, fixture);
      expect(snapshot.coverage).toContain(row.id);
      covered.add(row.id);
    }

    const mustCount = CONFORMANCE_REQUIREMENTS.filter((row) => row.level === "MUST").length;
    const testedMustCount = CONFORMANCE_REQUIREMENTS.filter(
      (row) => row.level === "MUST" && covered.has(row.id),
    ).length;
    expect(testedMustCount / mustCount).toBe(1);
  });
});

describe("ChatGPT fixture-driven mode verification", () => {
  test("Pro + highest-visible effort snapshot reaches success and writes evidence after prompt", async () => {
    const snapshot = await loadBrowserFixture("chatgpt", "pro-heavy-success");
    const probe = extractChatGptModeProbe(snapshot);
    const machine = applyChatGptProEvents(
      createChatGptProMachine(),
      chatGptEventsFromFixture(probe, { includePromptRun: true }),
    );

    expect(machine.state).toBe("success");
    expect(machine.context.modelLabel).toBe("GPT-5.5 Pro");
    expect(machine.context.effort).toMatchObject({
      status: "verified",
      selected: "Heavy",
      tier: "heavy",
      selectedIsHighestVisible: true,
    });
    expect(machine.context.sessionIdHash).toBe(FIXTURE_SESSION_HASH);
    expect(machine.context.promptSha256).toBe(FIXTURE_PROMPT_HASH);
    expect(machine.context.outputTextSha256).toBe(FIXTURE_OUTPUT_HASH);
    expect(machineVerdict(machine)).toMatchObject({
      verified: true,
      errorCode: null,
      evidenceId: "fixture-chatgpt-evidence",
    });
  });

  test("same snapshot rejects prompt submission before same-session verification", async () => {
    const snapshot = await loadBrowserFixture("chatgpt", "pro-heavy-success");
    const probe = extractChatGptModeProbe(snapshot);
    const events = chatGptEventsFromFixture(probe).slice(0, 5);
    const machine = applyChatGptProEvents(createChatGptProMachine(), [
      ...events,
      { type: "submit_prompt", promptSha256: FIXTURE_PROMPT_HASH },
    ]);

    expect(machine.state).toBe("prompt_submitted_before_verification");
    expect(machineVerdict(machine).errorCode).toBe("prompt_submitted_before_verification");
  });

  test("wrong mode snapshot fails closed with chatgpt_pro_unverified", async () => {
    const snapshot = await loadBrowserFixture("chatgpt", "wrong-mode");
    const machine = applyChatGptProEvents(
      createChatGptProMachine(),
      chatGptEventsFromFixture(extractChatGptModeProbe(snapshot)),
    );

    expect(machine.state).toBe("pro_unverified");
    expect(machineVerdict(machine)).toMatchObject({
      verified: false,
      errorCode: "chatgpt_pro_unverified",
    });
    expect(machine.context.failureReason).toMatch(/not a recognised Pro candidate/);
  });

  test("unknown effort labels snapshot surfaces ui_drift_suspected", async () => {
    const snapshot = await loadBrowserFixture("chatgpt", "effort-ui-drift");
    const machine = applyChatGptProEvents(
      createChatGptProMachine(),
      chatGptEventsFromFixture(extractChatGptModeProbe(snapshot)),
    );

    expect(machine.state).toBe("ui_drift_suspected");
    expect(machine.context.effort?.status).toBe("ui_drift_suspected");
    expect(machine.context.effort?.observedLabels).toEqual([
      "Quantum Ultra",
      "Nebula Reasoning",
    ]);
    expect(machineVerdict(machine).errorCode).toBe("ui_drift_suspected");
  });

  test("missing effort control snapshot blocks before mode verification", async () => {
    const snapshot = await loadBrowserFixture("chatgpt", "missing-effort-control");
    const machine = applyChatGptProEvents(
      createChatGptProMachine(),
      chatGptEventsFromFixture(extractChatGptModeProbe(snapshot)),
    );

    expect(machine.state).toBe("extended_reasoning_unverified");
    expect(machine.context.effort?.status).toBe("unverified");
    expect(machineVerdict(machine).errorCode).toBe("chatgpt_extended_reasoning_unverified");
  });
});

describe("Gemini fixture-driven mode verification", () => {
  test("Deep Think snapshot reaches success without an exposed thinking-level control", async () => {
    const snapshot = await loadBrowserFixture("gemini", "deep-think-success");
    const probe = extractGeminiModeProbe(snapshot);
    const machine = applyGeminiDeepThinkEvents(
      createGeminiDeepThinkMachine(),
      geminiEventsFromFixture(probe, { includePromptRun: true }),
    );

    expect(machine.state).toBe("success");
    expect(machine.context.modelLabel).toBe("Gemini 3 Pro");
    expect(machine.context.deepThink).toMatchObject({
      status: "verified",
      selected: "Deep Think",
      tier: "deep_think",
      thinkingLevelControlExposed: false,
      selectedIsHighestVisible: true,
    });
    expect(machine.context.sessionIdHash).toBe(FIXTURE_SESSION_HASH);
    expect(machine.context.promptSha256).toBe(FIXTURE_PROMPT_HASH);
    expect(machine.context.outputTextSha256).toBe(FIXTURE_OUTPUT_HASH);
    expect(geminiDeepThinkMachineVerdict(machine)).toMatchObject({
      verified: true,
      errorCode: null,
      evidenceId: "fixture-gemini-evidence",
    });
  });

  test("same Gemini snapshot rejects prompt submission before Deep Think verification", async () => {
    const snapshot = await loadBrowserFixture("gemini", "deep-think-success");
    const probe = extractGeminiModeProbe(snapshot);
    const events = geminiEventsFromFixture(probe).slice(0, 5);
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      ...events,
      { type: "submit_prompt", promptSha256: FIXTURE_PROMPT_HASH },
    ]);

    expect(machine.state).toBe("prompt_submitted_before_verification");
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe(
      "prompt_submitted_before_verification",
    );
  });

  test("missing Deep Think control snapshot fails with gemini_deep_think_unverified", async () => {
    const snapshot = await loadBrowserFixture("gemini", "control-missing");
    const machine = applyGeminiDeepThinkEvents(
      createGeminiDeepThinkMachine(),
      geminiEventsFromFixture(extractGeminiModeProbe(snapshot)),
    );

    expect(machine.state).toBe("deep_think_unverified");
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe(
      "gemini_deep_think_unverified",
    );
    expect(machine.context.failureReason).toMatch(/does not verify Deep Think/);
  });

  test("visible but unselected Deep Think snapshot does not verify", async () => {
    const snapshot = await loadBrowserFixture("gemini", "verified-false");
    const machine = applyGeminiDeepThinkEvents(
      createGeminiDeepThinkMachine(),
      geminiEventsFromFixture(extractGeminiModeProbe(snapshot)),
    );

    expect(machine.state).toBe("deep_think_unverified");
    expect(machine.context.deepThink?.deepThinkLabel).toBe("Canvas");
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe(
      "gemini_deep_think_unverified",
    );
  });

  test("high-if-exposed thinking-level snapshot verifies the highest visible option", async () => {
    const snapshot = await loadBrowserFixture("gemini", "high-thinking-control");
    const probe = extractGeminiModeProbe(snapshot);
    const machine = applyGeminiDeepThinkEvents(
      createGeminiDeepThinkMachine(),
      geminiEventsFromFixture(probe, { includePromptRun: true }),
    );

    expect(machine.state).toBe("success");
    expect(machine.context.deepThink).toMatchObject({
      status: "verified",
      selected: "high",
      tier: "high",
      thinkingLevelControlExposed: true,
      thinkingLevelVerified: true,
      selectedIsHighestVisible: true,
    });
    expect(machine.context.deepThink?.observedLabels).toEqual([
      "Deep Think",
      "standard",
      "high",
    ]);
  });
});
