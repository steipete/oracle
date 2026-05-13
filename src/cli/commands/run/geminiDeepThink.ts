import { Command, InvalidArgumentError, Option } from "commander";
import {
  GEMINI_DEEP_THINK_BROWSER_MODEL,
  GEMINI_DEEP_THINK_EVIDENCE_MODES,
  GEMINI_DEEP_THINK_FALLBACK_MODES,
  GEMINI_DEEP_THINK_REMOTE_BROWSER_MODES,
  normalizeGeminiDeepThinkModelOption,
  parseDurationOption,
  parseGeminiDeepThinkEvidenceOption,
  parseGeminiDeepThinkFallbackOption,
  parseGeminiDeepThinkRemoteBrowserOption,
  type GeminiDeepThinkBrowserModel,
  type GeminiDeepThinkEvidenceMode,
  type GeminiDeepThinkFallbackMode,
  type GeminiDeepThinkRemoteBrowserMode,
} from "../../options.js";

const JSON_ENVELOPE_SCHEMA_VERSION = "json_envelope.v1" as const;
const GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION = "gemini_deep_think_run.v1" as const;
const DEFAULT_GEMINI_LEASE_TTL_MS = 30 * 60 * 1000;

export interface GeminiDeepThinkCommonCliOptions {
  geminiDeepThink?: boolean;
  deepThink?: boolean;
  remoteBrowser?: string;
  json?: boolean;
}

export interface GeminiDeepThinkDoctorPlan {
  deep_think: boolean;
  remote_browser: GeminiDeepThinkRemoteBrowserMode;
  json: boolean;
}

export interface GeminiDeepThinkLeaseCliOptions extends GeminiDeepThinkCommonCliOptions {
  ttl?: string | number;
  ttlMs?: number;
  ttlSeconds?: string | number;
}

export interface GeminiDeepThinkLeasePlan extends GeminiDeepThinkDoctorPlan {
  provider: "gemini";
  require: "deep_think";
  ttl_ms: number;
  ttl_seconds: number;
}

export interface GeminiDeepThinkRunCliOptions extends GeminiDeepThinkCommonCliOptions {
  provider?: string;
  engine?: string;
  model?: string;
  prompt?: string;
  promptFile?: string;
  evidence?: string;
  geminiDeepThinkFallback?: string;
  dryRun?: boolean | string;
  loginVerified?: boolean;
  deepThinkAvailable?: boolean;
}

export interface GeminiDeepThinkRunPlan {
  schema_version: typeof GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION;
  dry_run: boolean;
  live_call: boolean;
  provider: "gemini";
  engine: "browser";
  model: GeminiDeepThinkBrowserModel;
  deep_think: true;
  fallback: GeminiDeepThinkFallbackMode;
  remote_browser: GeminiDeepThinkRemoteBrowserMode;
  evidence: {
    mode: GeminiDeepThinkEvidenceMode;
    redacted: true;
  };
  prompt_source:
    | { kind: "file"; path: string; redacted: true }
    | { kind: "inline"; redacted: true };
  protected_route: {
    doctor_command: string;
    lease_command: string;
    run_command: string;
  };
}

export interface GeminiDeepThinkRunEnvelope {
  schema_version: typeof JSON_ENVELOPE_SCHEMA_VERSION;
  ok: boolean;
  data: GeminiDeepThinkRunPlan | null;
  meta: {
    command: "oracle gemini run";
    generated_at: string;
    schema_version: typeof GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION;
  };
  blocked_reason: string | null;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean | null;
  errors: Array<{
    error_code: string;
    message: string;
    details: Record<string, unknown>;
  }>;
  warnings: string[];
  commands: Record<string, unknown>;
}

export interface GeminiDeepThinkRunIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export class GeminiDeepThinkCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly nextCommand: string | null = null,
    readonly fixCommand: string | null = null,
    readonly retrySafe = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GeminiDeepThinkCliError";
  }
}

