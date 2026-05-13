// Append-only browser evidence ledger (oracle-jfq sub-piece 1).
//
// Each session accumulates a JSONL ledger of evidence events alongside
// the per-evidence-id files pane 6's `writeEvidence` already produces.
// The ledger is a temporal record (session_started → mode_verified →
// prompt_submitted → response_arrived → evidence_written →
// run_completed/failed) that makes wrong-mode success, stale-tab
// success, and privacy leakage detectable by reading a single file.
//
// Tamper detection: each entry records `prev_hash` (sha256 of the
// previous entry's canonical bytes) + `entry_hash` (sha256 of the
// canonicalised entry contents including `prev_hash`). The chain
// boots from a non-placeholder sentinel hash so the v18
// `isPlaceholderHash` guard doesn't reject the genesis link.
//
// The module is intentionally self-contained — no dependency on the
// FSM, the normalizer, or any browser-side surface. Callers wire it
// where they need by passing events.

import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalJSON,
  evidenceDir,
  isPlaceholderHash,
  sha256OfBytes,
} from "./v18/evidence.js";
import { serializeEvidenceLedgerAppend } from "./evidence_ledger_concurrency.js";

export const EVIDENCE_LEDGER_SCHEMA_VERSION = "evidence_ledger.v1" as const;
export const EVIDENCE_LEDGER_FILENAME = "ledger.jsonl" as const;

/**
 * Sentinel pre-image for the genesis `prev_hash`. Mixed with a literal
 * string so the resulting digest is never a single-character repeat or
 * all-zeros — the v18 placeholder guard would reject those.
 */
const GENESIS_PREIMAGE = "evidence_ledger.v1:genesis";

