import { createHash } from "node:crypto";
import { Command } from "commander";
import {
  BrowserLeaseStateError,
  createBrowserLease,
  readBrowserLease,
  releaseBrowserLease,
  type BrowserLeaseReadResult,
  type BrowserLeaseStoreOptions,
} from "../../../browser/leases.js";
import {
  assertBrowserLeaseProvider,
  browserLeaseLockName,
  type BrowserLeaseProvider,
} from "../../../oracle/v18/browser_lease.js";
import { BROWSER_LEASE_SCHEMA_VERSION, V18_BUNDLE_VERSION } from "../../../oracle/v18/contracts.js";

const JSON_ENVELOPE_SCHEMA_VERSION = "json_envelope.v1";
const DEFAULT_PROVIDERS: BrowserLeaseProvider[] = ["chatgpt", "gemini"];
const DEFAULT_PROFILE = "balanced";
const DEFAULT_REMOTE_BROWSER = "preferred";
const DEFAULT_REQUIREMENT = "optional";
const DEFAULT_TTL_SECONDS = 15 * 60;

export interface BrowserLeasesCommandOptions extends BrowserLeaseStoreOptions {
  provider?: string | string[];
  providers?: string | string[];
  profile?: string;
  remoteBrowser?: string;
  require?: string;
  profileIdHash?: string;
  ttlSeconds?: number | string;
  leaseId?: string;
  holder?: string;
  commandSummary?: string;
  json?: boolean;
}

export interface BrowserLeasesCommandIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface BrowserLeasesEnvelope {
  schema_version: typeof JSON_ENVELOPE_SCHEMA_VERSION;
  ok: boolean;
  data: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  blocked_reason: string | null;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean | null;
  errors: Array<Record<string, unknown>>;
  warnings: string[];
  commands: Record<string, unknown>;
}

interface NormalizedLeaseOptions {
  providers: BrowserLeaseProvider[];
  profile: string;
  remoteBrowser: string;
  requirement: string;
  profileIdHash: string;
  ttlSeconds: number;
}

export class BrowserLeasesCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly nextCommand: string | null = null,
    readonly fixCommand: string | null = null,
    readonly retrySafe = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrowserLeasesCommandError";
  }
}

export function registerBrowserLeasesCommand(
  program: Command,
  deps: BrowserLeaseStoreOptions = {},
): Command {
  const browser = program.command("browser").description("Browser automation utilities.");
  const leases = browser
    .command("leases")
    .description("Plan, inspect, acquire, release, and recover browser provider leases.");

  addCommonOptions(leases.command("plan").description("Preview required browser provider leases."))
    .option("--json", "Print structured JSON.", true)
    .action(async (options: BrowserLeasesCommandOptions) => {
      await runAndSetExitCode(() => runBrowserLeasesPlan({ ...deps, ...options }));
    });

  addCommonOptions(leases.command("status").description("Show browser provider lease status."))
    .option("--json", "Print structured JSON.", true)
    .action(async (options: BrowserLeasesCommandOptions) => {
      await runAndSetExitCode(() => runBrowserLeasesStatus({ ...deps, ...options }));
    });

  addCommonOptions(leases.command("acquire").description("Acquire browser provider leases."))
    .option("--ttl-seconds <seconds>", "Lease TTL in seconds.")
    .option("--holder <label>", "Lease holder label.")
    .option("--command-summary <text>", "Command summary to store with the lease.")
    .option("--json", "Print structured JSON.", true)
    .action(async (options: BrowserLeasesCommandOptions) => {
      await runAndSetExitCode(() => runBrowserLeasesAcquire({ ...deps, ...options }));
    });

  addCommonOptions(leases.command("release").description("Release a browser provider lease."))
    .requiredOption("--lease-id <id>", "Lease id to release.")
    .option("--json", "Print structured JSON.", true)
    .action(async (options: BrowserLeasesCommandOptions) => {
      await runAndSetExitCode(() => runBrowserLeasesRelease({ ...deps, ...options }));
    });

  addCommonOptions(leases.command("recover").description("Print safe recovery guidance."))
    .option("--lease-id <id>", "Lease id to recover.")
    .option("--json", "Print structured JSON.", true)
    .action(async (options: BrowserLeasesCommandOptions) => {
      await runAndSetExitCode(() => runBrowserLeasesRecover({ ...deps, ...options }));
    });

  return leases;
}

export async function runBrowserLeasesPlan(
  options: BrowserLeasesCommandOptions = {},
  io: BrowserLeasesCommandIo = {},
): Promise<BrowserLeasesEnvelope> {
  return runCommand("plan", options, io, async (normalized) => {
    const issuedAt = currentDate(options);
    return okEnvelope({
      action: "plan",
      options: publicOptions(normalized),
      dry_run: true,
      leases: normalized.providers.map((provider) => plannedLease(provider, normalized, issuedAt)),
    });
  });
}

