// Unit + integration tests for the append-only evidence ledger
// (oracle-jfq sub-piece 1).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  EVIDENCE_LEDGER_GENESIS_HASH,
  EVIDENCE_LEDGER_SCHEMA_VERSION,
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  readEvidenceLedger,
  summarizeEvidenceLedger,
} from "../../src/oracle/evidence_ledger.js";
import {
  isPlaceholderHash,
  sha256OfBytes,
} from "../../src/oracle/v18/evidence.js";
import { runEvidenceLedgerShow } from "../../src/cli/commands/evidence/ledger.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;
const SESSION_ID = "session-ledger-test";

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

// ─── Genesis + module invariants ────────────────────────────────────────────

describe("evidence_ledger constants", () => {
  test("EVIDENCE_LEDGER_GENESIS_HASH is a real sha256 (not a placeholder)", () => {
    expect(EVIDENCE_LEDGER_GENESIS_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isPlaceholderHash(EVIDENCE_LEDGER_GENESIS_HASH)).toBe(false);
  });

  test("EVIDENCE_LEDGER_GENESIS_HASH is deterministic across runs", () => {
    const recomputed = sha256OfBytes("evidence_ledger.v1:genesis");
    expect(recomputed).toBe(EVIDENCE_LEDGER_GENESIS_HASH);
  });

  test("schema_version is pinned", () => {
    expect(EVIDENCE_LEDGER_SCHEMA_VERSION).toBe("evidence_ledger.v1");
  });
});

// ─── Append + chain ─────────────────────────────────────────────────────────

describe("appendEvidenceLedgerEvent", () => {
  testNonWindows("first append writes a genesis-linked entry", async () => {
    const { entry, filePath, chainExtended } = await appendEvidenceLedgerEvent(
      SESSION_ID,
      { type: "session_started", provider_slot: "chatgpt_pro_first_plan" },
      { homeDir },
    );
    expect(entry.sequence).toBe(0);
    expect(entry.prev_hash).toBe(EVIDENCE_LEDGER_GENESIS_HASH);
    expect(entry.entry_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chainExtended).toBe(false);
    expect(filePath).toBe(evidenceLedgerPath(SESSION_ID, homeDir));

    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk.trim().split("\n")).toHaveLength(1);
  });

  testNonWindows("second append chains prev_hash to the prior entry", async () => {
    const first = await appendEvidenceLedgerEvent(
      SESSION_ID,
      { type: "session_started" },
      { homeDir },
    );
    const second = await appendEvidenceLedgerEvent(
      SESSION_ID,
      { type: "browser_attached", mode: "remote" },
      { homeDir },
    );
    expect(second.entry.sequence).toBe(1);
    expect(second.entry.prev_hash).toBe(first.entry.entry_hash);
    expect(second.chainExtended).toBe(true);
  });

  testNonWindows("five sequential appends produce a valid chain", async () => {
    for (const evt of [
      { type: "session_started" as const },
      { type: "browser_attached" as const, mode: "remote" as const },
      { type: "login_verified" as const },
      { type: "mode_verified_same_session" as const, provider_slot: "chatgpt_pro_first_plan" },
      { type: "prompt_submitted" as const },
    ]) {
      await appendEvidenceLedgerEvent(SESSION_ID, evt, { homeDir });
    }
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(5);
    expect(read.entries[0].prev_hash).toBe(EVIDENCE_LEDGER_GENESIS_HASH);
    for (let i = 1; i < read.entries.length; i++) {
      expect(read.entries[i].prev_hash).toBe(read.entries[i - 1].entry_hash);
      expect(read.entries[i].sequence).toBe(i);
    }
  });

  testNonWindows("metadata is captured verbatim when it is safe", async () => {
    const { entry } = await appendEvidenceLedgerEvent(
      SESSION_ID,
      {
        type: "evidence_written",
        evidence_id: "ev-1",
        metadata: { provider_result_id: "pr-1", capture_confidence: "high" },
      },
      { homeDir },
    );
    expect(entry.event.metadata).toEqual({
      provider_result_id: "pr-1",
      capture_confidence: "high",
    });
  });
});

