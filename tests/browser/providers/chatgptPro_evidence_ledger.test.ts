// Tests for the ChatGPT Pro ↔ evidence-ledger driver (oracle-6qi).
//
// Drives the real FSM (oracle-php) + the real ledger module
// (oracle-jfq sub-piece 1) against a per-test temp directory. The
// driver is the only new code under test; both downstream modules are
// treated as black boxes.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendEvidenceLedgerEvent,
  readEvidenceLedger,
} from "../../../src/oracle/evidence_ledger.js";
import { startChatGptProLedger } from "../../../src/browser/providers/chatgptProLedgerDriver.js";
import {
  applyChatGptProEvents,
  createChatGptProMachine,
  type ChatGptProEvent,
} from "../../../src/browser/providers/chatgptProVerification.js";
import type { ChatGptProLedgerDriver } from "../../../src/browser/providers/chatgptProLedgerDriver.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const PROMPT_HASH = `sha256:${"a".repeat(63)}1` as const;
const OUTPUT_HASH = `sha256:${"b".repeat(63)}1` as const;
const SESSION_HASH = `sha256:${"c".repeat(63)}1` as const;
const SESSION_ID = "session-fsm-ledger-test";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-fsm-ledger-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function drive(
  driver: ChatGptProLedgerDriver,
  events: readonly ChatGptProEvent[],
): Promise<ChatGptProLedgerDriver> {
  let current = driver;
  for (const event of events) {
    const step = await current.sendWithLedger(event);
    current = step.driver;
  }
  return current;
}

const HAPPY_PATH: readonly ChatGptProEvent[] = [
  { type: "browser_connected", mode: "remote" },
  { type: "login_verified" },
  { type: "model_menu_opened" },
  { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
  { type: "effort_candidate_selected", observedEffortLabels: ["Heavy", "Pro Extended"] },
  { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
  { type: "submit_prompt", promptSha256: PROMPT_HASH },
  { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 4096 },
  { type: "evidence_written", evidenceId: "evidence-fsm-1" },
  { type: "finish" },
];

describe("startChatGptProLedger — bootstrap", () => {
  testNonWindows("appends a session_started entry on construction", async () => {
    const machine = createChatGptProMachine();
    await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0].event.type).toBe("session_started");
    expect(read.entries[0].event.provider_slot).toBe("chatgpt_pro_first_plan");
  });
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("sendWithLedger — happy path", () => {
  testNonWindows("produces 8 milestone ledger entries in canonical order", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    const final = await drive(driver, HAPPY_PATH);
    expect(final.machine.state).toBe("success");

    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    const types = read.entries.map((e) => e.event.type);
    // session_started + 7 milestone transitions = 8 ledger entries.
    // The exact 8 sequence: session_started → browser_attached →
    // login_verified → mode_verified_same_session → prompt_submitted →
    // response_arrived → evidence_written → run_completed.
    expect(types).toEqual([
      "session_started",
      "browser_attached",
      "login_verified",
      "mode_verified_same_session",
      "prompt_submitted",
      "response_arrived",
      "evidence_written",
      "run_completed",
    ]);
  });

  testNonWindows("intermediate FSM states (model menu, pro candidate, effort) do NOT add entries", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, HAPPY_PATH);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.entries).toHaveLength(8);
    // Confirm none of the intermediate-state event types snuck in.
    const types = new Set(read.entries.map((e) => e.event.type));
    expect(types.has("evidence_quarantined")).toBe(false);
  });

  testNonWindows("ledger metadata captures session_id_hash, prompt_sha256, output_text_sha256", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, HAPPY_PATH);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const byType = Object.fromEntries(read.entries.map((e) => [e.event.type, e.event]));
    expect((byType.mode_verified_same_session.metadata as Record<string, unknown>).session_id_hash).toBe(
      SESSION_HASH,
    );
    expect((byType.prompt_submitted.metadata as Record<string, unknown>).prompt_sha256).toBe(
      PROMPT_HASH,
    );
    expect((byType.response_arrived.metadata as Record<string, unknown>).output_text_sha256).toBe(
      OUTPUT_HASH,
    );
    expect((byType.response_arrived.metadata as Record<string, unknown>).output_bytes).toBe(4096);
  });

  testNonWindows("evidence_written entry carries the evidence_id", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, HAPPY_PATH);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const evidenceEntry = read.entries.find((e) => e.event.type === "evidence_written");
    expect(evidenceEntry?.event.evidence_id).toBe("evidence-fsm-1");
    const runCompleted = read.entries.find((e) => e.event.type === "run_completed");
    expect(runCompleted?.event.evidence_id).toBe("evidence-fsm-1");
  });

  testNonWindows("chain is contiguous and verifiable end-to-end", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, HAPPY_PATH);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.chainFailure).toBeNull();
    for (let i = 1; i < read.entries.length; i++) {
      expect(read.entries[i].sequence).toBe(i);
      expect(read.entries[i].prev_hash).toBe(read.entries[i - 1].entry_hash);
    }
  });
});

// ─── Failure paths ──────────────────────────────────────────────────────────