export async function runBrowserLeasesStatus(
  options: BrowserLeasesCommandOptions = {},
  io: BrowserLeasesCommandIo = {},
): Promise<BrowserLeasesEnvelope> {
  return runCommand("status", options, io, async (normalized) => {
    const results = await Promise.all(
      normalized.providers.map((provider) => readProviderLease(provider, normalized, options)),
    );
    return okEnvelope({
      action: "status",
      options: publicOptions(normalized),
      leases: results.map(formatReadResult),
    });
  });
}

export async function runBrowserLeasesAcquire(
  options: BrowserLeasesCommandOptions = {},
  io: BrowserLeasesCommandIo = {},
): Promise<BrowserLeasesEnvelope> {
  return runCommand("acquire", options, io, async (normalized) => {
    const current = await Promise.all(
      normalized.providers.map((provider) => readProviderLease(provider, normalized, options)),
    );
    const blocker = current.find(
      (result) => result.state !== "missing" && result.state !== "released",
    );
    if (blocker) {
      throw stateError(
        `Cannot acquire ${blocker.provider}; lease is ${blocker.state}.`,
        blocker,
        blocker.state === "active" ? "browser_lease_conflict" : "browser_lease_recovery_required",
      );
    }

    const leases = [];
    for (const provider of normalized.providers) {
      leases.push(
        await createBrowserLease(
          {
            provider,
            profileIdHash: normalized.profileIdHash,
            ttlSeconds: normalized.ttlSeconds,
            holder: options.holder,
            commandSummary: options.commandSummary ?? acquireCommandSummary(provider, normalized),
            remoteBrowser: { mode: normalized.remoteBrowser },
            profileScope: normalized.profile,
          },
          options,
        ),
      );
    }

    return okEnvelope({
      action: "acquire",
      options: publicOptions(normalized),
      leases,
    });
  });
}

export async function runBrowserLeasesRelease(
  options: BrowserLeasesCommandOptions = {},
  io: BrowserLeasesCommandIo = {},
): Promise<BrowserLeasesEnvelope> {
  return runCommand("release", options, io, async (normalized) => {
    const leaseId = requireLeaseId(options.leaseId);
    const released = [];
    for (const provider of normalized.providers) {
      released.push(
        await releaseBrowserLease(
          { provider, profileIdHash: normalized.profileIdHash, leaseId },
          options,
        ),
      );
    }
    return okEnvelope({
      action: "release",
      options: publicOptions(normalized),
      lease_id: leaseId,
      leases: released,
    });
  });
}

export async function runBrowserLeasesRecover(
  options: BrowserLeasesCommandOptions = {},
  io: BrowserLeasesCommandIo = {},
): Promise<BrowserLeasesEnvelope> {
  return runCommand("recover", options, io, async (normalized) => {
    const results = await Promise.all(
      normalized.providers.map((provider) => readProviderLease(provider, normalized, options)),
    );
    const recoveries = results.map((result) => recoveryGuidance(result, options.leaseId));
    return okEnvelope({
      action: "recover",
      options: publicOptions(normalized),
      lease_id: options.leaseId ?? null,
      recoveries,
    });
  });
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--provider <provider>", "Alias for --providers; single provider.")
    .option("--providers <list>", "Comma-separated providers (chatgpt,gemini).")
    .option("--require <mode>", "Mode requirement to report in the plan.", DEFAULT_REQUIREMENT)
    .option("--profile <profile>", "Shared profile policy label.", DEFAULT_PROFILE)
    .option("--remote-browser <mode>", "Remote browser policy.", DEFAULT_REMOTE_BROWSER)
    .option("--profile-id-hash <hash>", "Expected shared profile_id_hash.");
}

async function runAndSetExitCode(callback: () => Promise<BrowserLeasesEnvelope>): Promise<void> {
  const envelope = await callback();
  if (!envelope.ok) {
    process.exitCode = 1;
  }
}

async function runCommand(
  action: string,
  options: BrowserLeasesCommandOptions,
  io: BrowserLeasesCommandIo,
  callback: (normalized: NormalizedLeaseOptions) => Promise<BrowserLeasesEnvelope>,
): Promise<BrowserLeasesEnvelope> {
  try {
    const normalized = normalizeOptions(options);
    const envelope = await callback(normalized);
    writeEnvelope(envelope, options, io);
    return envelope;
  } catch (error) {
    const envelope = failureEnvelope(action, error);
    writeEnvelope(envelope, options, io);
    return envelope;
  }
}

