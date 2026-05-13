import type { Command } from "commander";

import type { JsonEnvelope } from "../../../oracle/v18/contracts.js";
import { createEnvelope, createErrorEnvelope } from "../../../oracle/v18/json_envelope.js";
import {
  exportEvidenceLedgerForHandoff,
  type SanitizedEvidenceLedgerExport,
} from "../../../oracle/evidence_ledger_sanitize.js";

export interface EvidenceLedgerExportIo {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface RunEvidenceLedgerExportOptions {
  sessionId: string;
  json?: boolean;
  homeDir?: string;
  sanitized?: boolean;
  quarantined?: boolean;
  verifyChain?: boolean;
}

export interface RunEvidenceLedgerExportResult {
  envelope: JsonEnvelope;
  export: SanitizedEvidenceLedgerExport | null;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function registerEvidenceLedgerExportCommand(
  ledgerCommand: Command,
  defaults: Pick<RunEvidenceLedgerExportOptions, "homeDir"> = {},
): Command {
  return ledgerCommand
    .command("export <session>")
    .description("Export a sanitized evidence ledger snapshot for APR handoff")
    .option("--sanitized", "sanitize metadata and omit unsafe debug details", true)
    .option("--quarantined", "include quarantined unsafe_debug metadata after sanitization", false)
    .option("--json", "emit a json_envelope.v1 response", false)
    .action(async (session: string, options: Record<string, unknown>) => {
      const result = await runEvidenceLedgerExport(
        {
          sessionId: session,
          homeDir: defaults.homeDir,
          json: options.json === true,
          sanitized: options.sanitized !== false,
          quarantined: options.quarantined === true,
        },
        {
          log: (message) => console.log(message),
          error: (message) => console.error(message),
        },
      );

      if (!result.envelope.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runEvidenceLedgerExport(
  options: RunEvidenceLedgerExportOptions,
  io: EvidenceLedgerExportIo = {},
): Promise<RunEvidenceLedgerExportResult> {
  const log = io.log ?? (() => undefined);
  const error = io.error ?? (() => undefined);

  if (!isSafeSessionId(options.sessionId)) {
    const envelope = createErrorEnvelope({
      errors: [
        {
          error_code: "output_capture_unverified",
          message: "Invalid evidence ledger session id",
          details: { session_id: options.sessionId },
        },
      ],
      meta: { tool: "oracle evidence ledger export" },
      next_command: null,
      fix_command: null,
      retry_safe: false,
    });
    writeFailure(envelope, options, error);
    return { envelope, export: null };
  }

  try {
    const includeQuarantined = options.quarantined === true;
    const exportData = await exportEvidenceLedgerForHandoff(options.sessionId, {
      homeDir: options.homeDir,
      includeQuarantined,
      verifyChain: options.verifyChain ?? true,
    });

    if (!exportData.chain_valid) {
      const envelope = createErrorEnvelope({
        errors: [
          {
            error_code: "output_capture_unverified",
            message: exportData.chain_failure ?? "Evidence ledger chain verification failed",
            details: {
              session_id: options.sessionId,
              chain_failure: exportData.chain_failure,
            },
          },
        ],
        meta: { tool: "oracle evidence ledger export" },
        data: exportData as unknown as Record<string, unknown>,
        next_command: `oracle evidence ledger verify ${options.sessionId} --json`,
        fix_command: `oracle evidence ledger export ${options.sessionId} --quarantined --json`,
        retry_safe: false,
      });
      writeFailure(envelope, options, error);
      return { envelope, export: exportData };
    }

    const envelope = createEnvelope({
      ok: true,
      data: exportData as unknown as Record<string, unknown>,
      meta: {
        command: "oracle evidence ledger export",
        sanitized: true,
        quarantined: includeQuarantined,
      },
    });
    writeSuccess(envelope, exportData, options, log);
    return { envelope, export: exportData };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const envelope = createErrorEnvelope({
      errors: [
        {
          error_code: "output_capture_unverified",
          message: "Failed to export evidence ledger",
          details: {
            session_id: options.sessionId,
            error: message,
          },
        },
      ],
      meta: { tool: "oracle evidence ledger export" },
      next_command: `oracle evidence ledger export ${options.sessionId} --json`,
      fix_command: null,
      retry_safe: true,
    });
    writeFailure(envelope, options, error);
    return { envelope, export: null };
  }
}

function writeSuccess(
  envelope: JsonEnvelope,
  exportData: SanitizedEvidenceLedgerExport,
  options: RunEvidenceLedgerExportOptions,
  log: (message: string) => void,
): void {
  if (options.json) {
    log(JSON.stringify(envelope, null, 2));
    return;
  }

  log(renderHumanExport(exportData));
}

function writeFailure(
  envelope: JsonEnvelope,
  options: RunEvidenceLedgerExportOptions,
  error: (message: string) => void,
): void {
  if (options.json) {
    error(JSON.stringify(envelope, null, 2));
    return;
  }

  const detail = envelope.errors[0]?.message ?? "unknown error";
  error(`🧿 oracle evidence ledger export failed\n${detail}`);
}

function renderHumanExport(exportData: SanitizedEvidenceLedgerExport): string {
  const lines = [
    "🧿 oracle evidence ledger export",
    `session: ${exportData.session_id}`,
    `mode: ${exportData.export_mode}`,
    `chain: ${exportData.chain_valid ? "valid" : "invalid"}`,
    `events: ${exportData.exported_entry_count}/${exportData.entry_count}`,
    `quarantined: ${exportData.quarantined_entry_count}${
      exportData.quarantined_included ? " included" : " metadata omitted"
    }`,
  ];

  if (exportData.tail_hash) {
    lines.push(`tail_hash: ${exportData.tail_hash}`);
  }

  return lines.join("\n");
}

function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID_PATTERN.test(sessionId);
}
