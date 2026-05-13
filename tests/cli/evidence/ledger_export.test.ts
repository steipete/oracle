import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_LEDGER_GENESIS_HASH,
  EVIDENCE_LEDGER_SCHEMA_VERSION,
  evidenceLedgerPath,
  type EvidenceLedgerEntry,
  type EvidenceLedgerEvent,
} from "../../../src/oracle/evidence_ledger.js";
import { canonicalJSON, sha256OfBytes } from "../../../src/oracle/v18/evidence.js";
import {
  EVIDENCE_LEDGER_EXPORT_SCHEMA_VERSION,
  sanitizeEvidenceLedgerMetadata,
} from "../../../src/oracle/evidence_ledger_sanitize.js";
import { runEvidenceLedgerExport } from "../../../src/cli/commands/evidence/ledger_export.js";

const SESSION_ID = "ledger-export-test";
const HASH_A: `sha256:${string}` =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: `sha256:${string}` =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: `sha256:${string}` =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("oracle evidence ledger export", () => {
  it("emits a sanitized json envelope with the full chain and tail hash", async () => {
    const homeDir = await createTempHome();
    const entries = await writeLedger(homeDir, [
      {
        type: "session_started",
        metadata: {
          prompt_sha256: HASH_A,
          token_hash: HASH_B,
          authorization: "Bearer supersecret-token",
          raw_prompt: "send the private prompt",
          provider_note: "retry with Bearer inline-secret-token",
          nested: {
            api_key: "sk-test-secret0000000",
            callback: "https://example.test/cb?access_token=secret-value",
          },
        },
      },
      {
        type: "evidence_written",
        evidence_id: "result-1",
        metadata: {
          evidence_sha256: HASH_C,
          provider_result_id: "provider-result-1",
        },
      },
      {
        type: "evidence_quarantined",
        evidence_id: "unsafe-1",
        metadata: {
          redaction_policy: "unsafe_debug",
          unsafe_debug: true,
          evidence_sha256: HASH_C,
          raw_dom: "<main>private debug DOM</main>",
        },
      },
    ]);
    const messages: string[] = [];

    const result = await runEvidenceLedgerExport(
      { sessionId: SESSION_ID, homeDir, json: true },
      { log: (message) => messages.push(message) },
    );

    expect(result.envelope.ok).toBe(true);
    expect(messages).toHaveLength(1);
    const rendered = messages[0];
    expect(rendered).not.toContain("supersecret-token");
    expect(rendered).not.toContain("private prompt");
    expect(rendered).not.toContain("sk-test-secret0000000");
    expect(rendered).not.toContain("private debug DOM");

    const data = result.envelope.data as Record<string, unknown>;
    expect(data?.schema_version).toBe(EVIDENCE_LEDGER_EXPORT_SCHEMA_VERSION);
    expect(data?.session_id).toBe(SESSION_ID);
    expect(data?.export_mode).toBe("sanitized");
    expect(data?.entry_count).toBe(entries.length);
    expect(data?.exported_entry_count).toBe(entries.length);
    expect(data?.tail_hash).toBe(entries.at(-1)?.entry_hash);

    const events = data?.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(entries.length);
    expect(events[0]?.entry_hash).toBe(entries[0]?.entry_hash);
    expect(events[1]?.prev_hash).toBe(entries[0]?.entry_hash);

    const firstEvent = events[0]?.event as { metadata?: Record<string, unknown> };
    expect(firstEvent.metadata?.prompt_sha256).toBe(HASH_A);
    expect(firstEvent.metadata?.token_hash).toBe(HASH_B);
    expect(firstEvent.metadata?.authorization).toBe("[redacted]");
    expect(firstEvent.metadata?.raw_prompt).toBe("[redacted]");
    expect(firstEvent.metadata?.provider_note).toBe("retry with Bearer [redacted]");
    expect((firstEvent.metadata?.nested as Record<string, unknown>)?.api_key).toBe("[redacted]");
    expect((firstEvent.metadata?.nested as Record<string, unknown>)?.callback).toBe(
      "https://example.test/cb?access_token=[redacted]",
    );

    const quarantinedEntry = events[2] as {
      quarantined?: boolean;
      quarantined_metadata_included?: boolean;
      event?: { metadata?: Record<string, unknown> };
    };
    expect(quarantinedEntry.quarantined).toBe(true);
    expect(quarantinedEntry.quarantined_metadata_included).toBe(false);
    expect(quarantinedEntry.event?.metadata).toEqual({
      metadata_omitted_from_sanitized_export: true,
      redaction_policy: "unsafe_debug",
      evidence_sha256: HASH_C,
    });
  });

  it("includes quarantined unsafe_debug metadata only when requested and still sanitizes it", async () => {
    const homeDir = await createTempHome();
    await writeLedger(homeDir, [
      {
        type: "evidence_quarantined",
        evidence_id: "unsafe-1",
        metadata: {
          redaction_policy: "unsafe_debug",
          unsafe_debug: true,
          evidence_sha256: HASH_C,
          raw_dom: "<html>secret capture</html>",
          notes: "debug token=secret-token",
        },
      },
    ]);

    const result = await runEvidenceLedgerExport({
      sessionId: SESSION_ID,
      homeDir,
      json: true,
      quarantined: true,
    });

    expect(result.envelope.ok).toBe(true);
    const events = (result.envelope.data as Record<string, unknown>)?.events as Array<{
      quarantined_metadata_included?: boolean;
      event?: { metadata?: Record<string, unknown> };
    }>;
    expect(events[0]?.quarantined_metadata_included).toBe(true);
    expect(events[0]?.event?.metadata?.redaction_policy).toBe("unsafe_debug");
    expect(events[0]?.event?.metadata?.evidence_sha256).toBe(HASH_C);
    expect(events[0]?.event?.metadata?.raw_dom).toBe("[redacted]");
    expect(events[0]?.event?.metadata?.notes).toBe("debug token=[redacted]");
    expect(JSON.stringify(result.envelope)).not.toContain("secret capture");
    expect(JSON.stringify(result.envelope)).not.toContain("secret-token");
  });

  it("fails closed when the ledger chain does not verify", async () => {
    const homeDir = await createTempHome();
    const entries = await writeLedger(homeDir, [{ type: "session_started" }]);
    const path = evidenceLedgerPath(SESSION_ID, homeDir);
    const corrupted = { ...entries[0], entry_hash: HASH_A };
    await writeFile(path, `${JSON.stringify(corrupted)}\n`, "utf8");
    const errors: string[] = [];

    const result = await runEvidenceLedgerExport(
      { sessionId: SESSION_ID, homeDir, json: true },
      { error: (message) => errors.push(message) },
    );

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.errors[0]?.message).toMatch(/hash|chain|sequence/i);
    expect((result.envelope.data as Record<string, unknown>)?.chain_valid).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("rejects session ids that could escape the ledger root", async () => {
    const errors: string[] = [];

    const result = await runEvidenceLedgerExport(
      { sessionId: "../outside", homeDir: await createTempHome(), json: true },
      { error: (message) => errors.push(message) },
    );

    expect(result.envelope.ok).toBe(false);
    expect(result.export).toBeNull();
    expect(result.envelope.errors[0]?.message).toContain("Invalid evidence ledger session id");
    expect(errors[0]).toContain("json_envelope.v1");
  });

  it("redacts sensitive metadata keys while preserving digest handles", () => {
    expect(
      sanitizeEvidenceLedgerMetadata({
        capture_sha256: HASH_A,
        hidden_reasoning: "private reasoning",
        output_text: "private output",
        provider_note: "Authorization=secret token=also-secret",
      }),
    ).toEqual({
      capture_sha256: HASH_A,
      hidden_reasoning: "[redacted]",
      output_text: "[redacted]",
      provider_note: "Authorization=[redacted] token=[redacted]",
    });
  });
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/oracle-ledger-export-`);
  tempDirs.push(dir);
  return dir;
}

async function writeLedger(
  homeDir: string,
  events: Array<Omit<EvidenceLedgerEvent, "timestamp"> & { timestamp?: string }>,
): Promise<EvidenceLedgerEntry[]> {
  const path = evidenceLedgerPath(SESSION_ID, homeDir);
  await mkdir(dirname(path), { recursive: true });

  const entries: EvidenceLedgerEntry[] = [];
  let prevHash: EvidenceLedgerEntry["prev_hash"] = EVIDENCE_LEDGER_GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const entry = createEntry({
      sequence: index,
      event: events[index],
      prevHash,
      timestamp: `2026-05-12T00:00:0${index}.000Z`,
    });
    entries.push(entry);
    prevHash = entry.entry_hash;
  }

  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return entries;
}

function createEntry(options: {
  sequence: number;
  event: Omit<EvidenceLedgerEvent, "timestamp"> & { timestamp?: string };
  prevHash: EvidenceLedgerEntry["prev_hash"];
  timestamp: string;
}): EvidenceLedgerEntry {
  const eventTimestamp = options.event.timestamp ?? options.timestamp;
  const entryWithoutHash = {
    schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
    sequence: options.sequence,
    timestamp: options.timestamp,
    event: {
      ...options.event,
      timestamp: eventTimestamp,
    },
    prev_hash: options.prevHash,
  };

  return {
    ...entryWithoutHash,
    entry_hash: sha256OfBytes(canonicalJSON(entryWithoutHash)),
  };
}
