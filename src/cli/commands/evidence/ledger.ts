// `oracle evidence ledger show <session> [--json]` (oracle-jfq sub-piece 1).
//
// Pane 3 owns `evidence show` / `evidence verify`. This file is a
// sibling that adds the ledger surface without touching pane 3's
// index.ts. Wiring into bin/oracle-cli.ts is intentionally deferred
// until the evidence command tree is integrated end-to-end (separate
// follow-on bead).

import { createEnvelope, createErrorEnvelope } from "../../../oracle/v18/json_envelope.js";
import type { JsonEnvelope } from "../../../oracle/v18/contracts.js";
import {
  summarizeEvidenceLedger,
  type EvidenceLedgerSummary,
} from "../../../oracle/evidence_ledger.js";

export interface RunEvidenceLedgerShowOptions {
  /** Session id whose ledger should be rendered. */
  readonly sessionId: string;
  readonly json?: boolean;
  readonly homeDir?: string;
  /** When false, the chain is parsed but not cryptographically verified. */
  readonly verifyChain?: boolean;
}

export interface EvidenceLedgerShowIo {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function assertSafeSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid session id: "${value}". Must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,127}.`,
    );
  }
}

/**
 * Produce a sanitised JSON envelope summarising the ledger for the
 * given session. The envelope is always `json_envelope.v1`; failures
 * return an error envelope with the v18 recovery contract fields.
 */
export async function runEvidenceLedgerShow(
  options: RunEvidenceLedgerShowOptions,
  io: EvidenceLedgerShowIo = {},
): Promise<{ envelope: JsonEnvelope; summary: EvidenceLedgerSummary | null }> {
  const log = io.log ?? ((m: string) => console.log(m));

  let summary: EvidenceLedgerSummary | null = null;
  let envelope: JsonEnvelope;
  try {
    assertSafeSessionId(options.sessionId);
    summary = await summarizeEvidenceLedger(options.sessionId, {
      homeDir: options.homeDir,
      verifyChain: options.verifyChain ?? true,
    });
    if (!summary.chain_valid) {
      envelope = createErrorEnvelope({
        errors: [
          {
            error_code: "output_capture_unverified",
            message: summary.chain_failure ?? "ledger chain verification failed",
            details: {
              session_id: options.sessionId,
              entry_count: summary.entry_count,
              tail_hash: summary.tail_hash,
            },
          },
        ],
        meta: { tool: "oracle evidence ledger show" },
        next_command: `oracle evidence ledger verify ${options.sessionId} --json`,
        fix_command: `oracle evidence ledger export ${options.sessionId} --quarantined --json`,
        retry_safe: false,
        data: summary as unknown as Record<string, unknown>,
      });
    } else {
      envelope = createEnvelope({
        ok: true,
        data: summary as unknown as Record<string, unknown>,
        meta: { tool: "oracle evidence ledger show" },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    envelope = createErrorEnvelope({
      errors: [
        {
          error_code: "output_capture_unverified",
          message,
          details: { session_id: options.sessionId },
        },
      ],
      meta: { tool: "oracle evidence ledger show" },
      next_command: `oracle evidence ledger show ${options.sessionId} --json`,
      fix_command: null,
      retry_safe: true,
    });
  }

  if (options.json) {
    log(JSON.stringify(envelope, null, 2));
  } else {
    renderHumanLedger(envelope, summary, log);
  }
  return { envelope, summary };
}

function renderHumanLedger(
  envelope: JsonEnvelope,
  summary: EvidenceLedgerSummary | null,
  log: (m: string) => void,
): void {
  log(`🧿 oracle evidence ledger show`);
  if (!summary) {
    log(`  status: error`);
    log(`  reason: ${envelope.errors[0]?.message ?? "unknown"}`);
    return;
  }
  log(`  session_id: ${summary.session_id}`);
  log(`  entries: ${summary.entry_count}`);
  log(`  chain_valid: ${summary.chain_valid}`);
  if (summary.first_timestamp) log(`  first: ${summary.first_timestamp}`);
  if (summary.last_timestamp) log(`  last: ${summary.last_timestamp}`);
  log(`  tail_hash: ${summary.tail_hash}`);
  if (!summary.chain_valid && summary.chain_failure) {
    log(`  chain_failure: ${summary.chain_failure}`);
  }
}
