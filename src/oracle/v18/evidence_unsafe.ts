import {
  browserEvidenceSchema,
  type BrowserEvidence,
} from "./contracts.js";
import {
  writeEvidence,
  type WriteEvidenceOptions,
  type WrittenEvidence,
} from "./evidence.js";

export type EvidenceMode = "safe" | "unsafe";

export interface EvidenceModeGateOptions {
  readonly evidenceMode?: EvidenceMode;
  readonly acknowledgeUnsafeEvidence?: boolean;
  /**
   * Optional caller surface. Unsafe evidence is only for live debugging
   * runs, never doctor/capabilities/dry-run surfaces.
   */
  readonly commandKind?: string;
}

export interface WriteEvidenceWithModeOptions
  extends WriteEvidenceOptions,
    EvidenceModeGateOptions {}

export class UnsafeEvidenceModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEvidenceModeError";
  }
}

const UNSAFE_FORBIDDEN_COMMANDS = new Set(["doctor", "capabilities", "dry-run", "dry_run"]);

export function resolveEvidenceModeGate(options: EvidenceModeGateOptions = {}): {
  readonly mode: EvidenceMode;
  readonly allowQuarantine: boolean;
} {
  const mode = options.evidenceMode ?? "safe";
  if (mode !== "safe" && mode !== "unsafe") {
    throw new UnsafeEvidenceModeError(`Unknown evidence mode: ${String(mode)}`);
  }

  if (mode === "safe") {
    return { mode, allowQuarantine: false };
  }

  const commandKind = options.commandKind?.trim().toLowerCase();
  if (commandKind && UNSAFE_FORBIDDEN_COMMANDS.has(commandKind)) {
    throw new UnsafeEvidenceModeError(
      `Unsafe evidence mode is not allowed for ${commandKind} commands.`,
    );
  }

  if (options.acknowledgeUnsafeEvidence !== true) {
    throw new UnsafeEvidenceModeError(
      "Unsafe evidence mode requires both --evidence unsafe and an explicit unsafe-evidence acknowledgement.",
    );
  }

  return { mode, allowQuarantine: true };
}

export async function writeEvidenceWithMode(
  sessionId: string,
  rawEvidence: unknown,
  options: WriteEvidenceWithModeOptions = {},
): Promise<WrittenEvidence> {
  const evidence = browserEvidenceSchema.parse(rawEvidence) as BrowserEvidence;
  const gate = resolveEvidenceModeGate(options);

  if (evidence.redaction_policy === "unsafe_debug") {
    if (gate.mode !== "unsafe") {
      throw new UnsafeEvidenceModeError(
        'redaction_policy "unsafe_debug" requires --evidence unsafe and an unsafe-evidence acknowledgement.',
      );
    }
    if (evidence.unsafe_artifacts_quarantined !== true) {
      throw new UnsafeEvidenceModeError(
        'redaction_policy "unsafe_debug" requires unsafe_artifacts_quarantined=true.',
      );
    }
  }

  return writeEvidence(sessionId, evidence, {
    homeDir: options.homeDir,
    runId: options.runId,
    allowQuarantine: gate.allowQuarantine,
  });
}