export const EVIDENCE_LEDGER_GENESIS_HASH = sha256OfBytes(GENESIS_PREIMAGE);
if (isPlaceholderHash(EVIDENCE_LEDGER_GENESIS_HASH)) {
  throw new Error(
    `evidence ledger genesis hash collided with a placeholder digest: ${EVIDENCE_LEDGER_GENESIS_HASH}`,
  );
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type EvidenceLedgerEventType =
  | "session_started"
  | "browser_attached"
  | "login_verified"
  | "mode_verified_same_session"
  | "prompt_submitted"
  | "response_arrived"
  | "evidence_written"
  | "evidence_quarantined"
  | "run_completed"
  | "run_failed";

export interface EvidenceLedgerEvent {
  readonly type: EvidenceLedgerEventType;
  readonly provider_slot?: string;
  readonly evidence_id?: string;
  readonly mode?: "remote" | "local";
  /** Free-form sanitized metadata; the writer guards against forbidden keys. */
  readonly metadata?: Record<string, unknown>;
  /** Caller-supplied timestamp; defaults to now() at append time. */
  readonly timestamp?: string;
}

export interface EvidenceLedgerEntry {
  readonly schema_version: typeof EVIDENCE_LEDGER_SCHEMA_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: EvidenceLedgerEvent;
  readonly prev_hash: `sha256:${string}`;
  readonly entry_hash: `sha256:${string}`;
}

/**
 * Forbidden keys mirror the `redactEvidencePayload` policy. The ledger
 * MUST NOT carry cookies, raw DOM, screenshots, account identifiers,
 * or raw private prompt/output text — even inside `metadata`.
 */
const FORBIDDEN_METADATA_KEYS: ReadonlySet<string> = new Set([
  "cookie",
  "cookies",
  "set-cookie",
  "account_email",
  "user_email",
  "email",
  "raw_dom",
  "dom_html",
  "dom_snapshot",
  "html_snapshot",
  "screenshot",
  "screenshots",
  "auth",
  "auth_header",
  "auth_headers",
  "authorization",
  "bearer_token",
  "access_token",
  "session_token",
  "api_key",
  "raw_prompt",
  "prompt_text",
  "raw_output",
  "output_text",
  "assistant_text",
  "response_text",
  "raw_profile_path",
  "user_data_dir",
]);

function assertNoForbiddenMetadata(
  metadata: Record<string, unknown> | undefined,
  pointer: string,
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.has(lower)) {
      throw new Error(
        `evidence ledger metadata at ${pointer}/${key} is forbidden by the redaction policy`,
      );
    }
    if (lower.includes("cookie") || lower.includes("authorization")) {
      throw new Error(
        `evidence ledger metadata at ${pointer}/${key} matches a forbidden substring`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertNoForbiddenMetadata(value as Record<string, unknown>, `${pointer}/${key}`);
    }
  }
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function evidenceLedgerPath(sessionId: string, homeDir?: string): string {
  return path.join(evidenceDir(sessionId, homeDir), EVIDENCE_LEDGER_FILENAME);
}

// ─── Append ──────────────────────────────────────────────────────────────────

export interface AppendEvidenceLedgerOptions {
  readonly homeDir?: string;
  /** Override `Date.now()`-derived timestamp; useful for deterministic tests. */
  readonly now?: () => Date;
}

export interface AppendResult {
  readonly entry: EvidenceLedgerEntry;
  readonly filePath: string;
  /** True if the file existed and had at least one entry before this append. */
  readonly chainExtended: boolean;
}

/**
 * Append a single event to the ledger. The read-tail/compute-next/append
 * critical section is serialized per ledger path in-process and guarded
 * by a cooperative lock file for other Oracle processes using this module.
 * Direct writes to ledger.jsonl are unsupported because they bypass the
 * append-only hash-chain contract.
 */
export async function appendEvidenceLedgerEvent(
  sessionId: string,
  event: EvidenceLedgerEvent,
  options: AppendEvidenceLedgerOptions = {},
): Promise<AppendResult> {
  assertNoForbiddenMetadata(event.metadata, "event.metadata");

  const filePath = evidenceLedgerPath(sessionId, options.homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  return serializeEvidenceLedgerAppend(filePath, async () =>
    appendEvidenceLedgerEventUnlocked(filePath, event, options),
  );
}

async function appendEvidenceLedgerEventUnlocked(
  filePath: string,
  event: EvidenceLedgerEvent,
  options: AppendEvidenceLedgerOptions,
): Promise<AppendResult> {
  const prior = await readEvidenceLedgerInternal(filePath, { tolerateMissingFile: true });
  const sequence = prior.entries.length;
  const prevHash =
    prior.entries.length === 0
      ? EVIDENCE_LEDGER_GENESIS_HASH
      : prior.entries[prior.entries.length - 1].entry_hash;

  const timestamp =
    event.timestamp ?? (options.now ? options.now() : new Date()).toISOString();

  const entryWithoutHash = {
    schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
    sequence,
    timestamp,
    event,
    prev_hash: prevHash,
  };
  const entryHash = sha256OfBytes(canonicalJSON(entryWithoutHash));
  const entry: EvidenceLedgerEntry = { ...entryWithoutHash, entry_hash: entryHash };

  const line = `${canonicalJSON(entry)}\n`;
  await fs.appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }

  return {
    entry,
    filePath,
    chainExtended: prior.entries.length > 0,
  };
}

// ─── Read + verify ───────────────────────────────────────────────────────────

export interface ReadEvidenceLedgerOptions {
  readonly homeDir?: string;
  /**
   * When true (default), the reader validates the hash chain. When
   * false the reader still parses each line but skips chain
   * verification — useful when the caller wants to surface a corrupted
   * ledger to the operator instead of throwing.
   */
  readonly verifyChain?: boolean;
}

export interface ReadEvidenceLedgerResult {
  readonly entries: readonly EvidenceLedgerEntry[];
  /** True iff every entry parsed AND the hash chain validates. */
  readonly chainValid: boolean;
  /** Detail of the first chain failure, when chainValid=false. */
  readonly chainFailure: string | null;
}

export async function readEvidenceLedger(
  sessionId: string,
  options: ReadEvidenceLedgerOptions = {},
): Promise<ReadEvidenceLedgerResult> {
  const filePath = evidenceLedgerPath(sessionId, options.homeDir);
  return readEvidenceLedgerInternal(filePath, {
    tolerateMissingFile: true,
    verifyChain: options.verifyChain ?? true,
  });
}

interface ReadInternalOptions {
  readonly tolerateMissingFile?: boolean;
  readonly verifyChain?: boolean;
}

async function readEvidenceLedgerInternal(
  filePath: string,
  options: ReadInternalOptions = {},
): Promise<ReadEvidenceLedgerResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (options.tolerateMissingFile) {
        return { entries: [], chainValid: true, chainFailure: null };
      }
      throw error;
    }
    throw error;
  }

  const lines = raw.split("\n").filter((line) => line.length > 0);
  const entries: EvidenceLedgerEntry[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: EvidenceLedgerEntry;
    try {
      parsed = JSON.parse(line) as EvidenceLedgerEntry;
    } catch (error) {
      return {
        entries,
        chainValid: false,
        chainFailure: `line ${index + 1} is not valid JSON: ${(error as Error).message}`,
      };
    }
    entries.push(parsed);
  }

  if (options.verifyChain === false) {
    return { entries, chainValid: true, chainFailure: null };
  }

  const failure = verifyChainInternal(entries);
  return {
    entries,
    chainValid: failure === null,
    chainFailure: failure,
  };
}

