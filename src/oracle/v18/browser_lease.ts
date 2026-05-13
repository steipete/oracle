import {
  BROWSER_LEASE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserLeaseSchema,
  type BrowserLease,
} from "./contracts.js";

export type BrowserLeaseProvider = BrowserLease["provider"];
export type StoredBrowserLeaseStatus = Extract<BrowserLease["status"], "acquired" | "expired" | "released">;
export type BrowserLeaseReadState =
  | "missing"
  | "active"
  | "expired"
  | "stale"
  | "released"
  | "corrupt"
  | "profile_mismatch";

export interface StoredBrowserLeaseRecord extends BrowserLease {
  status: StoredBrowserLeaseStatus;
  acquired_at: string;
  updated_at: string;
  local_pid?: number;
  remote_session_id?: string;
  command_summary?: string;
  safe_recovery_command: string;
  released_at?: string;
}

export interface BuildStoredBrowserLeaseInput {
  leaseId: string;
  provider: BrowserLeaseProvider;
  profileIdHash: string;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  holder: string;
  commandSummary?: string;
  localPid?: number;
  remoteSessionId?: string;
  remoteBrowser?: Record<string, unknown>;
  lockName?: string;
  profileScope?: string;
  sharedProfilePolicy?: string;
  safeRecoveryCommand?: string;
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export function isBrowserLeaseProvider(value: unknown): value is BrowserLeaseProvider {
  return value === "chatgpt" || value === "gemini";
}

export function assertBrowserLeaseProvider(value: unknown): BrowserLeaseProvider {
  if (isBrowserLeaseProvider(value)) {
    return value;
  }
  throw new Error(`Unsupported browser lease provider: ${String(value)}`);
}

export function assertProfileIdHash(value: string): string {
  if (!SHA256_RE.test(value)) {
    throw new Error("profile_id_hash must match sha256:<64 hex>.");
  }
  return value;
}

export function browserLeaseLockName(provider: BrowserLeaseProvider): string {
  return `${provider}.shared-browser-profile`;
}

export function browserLeaseRecoveryCommand(provider: BrowserLeaseProvider, leaseId?: string): string {
  const leasePart = leaseId ? ` --lease-id ${leaseId}` : "";
  return `oracle browser leases recover --provider ${provider}${leasePart}`;
}

export function buildStoredBrowserLease(
  input: BuildStoredBrowserLeaseInput,
): StoredBrowserLeaseRecord {
  const provider = assertBrowserLeaseProvider(input.provider);
  const profileIdHash = assertProfileIdHash(input.profileIdHash);
  return {
    schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    lease_id: input.leaseId,
    provider,
    profile_id_hash: profileIdHash,
    remote_browser: input.remoteBrowser ?? {},
    lock_name: input.lockName ?? browserLeaseLockName(provider),
    status: "acquired",
    ttl_seconds: input.ttlSeconds,
    issued_at: input.issuedAt,
    acquired_at: input.issuedAt,
    updated_at: input.issuedAt,
    expires_at: input.expiresAt,
    renewable: true,
    profile_scope: input.profileScope ?? "shared-logical-profile",
    shared_profile_policy:
      input.sharedProfilePolicy ?? "one-provider-lock-per-shared-logical-profile",
    holder: input.holder,
    command_summary: input.commandSummary,
    local_pid: input.localPid,
    remote_session_id: input.remoteSessionId,
    safe_recovery_command: input.safeRecoveryCommand ?? browserLeaseRecoveryCommand(provider, input.leaseId),
    blocked_reason: null,
    next_command: null,
    fix_command: null,
  };
}

export function parseStoredBrowserLease(value: unknown): StoredBrowserLeaseRecord | null {
  const parsed = browserLeaseSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const record = value as Partial<StoredBrowserLeaseRecord>;
  if (
    parsed.data.status !== "acquired" &&
    parsed.data.status !== "expired" &&
    parsed.data.status !== "released"
  ) {
    return null;
  }
  if (record.local_pid !== undefined && typeof record.local_pid !== "number") {
    return null;
  }
  if (record.remote_session_id !== undefined && typeof record.remote_session_id !== "string") {
    return null;
  }
  if (record.command_summary !== undefined && typeof record.command_summary !== "string") {
    return null;
  }
  if (typeof record.acquired_at !== "string" || typeof record.updated_at !== "string") {
    return null;
  }
  if (typeof record.safe_recovery_command !== "string") {
    return null;
  }
  return record as StoredBrowserLeaseRecord;
}

export function redactBrowserLeaseMetadata(
  record: StoredBrowserLeaseRecord,
): StoredBrowserLeaseRecord {
  return {
    ...record,
    holder: record.holder ? "[redacted]" : record.holder,
    command_summary: record.command_summary ? "[redacted]" : record.command_summary,
    remote_session_id: record.remote_session_id ? "[redacted]" : record.remote_session_id,
    remote_browser: redactRemoteBrowser(record.remote_browser),
  };
}

function redactRemoteBrowser(remoteBrowser: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(remoteBrowser)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const lower = key.toLowerCase();
      if (lower.endsWith("_hash") || lower.endsWith("_sha256") || lower === "provider") {
        acc[key] = remoteBrowser[key];
      } else {
        acc[key] = "[redacted]";
      }
      return acc;
    }, {});
}