async function readProviderLease(
  provider: BrowserLeaseProvider,
  normalized: NormalizedLeaseOptions,
  options: BrowserLeasesCommandOptions,
): Promise<BrowserLeaseReadResult> {
  return readBrowserLease(provider, {
    ...options,
    expectedProfileIdHash: normalized.profileIdHash,
  });
}

function normalizeOptions(options: BrowserLeasesCommandOptions): NormalizedLeaseOptions {
  const profile = cleanLabel(options.profile, DEFAULT_PROFILE);
  const remoteBrowser = cleanLabel(options.remoteBrowser, DEFAULT_REMOTE_BROWSER);
  const requirement = cleanLabel(options.require, DEFAULT_REQUIREMENT);
  return {
    providers: normalizeProviders(options.providers ?? options.provider),
    profile,
    remoteBrowser,
    requirement,
    profileIdHash: options.profileIdHash ?? computeProfileIdHash({ profile, remoteBrowser }),
    ttlSeconds: normalizeTtlSeconds(options.ttlSeconds),
  };
}

function normalizeProviders(input: string | string[] | undefined): BrowserLeaseProvider[] {
  const raw =
    input === undefined
      ? DEFAULT_PROVIDERS
      : Array.isArray(input)
        ? input.flatMap((entry) => entry.split(","))
        : input.split(",");
  const providers = raw.map((entry) => entry.trim()).filter(Boolean);
  if (providers.length === 0) {
    throw new BrowserLeasesCommandError(
      "At least one provider is required.",
      "invalid_provider",
      null,
      "--providers chatgpt,gemini",
      false,
    );
  }
  const normalized = providers.map((provider) => {
    try {
      return assertBrowserLeaseProvider(provider);
    } catch {
      throw new BrowserLeasesCommandError(
        `Unsupported browser lease provider: ${provider}`,
        "invalid_provider",
        null,
        "--providers chatgpt,gemini",
        false,
        { provider },
      );
    }
  });
  return Array.from(new Set(normalized));
}

function normalizeTtlSeconds(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TTL_SECONDS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new BrowserLeasesCommandError(
      "Lease TTL must be a positive integer number of seconds.",
      "invalid_ttl",
      null,
      "--ttl-seconds 900",
      false,
      { ttlSeconds: value },
    );
  }
  return Math.trunc(numeric);
}

function requireLeaseId(value: string | undefined): string {
  const leaseId = value?.trim();
  if (!leaseId) {
    throw new BrowserLeasesCommandError(
      "--lease-id is required.",
      "lease_id_required",
      null,
      "--lease-id <lease-id>",
      false,
    );
  }
  return leaseId;
}

function plannedLease(
  provider: BrowserLeaseProvider,
  normalized: NormalizedLeaseOptions,
  issuedAt: Date,
): Record<string, unknown> {
  return {
    schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    lease_id: `planned-${provider}`,
    provider,
    profile_id_hash: normalized.profileIdHash,
    remote_browser: { mode: normalized.remoteBrowser },
    lock_name: browserLeaseLockName(provider),
    status: "available",
    ttl_seconds: normalized.ttlSeconds,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + normalized.ttlSeconds * 1000).toISOString(),
    renewable: true,
    profile_scope: normalized.profile,
    shared_profile_policy: "one-provider-lock-per-shared-logical-profile",
    holder: null,
    blocked_reason: null,
    next_command: acquireCommandSummary(provider, normalized),
    fix_command: null,
  };
}

function formatReadResult(result: BrowserLeaseReadResult): Record<string, unknown> {
  if (result.state === "missing") {
    return {
      provider: result.provider,
      state: result.state,
      path: result.path,
      recovery_command: result.recoveryCommand,
      lease: null,
    };
  }
  if (result.state === "corrupt") {
    return {
      provider: result.provider,
      state: result.state,
      path: result.path,
      recovery_command: result.recoveryCommand,
      error: result.error,
      lease: null,
    };
  }
  return {
    provider: result.provider,
    state: result.state,
    path: result.path,
    recovery_command: result.recoveryCommand,
    profile_matches: result.profileMatches,
    lease: result.record,
  };
}

function recoveryGuidance(
  result: BrowserLeaseReadResult,
  requestedLeaseId: string | undefined,
): Record<string, unknown> {
  const base = formatReadResult(result);
  const leaseId =
    requestedLeaseId ??
    (result.state !== "missing" && result.state !== "corrupt" ? result.record.lease_id : undefined);
  const command =
    result.state === "missing"
      ? null
      : `${result.recoveryCommand}${leaseId ? ` --confirm-lease-id ${leaseId}` : ""}`;
  return {
    ...base,
    safe_to_auto_recover: false,
    recovery_note:
      result.state === "missing"
        ? "No lease file exists; no recovery action is needed."
        : "Oracle will not delete or overwrite this lease automatically. Inspect the holder and confirm the lease id before manual recovery.",
    suggested_command: command,
  };
}

