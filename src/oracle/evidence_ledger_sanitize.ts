import type {
  EvidenceLedgerEntry,
  EvidenceLedgerEvent,
  EvidenceLedgerSummary,
} from "./evidence_ledger.js";
import { summarizeEvidenceLedger } from "./evidence_ledger.js";

export const EVIDENCE_LEDGER_EXPORT_SCHEMA_VERSION = "evidence_ledger_export.v1" as const;

export type EvidenceLedgerExportMode = "sanitized" | "quarantined";
export type EvidenceLedgerSanitizedMetadata = Record<string, unknown>;

export interface EvidenceLedgerHandoffExportOptions {
  homeDir?: string;
  includeQuarantined?: boolean;
  verifyChain?: boolean;
}

export interface SanitizedEvidenceLedgerEntry {
  schema_version: EvidenceLedgerEntry["schema_version"];
  sequence: number;
  timestamp: string;
  event: EvidenceLedgerEvent;
  prev_hash: EvidenceLedgerEntry["prev_hash"];
  entry_hash: EvidenceLedgerEntry["entry_hash"];
  quarantined: boolean;
  quarantined_metadata_included: boolean;
}

export interface SanitizedEvidenceLedgerExport {
  schema_version: typeof EVIDENCE_LEDGER_EXPORT_SCHEMA_VERSION;
  ledger_schema_version: EvidenceLedgerSummary["schema_version"];
  session_id: string;
  export_mode: EvidenceLedgerExportMode;
  sanitized: true;
  quarantined_included: boolean;
  entry_count: number;
  exported_entry_count: number;
  quarantined_entry_count: number;
  chain_valid: boolean;
  chain_failure?: EvidenceLedgerSummary["chain_failure"];
  first_timestamp?: string;
  last_timestamp?: string;
  tail_hash?: string;
  events: SanitizedEvidenceLedgerEntry[];
}

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|auth[_-]?token|cookie|cookies|password|passphrase|raw[_-]?(?:dom|prompt|output)|secret|screenshot|token|api[_-]?key|hidden[_-]?reasoning|prompt[_-]?text|output[_-]?text|private[_-]?key)/i;

const HASH_KEY_PATTERN = /(?:^|_)(?:hash|sha256|checksum|digest)$/i;
const SHA256_VALUE_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/i;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk|pk|rk|xox[baprs]?|gh[pousr]|glpat|AKIA)[-_]?[A-Za-z0-9_=-]{8,}\b/g;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g;
const PARAM_SECRET_PATTERN =
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|session|cookie)=([^;&\s]+)/gi;

export async function exportEvidenceLedgerForHandoff(
  sessionId: string,
  options: EvidenceLedgerHandoffExportOptions = {},
): Promise<SanitizedEvidenceLedgerExport> {
  const summary = await summarizeEvidenceLedger(sessionId, {
    homeDir: options.homeDir,
    verifyChain: options.verifyChain ?? true,
  });

  return sanitizeEvidenceLedgerSummary(summary, {
    includeQuarantined: options.includeQuarantined ?? false,
  });
}

export function sanitizeEvidenceLedgerSummary(
  summary: EvidenceLedgerSummary,
  options: Pick<EvidenceLedgerHandoffExportOptions, "includeQuarantined"> = {},
): SanitizedEvidenceLedgerExport {
  const includeQuarantined = options.includeQuarantined ?? false;
  const events = summary.events.map((entry) =>
    sanitizeEvidenceLedgerEntry(entry, { includeQuarantined }),
  );
  const quarantinedEntryCount = events.filter((entry) => entry.quarantined).length;

  return {
    schema_version: EVIDENCE_LEDGER_EXPORT_SCHEMA_VERSION,
    ledger_schema_version: summary.schema_version,
    session_id: summary.session_id,
    export_mode: includeQuarantined ? "quarantined" : "sanitized",
    sanitized: true,
    quarantined_included: includeQuarantined,
    entry_count: summary.entry_count,
    exported_entry_count: events.length,
    quarantined_entry_count: quarantinedEntryCount,
    chain_valid: summary.chain_valid,
    ...(summary.chain_failure ? { chain_failure: summary.chain_failure } : {}),
    ...(summary.first_timestamp ? { first_timestamp: summary.first_timestamp } : {}),
    ...(summary.last_timestamp ? { last_timestamp: summary.last_timestamp } : {}),
    ...(summary.tail_hash ? { tail_hash: summary.tail_hash } : {}),
    events,
  };
}