describe("sendWithLedger — failure paths produce run_failed with v18 error code", () => {
  testNonWindows("login_required → run_failed with provider_login_required", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [
      { type: "browser_connected", mode: "remote" },
      { type: "login_required" },
    ]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const failure = read.entries.find((e) => e.event.type === "run_failed");
    expect(failure).toBeDefined();
    expect((failure!.event.metadata as Record<string, unknown>).error_code).toBe(
      "provider_login_required",
    );
    expect((failure!.event.metadata as Record<string, unknown>).fsm_state).toBe("login_required");
  });

  testNonWindows("UI drift via unknown effort → run_failed with ui_drift_suspected", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Unobtainium"] },
    ]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const failure = read.entries.find((e) => e.event.type === "run_failed");
    expect(failure).toBeDefined();
    expect((failure!.event.metadata as Record<string, unknown>).error_code).toBe(
      "ui_drift_suspected",
    );
  });

  testNonWindows("empty effort labels → run_failed with chatgpt_extended_reasoning_unverified", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: [] },
    ]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const failure = read.entries.find((e) => e.event.type === "run_failed");
    expect((failure!.event.metadata as Record<string, unknown>).error_code).toBe(
      "chatgpt_extended_reasoning_unverified",
    );
  });

  testNonWindows("zero-byte response → run_failed with output_capture_empty", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
      { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
      { type: "response_arrived", outputTextSha256: OUTPUT_HASH, bytesLength: 0 },
    ]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const failure = read.entries.find((e) => e.event.type === "run_failed");
    expect((failure!.event.metadata as Record<string, unknown>).error_code).toBe(
      "output_capture_empty",
    );
  });

  testNonWindows("illegal prompt-before-verify → run_failed with prompt_submitted_before_verification", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const failure = read.entries.find((e) => e.event.type === "run_failed");
    expect((failure!.event.metadata as Record<string, unknown>).error_code).toBe(
      "prompt_submitted_before_verification",
    );
  });
});

// ─── Driver invariants ──────────────────────────────────────────────────────

describe("driver invariants", () => {
  testNonWindows("noop events do not extend the ledger", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    // Send an out-of-order event — FSM stays in session_start, ledger
    // should not gain an entry beyond the initial session_started.
    const after = await driver.sendWithLedger({ type: "login_verified" });
    expect(after.appended.skipped).toBe(true);
    expect(after.appended.skipReason).toBe("noop transition");
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.entries).toHaveLength(1);
  });

  testNonWindows("intermediate FSM transitions return appended.skipped=true", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    const a = await driver.sendWithLedger({ type: "browser_connected", mode: "remote" });
    expect(a.appended.skipped).toBe(false);
    const b = await a.driver.sendWithLedger({ type: "login_verified" });
    expect(b.appended.skipped).toBe(false);
    const c = await b.driver.sendWithLedger({ type: "model_menu_opened" });
    // model_menu_opened is intermediate — no ledger entry.
    expect(c.appended.skipped).toBe(true);
    expect(c.appended.skipReason).toBe("intermediate state");
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const types = read.entries.map((e) => e.event.type);
    expect(types).toEqual(["session_started", "browser_attached", "login_verified"]);
  });

  testNonWindows("failure states are absorbing — subsequent events do not double-log run_failed", async () => {
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    const final = await drive(driver, [
      { type: "browser_connect_failed", reason: "ECONNREFUSED" },
      // These should not advance the FSM and should NOT add ledger entries.
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
    ]);
    expect(final.machine.state).toBe("remote_browser_unavailable");
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    const runFailedEntries = read.entries.filter((e) => e.event.type === "run_failed");
    expect(runFailedEntries).toHaveLength(1);
  });

  testNonWindows("driver respects pre-existing entries (chains from current tail)", async () => {
    // Simulate a session that already has manually-appended bootstrap
    // entries; driver must chain from the current tail, not from genesis.
    await appendEvidenceLedgerEvent(
      SESSION_ID,
      { type: "session_started", metadata: { source: "external-bootstrap" } },
      { homeDir },
    );
    const machine = createChatGptProMachine();
    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    await drive(driver, [{ type: "browser_connected", mode: "remote" }]);
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(3); // bootstrap + driver's session_started + browser_attached
    // The driver's session_started chains to the bootstrap, not genesis.
    expect(read.entries[1].prev_hash).toBe(read.entries[0].entry_hash);
  });
});

// ─── applyChatGptProEvents short-circuit interaction ─────────────────────────

describe("driver + applyChatGptProEvents short-circuit", () => {
  testNonWindows("driver-based and applyChatGptProEvents-based runs agree on FSM state", async () => {
    const machine = createChatGptProMachine();
    const direct = applyChatGptProEvents(machine, HAPPY_PATH);
    expect(direct.state).toBe("success");

    const driver = await startChatGptProLedger(machine, {
      sessionId: SESSION_ID,
      homeDir,
      providerSlot: "chatgpt_pro_first_plan",
    });
    const driven = await drive(driver, HAPPY_PATH);
    expect(driven.machine.state).toBe(direct.state);
    expect(driven.machine.context.evidenceId).toBe(direct.context.evidenceId);
    expect(driven.machine.context.outputTextSha256).toBe(direct.context.outputTextSha256);
  });
});