export function addGeminiDeepThinkDoctorFlags(command: Command): Command {
  addBooleanFlag(command, "--gemini-deep-think", "Require Gemini Deep Think route readiness.");
  addBooleanFlag(command, "--deep-think", "Require Gemini Deep Think route readiness.");
  addRemoteBrowserFlag(command);
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function addGeminiDeepThinkLeaseFlags(command: Command): Command {
  addBooleanFlag(command, "--gemini-deep-think", "Acquire a Gemini Deep Think lease.");
  addBooleanFlag(command, "--deep-think", "Require Gemini Deep Think route readiness.");
  addRemoteBrowserFlag(command);
  addOptionIfMissing(
    command,
    new Option("--ttl <duration>", "Lease TTL (for example 30m, 10m, or 1h).")
      .argParser((value) => parseRequiredDuration(value, "Gemini Deep Think lease TTL"))
      .default(DEFAULT_GEMINI_LEASE_TTL_MS),
  );
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function addGeminiDeepThinkRunFlags(command: Command): Command {
  addOptionIfMissing(command, new Option("--engine <mode>", "Execution engine."));
  addOptionIfMissing(command, new Option("--provider <provider>", "Browser provider."));
  addOptionIfMissing(command, new Option("--model <model>", "Browser model route."));
  addBooleanFlag(command, "--gemini-deep-think", "Use the protected Gemini Deep Think route.");
  addBooleanFlag(command, "--deep-think", "Require Gemini Deep Think route readiness.");
  addOptionIfMissing(
    command,
    new Option("--gemini-deep-think-fallback <mode>", "Deep Think fallback policy.")
      .choices([...GEMINI_DEEP_THINK_FALLBACK_MODES])
      .argParser(parseGeminiDeepThinkFallbackOption)
      .default("fail"),
  );
  addRemoteBrowserFlag(command);
  addOptionIfMissing(
    command,
    new Option("--evidence <mode>", "Evidence policy for protected browser runs.")
      .choices([...GEMINI_DEEP_THINK_EVIDENCE_MODES])
      .argParser(parseGeminiDeepThinkEvidenceOption)
      .default("redacted"),
  );
  addOptionIfMissing(command, new Option("--prompt-file <path>", "Read the prompt from a file."));
  addOptionIfMissing(command, new Option("--prompt <text>", "Prompt text."));
  addOptionIfMissing(
    command,
    new Option("--dry-run [mode]", "Preview without submitting to Gemini.")
      .choices(["summary", "json", "full"])
      .preset("summary")
      .default(false),
  );
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function normalizeGeminiDeepThinkDoctorOptions(
  options: GeminiDeepThinkCommonCliOptions = {},
): GeminiDeepThinkDoctorPlan {
  return {
    deep_think: Boolean(options.geminiDeepThink || options.deepThink),
    remote_browser: parseGeminiDeepThinkRemoteBrowserOption(options.remoteBrowser),
    json: Boolean(options.json),
  };
}

export function normalizeGeminiDeepThinkLeaseOptions(
  options: GeminiDeepThinkLeaseCliOptions = {},
): GeminiDeepThinkLeasePlan {
  const doctor = normalizeGeminiDeepThinkDoctorOptions({ ...options, deepThink: true });
  const ttlMs = normalizeLeaseTtlMs(options);
  return {
    ...doctor,
    provider: "gemini",
    require: "deep_think",
    ttl_ms: ttlMs,
    ttl_seconds: Math.ceil(ttlMs / 1000),
  };
}

export function normalizeGeminiDeepThinkRunOptions(
  options: GeminiDeepThinkRunCliOptions = {},
): GeminiDeepThinkRunPlan {
  if (!options.geminiDeepThink && !options.deepThink) {
    throw new GeminiDeepThinkCliError(
      "--gemini-deep-think is required for the protected Gemini Deep Think route.",
      "gemini_deep_think_flag_required",
      null,
      "--gemini-deep-think",
      false,
    );
  }

  const engine = normalizeText(options.engine, "browser");
  if (engine !== "browser") {
    throw new GeminiDeepThinkCliError(
      "Gemini Deep Think protected routes require --engine browser.",
      "gemini_deep_think_requires_browser_engine",
      null,
      "--engine browser",
      false,
      { engine },
    );
  }

  const provider = normalizeText(options.provider, "gemini");
  if (provider !== "gemini") {
    throw new GeminiDeepThinkCliError(
      "Gemini Deep Think protected routes require --provider gemini.",
      "gemini_deep_think_requires_gemini_provider",
      null,
      "--provider gemini",
      false,
      { provider },
    );
  }

  if (options.loginVerified === false) {
    throw new GeminiDeepThinkCliError(
      "Gemini login is required before submitting a Deep Think prompt.",
      "provider_login_required",
      doctorCommand(parseGeminiDeepThinkRemoteBrowserOption(options.remoteBrowser)),
      "Sign in to gemini.google.com, then rerun oracle doctor gemini --deep-think --json.",
      true,
    );
  }
  if (options.deepThinkAvailable === false) {
    throw new GeminiDeepThinkCliError(
      "Gemini Deep Think could not be verified in the active browser session.",
      "gemini_deep_think_unverified",
      doctorCommand(parseGeminiDeepThinkRemoteBrowserOption(options.remoteBrowser)),
      "--gemini-deep-think-fallback fail",
      false,
    );
  }

  const model = normalizeProtectedModel(options.model);
  const fallback = parseGeminiDeepThinkFallbackOption(options.geminiDeepThinkFallback);
  const remoteBrowser = parseGeminiDeepThinkRemoteBrowserOption(options.remoteBrowser);
  const evidence = parseGeminiDeepThinkEvidenceOption(options.evidence);
  const promptSource = normalizePromptSource(options);
  const dryRun = options.dryRun !== undefined && options.dryRun !== false;

  const plan: GeminiDeepThinkRunPlan = {
    schema_version: GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION,
    dry_run: dryRun,
    live_call: !dryRun,
    provider: "gemini",
    engine: "browser",
    model,
    deep_think: true,
    fallback,
    remote_browser: remoteBrowser,
    evidence: { mode: evidence, redacted: true },
    prompt_source: promptSource,
    protected_route: {
      doctor_command: doctorCommand(remoteBrowser),
      lease_command: buildLeaseCommand(remoteBrowser),
      run_command: buildRunCommand(model, remoteBrowser, fallback, evidence, promptSource),
    },
  };
  return plan;
}

export function buildGeminiDeepThinkRunEnvelope(
  options: GeminiDeepThinkRunCliOptions,
  deps: { now?: () => Date } = {},
): GeminiDeepThinkRunEnvelope {
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
  try {
    const plan = normalizeGeminiDeepThinkRunOptions(options);
    return {
      schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
      ok: true,
      data: plan,
      meta: {
        command: "oracle gemini run",
        generated_at: generatedAt,
        schema_version: GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION,
      },
      blocked_reason: null,
      next_command: plan.protected_route.run_command,
      fix_command: null,
      retry_safe: null,
      errors: [],
      warnings: [],
      commands: {
        doctor: plan.protected_route.doctor_command,
        lease: plan.protected_route.lease_command,
        run: plan.protected_route.run_command,
      },
    };
  } catch (error) {
    return failureEnvelope(error, generatedAt);
  }
}

export async function runGeminiDeepThinkDryRun(
  options: GeminiDeepThinkRunCliOptions,
  io: GeminiDeepThinkRunIo = {},
): Promise<GeminiDeepThinkRunEnvelope> {
  const envelope = buildGeminiDeepThinkRunEnvelope({
    ...options,
    dryRun: options.dryRun ?? true,
  });
  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(options.json ? stableJsonStringify(envelope) : formatGeminiDeepThinkRunEnvelope(envelope));
  return envelope;
}

export function formatGeminiDeepThinkRunEnvelope(envelope: GeminiDeepThinkRunEnvelope): string {
  if (!envelope.ok) {
    const message = envelope.errors[0]?.message ?? "Gemini Deep Think run is blocked.";
    return `blocked: ${envelope.blocked_reason}\n${message}`;
  }
  const data = envelope.data;
  return [
    `gemini deep think run: ${data?.dry_run ? "dry-run" : "ready"}`,
    `route: ${data?.engine}/${data?.provider}; model=${data?.model}`,
    `remote_browser: ${data?.remote_browser}`,
    `fallback: ${data?.fallback}`,
    `evidence: ${data?.evidence.mode}`,
  ].join("\n");
}

function normalizeProtectedModel(value: string | undefined): GeminiDeepThinkBrowserModel {
  try {
    return normalizeGeminiDeepThinkModelOption(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw new GeminiDeepThinkCliError(
        error.message,
        "gemini_deep_think_api_substitution_forbidden",
        null,
        `--model ${GEMINI_DEEP_THINK_BROWSER_MODEL}`,
        false,
        { model: value ?? null },
      );
    }
    throw error;
  }
}

function normalizePromptSource(
  options: GeminiDeepThinkRunCliOptions,
): GeminiDeepThinkRunPlan["prompt_source"] {
  const promptFile = options.promptFile?.trim();
  if (promptFile) {
    return { kind: "file", path: promptFile, redacted: true };
  }
  if (options.prompt?.trim()) {
    return { kind: "inline", redacted: true };
  }
  throw new GeminiDeepThinkCliError(
    "Prompt is required for Gemini Deep Think runs; pass --prompt-file or --prompt.",
    "gemini_deep_think_prompt_required",
    null,
    "--prompt-file PROMPT.md",
    false,
  );
}

function normalizeLeaseTtlMs(options: GeminiDeepThinkLeaseCliOptions): number {
  if (options.ttl !== undefined) {
    return normalizeDurationMs(options.ttl, "Gemini Deep Think lease TTL");
  }
  if (options.ttlMs !== undefined) {
    return normalizePositiveMs(options.ttlMs, "Gemini Deep Think lease TTL");
  }
  if (options.ttlSeconds !== undefined) {
    const seconds =
      typeof options.ttlSeconds === "string"
        ? Number.parseFloat(options.ttlSeconds)
        : options.ttlSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new InvalidArgumentError("Gemini Deep Think lease TTL seconds must be positive.");
    }
    return Math.ceil(seconds * 1000);
  }
  return DEFAULT_GEMINI_LEASE_TTL_MS;
}

function normalizeDurationMs(value: string | number, label: string): number {
  return typeof value === "number"
    ? normalizePositiveMs(value, label)
    : parseRequiredDuration(value, label);
}

function parseRequiredDuration(value: string, label: string): number {
  const parsed = parseDurationOption(value, label);
  if (parsed === undefined) {
    throw new InvalidArgumentError(`${label} is required.`);
  }
  return parsed;
}

function normalizePositiveMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidArgumentError(`${label} must be positive.`);
  }
  return Math.ceil(value);
}