describe("appendEvidenceLedgerEvent — redaction guard", () => {
  testNonWindows("rejects forbidden metadata key (cookies)", async () => {
    await expect(
      appendEvidenceLedgerEvent(
        SESSION_ID,
        {
          type: "session_started",
          metadata: { cookies: ["session=abc"] },
        },
        { homeDir },
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  testNonWindows("rejects nested forbidden metadata", async () => {
    await expect(
      appendEvidenceLedgerEvent(
        SESSION_ID,
        {
          type: "session_started",
          metadata: {
            extra: { raw_dom: "<html>" },
          },
        },
        { homeDir },
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  testNonWindows("rejects substring-attack keys (debug_authorization)", async () => {
    await expect(
      appendEvidenceLedgerEvent(
        SESSION_ID,
        {
          type: "session_started",
          metadata: { debug_authorization: "Bearer xyz" },
        },
        { homeDir },
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  testNonWindows("on rejection, the ledger file is NOT extended", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await expect(
      appendEvidenceLedgerEvent(
        SESSION_ID,
        { type: "evidence_written", metadata: { cookies: "x" } },
        { homeDir },
      ),
    ).rejects.toThrow();
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.entries).toHaveLength(1);
  });
});

// ─── Chain verification ─────────────────────────────────────────────────────

describe("readEvidenceLedger — chain verification", () => {
  testNonWindows("missing file is treated as an empty valid chain", async () => {
    const read = await readEvidenceLedger("does-not-exist", { homeDir });
    expect(read.entries).toEqual([]);
    expect(read.chainValid).toBe(true);
  });

  testNonWindows("detects a mutated entry_hash (tamper)", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "browser_attached" }, { homeDir });

    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n");
    const parsed = JSON.parse(lines[0]);
    parsed.entry_hash = `sha256:${"0".repeat(63)}1`; // valid-shape but wrong
    lines[0] = JSON.stringify(parsed);
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(false);
    expect(read.chainFailure).toMatch(/entry_hash mismatch/);
  });

  testNonWindows("detects a chain break (prev_hash points at wrong entry)", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "login_verified" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "prompt_submitted" }, { homeDir });

    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n");
    const middle = JSON.parse(lines[1]);
    middle.prev_hash = `sha256:${"a".repeat(63)}1`;
    lines[1] = JSON.stringify(middle);
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(false);
    expect(read.chainFailure).toMatch(/prev_hash/);
  });

  testNonWindows("detects an out-of-order sequence", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "browser_attached" }, { homeDir });

    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    const raw = await readFile(filePath, "utf8");
    const lines = raw.trim().split("\n");
    const second = JSON.parse(lines[1]);
    second.sequence = 0;
    lines[1] = JSON.stringify(second);
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(false);
    expect(read.chainFailure).toMatch(/sequence/);
  });

  testNonWindows("detects a malformed JSON line", async () => {
    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    await mkdtempIfNeeded(path.dirname(filePath));
    await writeFile(filePath, '{"valid":"line"}\n{not json}\n', "utf8");
    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(false);
    expect(read.chainFailure).toMatch(/not valid JSON/);
  });

  testNonWindows("verifyChain=false parses but skips chain validation", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw.trim());
    parsed.entry_hash = `sha256:${"9".repeat(64)}`;
    await writeFile(filePath, JSON.stringify(parsed) + "\n", "utf8");
    const read = await readEvidenceLedger(SESSION_ID, { homeDir, verifyChain: false });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(1);
  });
});

async function mkdtempIfNeeded(dir: string): Promise<void> {
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
}

// ─── Summary ────────────────────────────────────────────────────────────────

describe("summarizeEvidenceLedger", () => {
  testNonWindows("empty session returns the genesis tail and entry_count=0", async () => {
    const summary = await summarizeEvidenceLedger("empty-session", { homeDir });
    expect(summary.entry_count).toBe(0);
    expect(summary.chain_valid).toBe(true);
    expect(summary.first_timestamp).toBeNull();
    expect(summary.last_timestamp).toBeNull();
    expect(summary.tail_hash).toBe(EVIDENCE_LEDGER_GENESIS_HASH);
  });

  testNonWindows("populated session reports tail_hash + counts", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "browser_attached" }, { homeDir });
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "run_completed" }, { homeDir });
    const summary = await summarizeEvidenceLedger(SESSION_ID, { homeDir });
    expect(summary.entry_count).toBe(3);
    expect(summary.chain_valid).toBe(true);
    expect(summary.tail_hash).toBe(summary.events[2].entry_hash);
    expect(summary.first_timestamp).toBe(summary.events[0].timestamp);
    expect(summary.last_timestamp).toBe(summary.events[2].timestamp);
  });
});

// ─── CLI runner ─────────────────────────────────────────────────────────────

describe("runEvidenceLedgerShow", () => {
  testNonWindows("happy path emits a json_envelope.v1 with the summary as data", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    const lines: string[] = [];
    const { envelope, summary } = await runEvidenceLedgerShow(
      { sessionId: SESSION_ID, json: true, homeDir },
      { log: (m) => lines.push(m) },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(summary?.entry_count).toBe(1);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.data.session_id).toBe(SESSION_ID);
  });

  testNonWindows("missing session is reported as ok with entry_count=0", async () => {
    const { envelope } = await runEvidenceLedgerShow(
      { sessionId: "no-such-session", json: true, homeDir },
      { log: () => {} },
    );
    expect(envelope.ok).toBe(true);
    expect((envelope.data as Record<string, unknown>).entry_count).toBe(0);
  });

  testNonWindows("corrupt ledger returns an error envelope with recovery fields", async () => {
    const filePath = evidenceLedgerPath(SESSION_ID, homeDir);
    await mkdtempIfNeeded(path.dirname(filePath));
    await writeFile(filePath, "{not json}\n", "utf8");
    const { envelope, summary } = await runEvidenceLedgerShow(
      { sessionId: SESSION_ID, json: true, homeDir },
      { log: () => {} },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("output_capture_unverified");
    expect(envelope.next_command).toMatch(/oracle evidence ledger verify/);
    expect(envelope.fix_command).toMatch(/oracle evidence ledger export/);
    expect(envelope.retry_safe).toBe(false);
    expect(summary?.chain_valid).toBe(false);
  });

  testNonWindows("rejects path-traversal session ids", async () => {
    const { envelope } = await runEvidenceLedgerShow(
      { sessionId: "../../etc/passwd", json: true, homeDir },
      { log: () => {} },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.message).toMatch(/Invalid session id/);
  });

  testNonWindows("human output mode produces a readable summary", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    const lines: string[] = [];
    await runEvidenceLedgerShow(
      { sessionId: SESSION_ID, json: false, homeDir },
      { log: (m) => lines.push(m) },
    );
    const joined = lines.join("\n");
    expect(joined).toMatch(/oracle evidence ledger show/);
    expect(joined).toMatch(/session_id:\s+session-ledger-test/);
    expect(joined).toMatch(/chain_valid:\s+true/);
  });
});