function okEnvelope(data: Record<string, unknown>): BrowserLeasesEnvelope {
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: true,
    data,
    meta: { command: `browser leases ${String(data.action ?? "unknown")}` },
    blocked_reason: null,
    next_command: null,
    fix_command: null,
    retry_safe: null,
    errors: [],
    warnings: [],
    commands: {},
  };
}

function failureEnvelope(action: string, error: unknown): BrowserLeasesEnvelope {
  const normalized = normalizeError(error);
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    data: null,
    meta: { command: `browser leases ${action}` },
    blocked_reason: normalized.code,
    next_command: normalized.nextCommand,
    fix_command: normalized.fixCommand,
    retry_safe: normalized.retrySafe,
    errors: [
      {
        error_code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    ],
    warnings: [],
    commands: {},
  };
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
  nextCommand: string | null;
  fixCommand: string | null;
  retrySafe: boolean;
  details: Record<string, unknown>;
} {
  if (error instanceof BrowserLeasesCommandError) {
    return {
      code: error.code,
      message: error.message,
      nextCommand: error.nextCommand,
      fixCommand: error.fixCommand,
      retrySafe: error.retrySafe,
      details: error.details,
    };
  }
  if (error instanceof BrowserLeaseStateError) {
    return stateErrorDetails(error.message, error.result, "browser_lease_recovery_required");
  }
  return {
    code: "browser_lease_command_failed",
    message: error instanceof Error ? error.message : String(error),
    nextCommand: null,
    fixCommand: null,
    retrySafe: false,
    details: {},
  };
}

function stateError(
  message: string,
  result: BrowserLeaseReadResult,
  code: string,
): BrowserLeasesCommandError {
  const normalized = stateErrorDetails(message, result, code);
  return new BrowserLeasesCommandError(
    normalized.message,
    normalized.code,
    normalized.nextCommand,
    normalized.fixCommand,
    normalized.retrySafe,
    normalized.details,
  );
}

function stateErrorDetails(
  message: string,
  result: BrowserLeaseReadResult,
  code: string,
): {
  code: string;
  message: string;
  nextCommand: string | null;
  fixCommand: string | null;
  retrySafe: boolean;
  details: Record<string, unknown>;
} {
  return {
    code,
    message,
    nextCommand: result.recoveryCommand,
    fixCommand: result.recoveryCommand,
    retrySafe: result.state === "expired" || result.state === "released",
    details: formatReadResult(result),
  };
}

function publicOptions(normalized: NormalizedLeaseOptions): Record<string, unknown> {
  return {
    providers: normalized.providers,
    profile: normalized.profile,
    remote_browser: normalized.remoteBrowser,
    require: normalized.requirement,
    profile_id_hash: normalized.profileIdHash,
    ttl_seconds: normalized.ttlSeconds,
  };
}

function acquireCommandSummary(
  provider: BrowserLeaseProvider,
  normalized: NormalizedLeaseOptions,
): string {
  return [
    "oracle browser leases acquire",
    `--providers ${provider}`,
    `--profile ${normalized.profile}`,
    `--remote-browser ${normalized.remoteBrowser}`,
    `--require ${normalized.requirement}`,
    `--profile-id-hash ${normalized.profileIdHash}`,
    `--ttl-seconds ${normalized.ttlSeconds}`,
  ].join(" ");
}

function cleanLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function computeProfileIdHash(input: { profile: string; remoteBrowser: string }): string {
  const body = stableJsonStringify({
    profile: input.profile,
    remote_browser: input.remoteBrowser,
  });
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function currentDate(options: BrowserLeasesCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function writeEnvelope(
  envelope: BrowserLeasesEnvelope,
  options: BrowserLeasesCommandOptions,
  io: BrowserLeasesCommandIo,
): void {
  const output = options.json === false ? formatText(envelope) : stableJsonStringify(envelope);
  (io.stdout ?? console.log)(output);
}

function formatText(envelope: BrowserLeasesEnvelope): string {
  if (!envelope.ok) {
    const message = String(envelope.errors[0]?.message ?? "browser lease command failed");
    return `blocked: ${envelope.blocked_reason}\n${message}`;
  }
  const data = envelope.data ?? {};
  return `browser leases ${String(data.action ?? "command")}: ok`;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const sorted = sortJson(record[key]);
      if (sorted !== undefined) {
        acc[key] = sorted;
      }
      return acc;
    }, {});
}