function addRemoteBrowserFlag(command: Command): void {
  addOptionIfMissing(
    command,
    new Option("--remote-browser <mode>", "Remote browser policy.")
      .choices([...GEMINI_DEEP_THINK_REMOTE_BROWSER_MODES])
      .argParser(parseGeminiDeepThinkRemoteBrowserOption)
      .default("preferred"),
  );
}

function addBooleanFlag(command: Command, flags: string, description: string): void {
  if (hasOption(command, flags)) {
    return;
  }
  command.addOption(new Option(flags, description).default(false));
}

function addOptionIfMissing(command: Command, option: Option): void {
  // commander types `Option.long` as `string | undefined` — coalesce so
  // the lookup uses an empty string (which can't collide with a real
  // `--long` flag) when the option only carries a short form.
  if (hasOption(command, option.long ?? "")) {
    return;
  }
  command.addOption(option);
}

function hasOption(command: Command, longFlag: string): boolean {
  return command.options.some((option) => option.long === longFlag);
}

function normalizeText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || fallback;
}

function doctorCommand(remoteBrowser: GeminiDeepThinkRemoteBrowserMode): string {
  return `oracle doctor gemini --deep-think --remote-browser ${remoteBrowser} --json`;
}

function buildRunCommand(
  model: GeminiDeepThinkBrowserModel,
  remoteBrowser: GeminiDeepThinkRemoteBrowserMode,
  fallback: GeminiDeepThinkFallbackMode,
  evidence: GeminiDeepThinkEvidenceMode,
  promptSource: GeminiDeepThinkRunPlan["prompt_source"],
): string {
  const promptPart =
    promptSource.kind === "file"
      ? `--prompt-file ${quoteCliArg(promptSource.path)}`
      : "--prompt <redacted>";
  return [
    "oracle --engine browser --provider gemini",
    `--model ${model}`,
    "--gemini-deep-think",
    `--gemini-deep-think-fallback ${fallback}`,
    `--remote-browser ${remoteBrowser}`,
    `--evidence ${evidence}`,
    promptPart,
    "--json",
  ].join(" ");
}

