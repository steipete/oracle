// `oracle evidence ledger verify <session> [--json]` runner (oracle-iwg).
//
// This intentionally lives beside ledger.ts without registering into the
// command tree; command routing is a separate integration bead.

import { createEnvelope, createErrorEnvelope } from "../../../oracle/v18/json_envelope.js";
import type { JsonEnvelope } from "../../../oracle/v18/contracts.js";
import {
  verifyEvidenceLedger,
  type EvidenceLedgerVerifyResult,
} from "../../../oracle/evidence_ledger_verify.js";

export interface RunEvidenceLedgerVerifyOptions {
  readonly sessionId: string;
  readonly json?: boolean;
  readonly homeDir?: string;
}

export interface EvidenceLedgerVerifyIo {
  readonly log?: (message: string) => void;
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function assertSafeSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid session id: "${value}". Must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,127}.`,
    );
  }
}

export async function runEvidenceLedgerVerify(
  options: RunEvidenceLedgerVerifyOptions,
  io: EvidenceLedgerVerifyIo = {},
): Promise<{ envelope: JsonEnvelope; result: EvidenceLedgerVerifyResult | null }> {
  const log = io.log ?? ((message: string) => console.log(message));
  let result: EvidenceLedgerVerifyResult | null = null;
  let envelope: JsonEnvelope;

  try {
    assertSafeSessionId(options.sessionId);
    result = await verifyEvidenceLedger(options.sessionId, { homeDir: options.homeDir });
    envelope = result.ok
      ? createEnvelope({
          ok: true,
          data: result as unknown as Record<string, unknown>,
          meta: { tool: "oracle evidence ledger verify" },
          commands: {
            show: `oracle evidence ledger show ${options.sessionId} --json`,
          },
        })
      : createErrorEnvelope({
          errors: [
            {
              error_code: "output_capture_unverified",
              message: result.issues[0]?.message ?? "evidence ledger verification failed",
              details: {
                session_id: options.sessionId,
                first_issue: result.issues[0] ?? null,
                issue_count: result.issues.length,
              },
            },
          ],
          meta: { tool: "oracle evidence ledger verify" },
          next_command: `oracle evidence ledger show ${options.sessionId} --json`,
          fix_command: `oracle evidence ledger rebuild ${options.sessionId} --from-artifacts --json`,
          retry_safe: false,
          data: result as unknown as Record<string, unknown>,
        });
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
      meta: { tool: "oracle evidence ledger verify" },
      next_command: `oracle evidence ledger verify ${options.sessionId} --json`,
      fix_command: null,
      retry_safe: true,
    });
  }

  if (options.json) {
    log(JSON.stringify(envelope, null, 2));
  } else {
    renderHumanVerify(envelope, result, log);
  }
  return { envelope, result };
}

function renderHumanVerify(
  envelope: JsonEnvelope,
  result: EvidenceLedgerVerifyResult | null,
  log: (message: string) => void,
): void {
  log("🧿 oracle evidence ledger verify");
  if (!result) {
    log("  status: error");
    log(`  reason: ${envelope.errors[0]?.message ?? "unknown"}`);
    return;
  }
  log(`  session_id: ${result.session_id}`);
  log(`  chain_valid: ${result.chain_valid}`);
  log(`  evidence_written: ${result.evidence_written_count}`);
  log(`  files_checked: ${result.files_checked}`);
  log(`  artifact_index_present: ${result.artifact_index_present}`);
  log(`  ok: ${result.ok}`);
  if (!result.ok) {
    log(`  first_issue: ${result.issues[0]?.code ?? "unknown"}`);
    log(`  reason: ${result.issues[0]?.message ?? "unknown"}`);
  }
}