function verifyChainInternal(entries: readonly EvidenceLedgerEntry[]): string | null {
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.schema_version !== EVIDENCE_LEDGER_SCHEMA_VERSION) {
      return `entry ${i} has wrong schema_version "${entry.schema_version}"`;
    }
    if (entry.sequence !== i) {
      return `entry ${i} has out-of-order sequence ${entry.sequence}`;
    }
    const expectedPrev =
      i === 0 ? EVIDENCE_LEDGER_GENESIS_HASH : entries[i - 1].entry_hash;
    if (entry.prev_hash !== expectedPrev) {
      return `entry ${i} prev_hash ${entry.prev_hash} does not match expected ${expectedPrev}`;
    }
    const canonical = canonicalJSON({
      schema_version: entry.schema_version,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      event: entry.event,
      prev_hash: entry.prev_hash,
    });
    const computed = sha256OfBytes(canonical);
    if (computed !== entry.entry_hash) {
      return `entry ${i} entry_hash mismatch (recorded ${entry.entry_hash}, computed ${computed})`;
    }
  }
  return null;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface EvidenceLedgerSummary {
  readonly schema_version: typeof EVIDENCE_LEDGER_SCHEMA_VERSION;
  readonly session_id: string;
  readonly entry_count: number;
  readonly chain_valid: boolean;
  readonly chain_failure: string | null;
  readonly first_timestamp: string | null;
  readonly last_timestamp: string | null;
  readonly tail_hash: `sha256:${string}`;
  readonly events: readonly EvidenceLedgerEntry[];
}

export async function summarizeEvidenceLedger(
  sessionId: string,
  options: ReadEvidenceLedgerOptions = {},
): Promise<EvidenceLedgerSummary> {
  const read = await readEvidenceLedger(sessionId, options);
  return {
    schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
    session_id: sessionId,
    entry_count: read.entries.length,
    chain_valid: read.chainValid,
    chain_failure: read.chainFailure,
    first_timestamp: read.entries[0]?.timestamp ?? null,
    last_timestamp:
      read.entries.length > 0 ? read.entries[read.entries.length - 1].timestamp : null,
    tail_hash:
      read.entries.length > 0
        ? read.entries[read.entries.length - 1].entry_hash
        : EVIDENCE_LEDGER_GENESIS_HASH,
    events: read.entries,
  };
}