function buildLeaseCommand(remoteBrowser: GeminiDeepThinkRemoteBrowserMode): string {
  return [
    "oracle browser leases acquire",
    "--providers gemini",
    "--require deep_think",
    `--remote-browser ${remoteBrowser}`,
    `--ttl-seconds ${Math.ceil(DEFAULT_GEMINI_LEASE_TTL_MS / 1000)}`,
    "--json",
  ].join(" ");
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function failureEnvelope(error: unknown, generatedAt: string): GeminiDeepThinkRunEnvelope {
  const normalized = normalizeError(error);
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    data: null,
    meta: {
      command: "oracle gemini run",
      generated_at: generatedAt,
      schema_version: GEMINI_DEEP_THINK_RUN_SCHEMA_VERSION,
    },
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
  if (error instanceof GeminiDeepThinkCliError) {
    return {
      code: error.code,
      message: error.message,
      nextCommand: error.nextCommand,
      fixCommand: error.fixCommand,
      retrySafe: error.retrySafe,
      details: error.details,
    };
  }
  if (error instanceof InvalidArgumentError) {
    return {
      code: "invalid_gemini_deep_think_option",
      message: error.message,
      nextCommand: null,
      fixCommand: null,
      retrySafe: false,
      details: {},
    };
  }
  return {
    code: "gemini_deep_think_run_failed",
    message: error instanceof Error ? error.message : String(error),
    nextCommand: null,
    fixCommand: null,
    retrySafe: false,
    details: {},
  };
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