export function sanitizeEvidenceLedgerEntry(
  entry: EvidenceLedgerEntry,
  options: Pick<EvidenceLedgerHandoffExportOptions, "includeQuarantined"> = {},
): SanitizedEvidenceLedgerEntry {
  const includeQuarantined = options.includeQuarantined ?? false;
  const quarantined = isQuarantinedLedgerEntry(entry);
  const metadata = entry.event.metadata;
  const event: EvidenceLedgerEvent = metadata
    ? {
        ...entry.event,
        metadata:
          quarantined && !includeQuarantined
            ? quarantineMetadataReceipt(metadata)
            : sanitizeEvidenceLedgerMetadata(metadata),
      }
    : { ...entry.event };

  return {
    schema_version: entry.schema_version,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    event,
    prev_hash: entry.prev_hash,
    entry_hash: entry.entry_hash,
    quarantined,
    quarantined_metadata_included: quarantined ? includeQuarantined : false,
  };
}

export function sanitizeEvidenceLedgerMetadata(
  metadata: EvidenceLedgerSanitizedMetadata,
): EvidenceLedgerSanitizedMetadata {
  return sanitizeStructuredValue(metadata) as EvidenceLedgerSanitizedMetadata;
}

export function isQuarantinedLedgerEntry(entry: EvidenceLedgerEntry): boolean {
  if (entry.event.type === "evidence_quarantined") {
    return true;
  }

  const metadata = entry.event.metadata;
  if (!metadata) {
    return false;
  }

  return (
    metadata.quarantined === true ||
    metadata.unsafe_debug === true ||
    metadata.redaction_policy === "unsafe_debug" ||
    metadata.redactionPolicy === "unsafe_debug"
  );
}

function quarantineMetadataReceipt(
  metadata: EvidenceLedgerSanitizedMetadata,
): EvidenceLedgerSanitizedMetadata {
  const receipt: EvidenceLedgerSanitizedMetadata = {
    metadata_omitted_from_sanitized_export: true,
  };

  preserveSafeMetadataValue(receipt, metadata, "redaction_policy");
  preserveSafeMetadataValue(receipt, metadata, "redactionPolicy");
  preserveSafeMetadataValue(receipt, metadata, "evidence_id");
  preserveSafeMetadataValue(receipt, metadata, "evidence_sha256");
  preserveSafeMetadataValue(receipt, metadata, "artifact_sha256");
  preserveSafeMetadataValue(receipt, metadata, "capture_sha256");

  return receipt;
}

function preserveSafeMetadataValue(
  receipt: EvidenceLedgerSanitizedMetadata,
  metadata: EvidenceLedgerSanitizedMetadata,
  key: string,
): void {
  if (!(key in metadata)) {
    return;
  }

  const value = metadata[key];
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    receipt[key] = sanitizeStructuredValue(value, key);
  }
}

function sanitizeStructuredValue(value: unknown, key?: string): unknown {
  if (key && shouldRedactKey(key, value)) {
    return "[redacted]";
  }

  if (typeof value === "string") {
    return maskSensitiveString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item));
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeStructuredValue(childValue, childKey);
    }
    return sanitized;
  }

  return value;
}

function shouldRedactKey(key: string, value: unknown): boolean {
  if (typeof value === "string" && HASH_KEY_PATTERN.test(key) && SHA256_VALUE_PATTERN.test(value)) {
    return false;
  }
  return SENSITIVE_KEY_PATTERN.test(key);
}

function maskSensitiveString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(SECRET_TOKEN_PATTERN, "[redacted]")
    .replace(JWT_PATTERN, "[redacted]")
    .replace(PARAM_SECRET_PATTERN, "$1=[redacted]");
}
