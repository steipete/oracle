import {
  asOracleUserError,
  OracleTransportError,
  type OracleUserErrorDetails,
} from "../oracle/errors.js";
import { JSON_ENVELOPE_SCHEMA_VERSION, type JsonEnvelope } from "../oracle/v18/contracts.js";

export interface TopLevelCliErrorEnvelope extends JsonEnvelope {
  status: "error";
  error: {
    code: string;
    message: string;
    help: string | null;
    details?: Record<string, unknown>;
  };
}

export interface BuildTopLevelCliErrorEnvelopeInput {
  error: unknown;
  command: string;
  exitCode: number;
  generatedAt?: string;
}

export function isJsonModeRequested(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--json");
}

export function buildTopLevelCliErrorEnvelope({
  error,
  command,
  exitCode,
  generatedAt = new Date().toISOString(),
}: BuildTopLevelCliErrorEnvelopeInput): TopLevelCliErrorEnvelope {
  const normalized = normalizeTopLevelError(error);
  const errorEntry: Record<string, unknown> = {
    error_code: normalized.code,
    message: normalized.message,
  };
  if (normalized.details) {
    errorEntry.details = normalized.details;
  }
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    status: "error",
    data: null,
    meta: {
      command,
      generated_at: generatedAt,
      exit_code: exitCode,
    },
    blocked_reason: normalized.code,
    next_command: normalized.nextCommand,
    fix_command: normalized.fixCommand,
    retry_safe: normalized.retrySafe,
    errors: [errorEntry],
    warnings: [],
    commands: {},
    error: {
      code: normalized.code,
      message: normalized.message,
      help: normalized.help,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}

export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

interface NormalizedTopLevelError {
  code: string;
  message: string;
  help: string | null;
  details?: Record<string, unknown>;
  nextCommand: string | null;
  fixCommand: string | null;
  retrySafe: boolean;
}

function normalizeTopLevelError(error: unknown): NormalizedTopLevelError {
  const userError = asOracleUserError(error);
  const userDetails = userError?.details ? cleanDetails(userError.details) : undefined;
  const userStage = stringFromRecord(userDetails, "stage");
  const reuseProfileHint = stringFromRecord(userDetails, "reuseProfileHint");
  const detailNextCommand =
    stringFromRecord(userDetails, "next_command") ?? stringFromRecord(userDetails, "nextCommand");
  const detailFixCommand =
    stringFromRecord(userDetails, "fix_command") ?? stringFromRecord(userDetails, "fixCommand");

  if (userError) {
    const nextCommand = detailNextCommand ?? reuseProfileHint;
    const fixCommand = detailFixCommand ?? reuseProfileHint;
    return {
      code: userStage ?? userError.category,
      message: userError.message,
      help: fixCommand ?? nextCommand,
      details: userDetails,
      nextCommand: nextCommand ?? null,
      fixCommand: fixCommand ?? null,
      retrySafe: false,
    };
  }

  if (error instanceof OracleTransportError) {
    return {
      code: error.reason,
      message: error.message,
      help: null,
      details: { reason: error.reason },
      nextCommand: null,
      fixCommand: null,
      retrySafe: error.reason === "client-timeout" || error.reason === "connection-lost",
    };
  }

  const record = isRecord(error) ? error : undefined;
  const code = stringFromRecord(record, "code") ?? "top_level_error";
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const commanderHelp = code.startsWith("commander.") ? "Run `oracle --help` for usage." : null;
  return {
    code,
    message,
    help: commanderHelp,
    details: record ? { code } : undefined,
    nextCommand: commanderHelp ? "oracle --help" : null,
    fixCommand: null,
    retrySafe: false,
  };
}

function cleanDetails(details: OracleUserErrorDetails): Record<string, unknown> {
  return Object.entries(details).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort(compareStrings)
    .reduce<Record<string, unknown>>((acc, key) => {
      const sortedValue = sortJsonValue(value[key]);
      if (sortedValue !== undefined) {
        acc[key] = sortedValue;
      }
      return acc;
    }, {});
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
