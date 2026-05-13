import { Command, InvalidArgumentError, Option } from "commander";
import {
  CHATGPT_PRO_BROWSER_MODEL,
  CHATGPT_PRO_EVIDENCE_MODES,
  CHATGPT_PRO_REMOTE_BROWSER_MODES,
  normalizeChatGptProModelOption,
  parseChatGptProEvidenceOption,
  parseChatGptProRemoteBrowserOption,
  parseDurationOption,
  type ChatGptProBrowserModel,
  type ChatGptProEvidenceMode,
  type ChatGptProRemoteBrowserMode,
} from "../../options.js";

const JSON_ENVELOPE_SCHEMA_VERSION = "json_envelope.v1" as const;
const CHATGPT_PRO_RUN_SCHEMA_VERSION = "chatgpt_pro_run.v1" as const;
const DEFAULT_CHATGPT_PRO_LEASE_TTL_MS = 30 * 60 * 1000;

export interface ChatGptProCommonCliOptions {
  chatgptPro?: boolean;
  pro?: boolean;
  extendedReasoning?: boolean;
  remoteBrowser?: string;
  json?: boolean;
}

export interface ChatGptProDoctorPlan {
  pro: boolean;
  extended_reasoning: boolean;
  remote_browser: ChatGptProRemoteBrowserMode;
  json: boolean;
}

export interface ChatGptProLeaseCliOptions extends ChatGptProCommonCliOptions {
  ttl?: string | number;
  ttlMs?: number;
  ttlSeconds?: string | number;
}

export interface ChatGptProLeasePlan extends ChatGptProDoctorPlan {
  provider: "chatgpt";
  require: "pro";
  ttl_ms: number;
  ttl_seconds: number;
}

export interface ChatGptProRunCliOptions extends ChatGptProCommonCliOptions {
  provider?: string;
  engine?: string;
  model?: string;
  prompt?: string;
  promptFile?: string;
  evidence?: string;
  dryRun?: boolean | string;
}

export interface ChatGptProRunPlan {
  schema_version: typeof CHATGPT_PRO_RUN_SCHEMA_VERSION;
  dry_run: boolean;
  live_call: boolean;
  provider: "chatgpt";
  engine: "browser";
  model: ChatGptProBrowserModel;
  extended_reasoning: true;
  remote_browser: ChatGptProRemoteBrowserMode;
  evidence: {
    mode: ChatGptProEvidenceMode;
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

export interface ChatGptProRunEnvelope {
  schema_version: typeof JSON_ENVELOPE_SCHEMA_VERSION;
  ok: boolean;
  data: ChatGptProRunPlan | null;
  meta: {
    command: "oracle chatgpt run";
    generated_at: string;
    schema_version: typeof CHATGPT_PRO_RUN_SCHEMA_VERSION;
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

export interface ChatGptProRunIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export class ChatGptProCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly nextCommand: string | null = null,
    readonly fixCommand: string | null = null,
    readonly retrySafe = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ChatGptProCliError";
  }
}

export function addChatGptProDoctorFlags(command: Command): Command {
  addBooleanFlag(command, "--chatgpt-pro", "Alias for --pro; require ChatGPT Pro route readiness.");
  addBooleanFlag(command, "--pro", "Require ChatGPT Pro route readiness.");
  addBooleanFlag(command, "--extended-reasoning", "Require highest visible reasoning controls.");
  addRemoteBrowserFlag(command);
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function addChatGptProLeaseFlags(command: Command): Command {
  addBooleanFlag(command, "--chatgpt-pro", "Acquire a ChatGPT Pro protected-route lease.");
  addBooleanFlag(command, "--extended-reasoning", "Require highest visible reasoning controls.");
  addRemoteBrowserFlag(command);
  addOptionIfMissing(
    command,
    new Option("--ttl <duration>", "Lease TTL (for example 30m, 10m, or 1h).")
      .argParser((value) => parseRequiredDuration(value, "ChatGPT Pro lease TTL"))
      .default(DEFAULT_CHATGPT_PRO_LEASE_TTL_MS),
  );
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function addChatGptProRunFlags(command: Command): Command {
  addOptionIfMissing(command, new Option("--engine <mode>", "Execution engine."));
  addOptionIfMissing(command, new Option("--provider <provider>", "Browser provider."));
  addOptionIfMissing(command, new Option("--model <model>", "Browser model route."));
  addBooleanFlag(command, "--chatgpt-pro", "Use the protected ChatGPT Pro browser route.");
  addBooleanFlag(command, "--extended-reasoning", "Require highest visible reasoning controls.");
  addRemoteBrowserFlag(command);
  addOptionIfMissing(
    command,
    new Option("--evidence <mode>", "Evidence policy for protected browser runs.")
      .choices([...CHATGPT_PRO_EVIDENCE_MODES])
      .argParser(parseChatGptProEvidenceOption)
      .default("redacted"),
  );
  addOptionIfMissing(command, new Option("--prompt-file <path>", "Read the prompt from a file."));
  addOptionIfMissing(command, new Option("--prompt <text>", "Prompt text."));
  addOptionIfMissing(
    command,
    new Option("--dry-run [mode]", "Preview without submitting to ChatGPT.")
      .choices(["summary", "json", "full"])
      .preset("summary")
      .default(false),
  );
  addBooleanFlag(command, "--json", "Print structured JSON.");
  return command;
}

export function normalizeChatGptProDoctorOptions(
  options: ChatGptProCommonCliOptions = {},
): ChatGptProDoctorPlan {
  return {
    pro: Boolean(options.chatgptPro || options.pro),
    extended_reasoning: Boolean(options.extendedReasoning),
    remote_browser: parseChatGptProRemoteBrowserOption(options.remoteBrowser),
    json: Boolean(options.json),
  };
}

export function normalizeChatGptProLeaseOptions(
  options: ChatGptProLeaseCliOptions = {},
): ChatGptProLeasePlan {
  const doctor = normalizeChatGptProDoctorOptions({ ...options, pro: true });
  const ttlMs = normalizeLeaseTtlMs(options);
  return {
    ...doctor,
    provider: "chatgpt",
    require: "pro",
    ttl_ms: ttlMs,
    ttl_seconds: Math.ceil(ttlMs / 1000),
  };
}

export function normalizeChatGptProRunOptions(
  options: ChatGptProRunCliOptions = {},
): ChatGptProRunPlan {
  if (!options.chatgptPro) {
    throw new ChatGptProCliError(
      "--chatgpt-pro is required for the protected ChatGPT Pro route.",
      "chatgpt_pro_flag_required",
      null,
      "--chatgpt-pro",
      false,
    );
  }

  const engine = normalizeText(options.engine, "browser");
  if (engine !== "browser") {
    throw new ChatGptProCliError(
      "ChatGPT Pro protected routes require --engine browser.",
      "chatgpt_pro_requires_browser_engine",
      null,
      "--engine browser",
      false,
      { engine },
    );
  }

  const provider = normalizeText(options.provider, "chatgpt");
  if (provider !== "chatgpt") {
    throw new ChatGptProCliError(
      "ChatGPT Pro protected routes require --provider chatgpt.",
      "chatgpt_pro_requires_chatgpt_provider",
      null,
      "--provider chatgpt",
      false,
      { provider },
    );
  }

  if (options.extendedReasoning !== true) {
    throw new ChatGptProCliError(
      "ChatGPT Pro protected routes require --extended-reasoning.",
      "chatgpt_pro_extended_reasoning_required",
      "oracle doctor chatgpt --pro --extended-reasoning --json",
      "--extended-reasoning",
      false,
    );
  }

  const model = normalizeProtectedModel(options.model);
  const remoteBrowser = parseChatGptProRemoteBrowserOption(options.remoteBrowser);
  const evidence = parseChatGptProEvidenceOption(options.evidence);
  const promptSource = normalizePromptSource(options);
  const dryRun = options.dryRun !== undefined && options.dryRun !== false;
  const plan: ChatGptProRunPlan = {
    schema_version: CHATGPT_PRO_RUN_SCHEMA_VERSION,
    dry_run: dryRun,
    live_call: !dryRun,
    provider: "chatgpt",
    engine: "browser",
    model,
    extended_reasoning: true,
    remote_browser: remoteBrowser,
    evidence: { mode: evidence, redacted: true },
    prompt_source: promptSource,
    protected_route: {
      doctor_command: `oracle doctor chatgpt --pro --extended-reasoning --remote-browser ${remoteBrowser} --json`,
      lease_command: `oracle chatgpt lease --pro --extended-reasoning --ttl 30m --remote-browser ${remoteBrowser} --json`,
      run_command: buildRunCommand(model, remoteBrowser, evidence, promptSource),
    },
  };
  return plan;
}

export function buildChatGptProRunEnvelope(
  options: ChatGptProRunCliOptions,
  deps: { now?: () => Date } = {},
): ChatGptProRunEnvelope {
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
  try {
    const plan = normalizeChatGptProRunOptions(options);
    return {
      schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
      ok: true,
      data: plan,
      meta: {
        command: "oracle chatgpt run",
        generated_at: generatedAt,
        schema_version: CHATGPT_PRO_RUN_SCHEMA_VERSION,
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

export async function runChatGptProDryRun(
  options: ChatGptProRunCliOptions,
  io: ChatGptProRunIo = {},
): Promise<ChatGptProRunEnvelope> {
  const envelope = buildChatGptProRunEnvelope({ ...options, dryRun: options.dryRun ?? true });
  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(options.json ? stableJsonStringify(envelope) : formatChatGptProRunEnvelope(envelope));
  return envelope;
}

export function formatChatGptProRunEnvelope(envelope: ChatGptProRunEnvelope): string {
  if (!envelope.ok) {
    const message = envelope.errors[0]?.message ?? "ChatGPT Pro run is blocked.";
    return `blocked: ${envelope.blocked_reason}\n${message}`;
  }
  const data = envelope.data;
  return [
    `chatgpt pro run: ${data?.dry_run ? "dry-run" : "ready"}`,
    `route: ${data?.engine}/${data?.provider}; model=${data?.model}`,
    `remote_browser: ${data?.remote_browser}`,
    `evidence: ${data?.evidence.mode}`,
  ].join("\n");
}

function normalizeProtectedModel(value: string | undefined): ChatGptProBrowserModel {
  try {
    return normalizeChatGptProModelOption(value);
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      throw new ChatGptProCliError(
        error.message,
        "chatgpt_pro_model_downgrade_forbidden",
        null,
        `--model ${CHATGPT_PRO_BROWSER_MODEL}`,
        false,
        { model: value ?? null },
      );
    }
    throw error;
  }
}

function normalizePromptSource(
  options: ChatGptProRunCliOptions,
): ChatGptProRunPlan["prompt_source"] {
  const promptFile = options.promptFile?.trim();
  if (promptFile) {
    return { kind: "file", path: promptFile, redacted: true };
  }
  if (options.prompt?.trim()) {
    return { kind: "inline", redacted: true };
  }
  throw new ChatGptProCliError(
    "Prompt is required for ChatGPT Pro runs; pass --prompt-file or --prompt.",
    "chatgpt_pro_prompt_required",
    null,
    "--prompt-file PROMPT.md",
    false,
  );
}

function normalizeLeaseTtlMs(options: ChatGptProLeaseCliOptions): number {
  if (options.ttl !== undefined) {
    return normalizeDurationMs(options.ttl, "ChatGPT Pro lease TTL");
  }
  if (options.ttlMs !== undefined) {
    return normalizePositiveMs(options.ttlMs, "ChatGPT Pro lease TTL");
  }
  if (options.ttlSeconds !== undefined) {
    const seconds =
      typeof options.ttlSeconds === "string"
        ? Number.parseFloat(options.ttlSeconds)
        : options.ttlSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new InvalidArgumentError("ChatGPT Pro lease TTL seconds must be positive.");
    }
    return Math.ceil(seconds * 1000);
  }
  return DEFAULT_CHATGPT_PRO_LEASE_TTL_MS;
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
      .choices([...CHATGPT_PRO_REMOTE_BROWSER_MODES])
      .argParser(parseChatGptProRemoteBrowserOption)
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

function buildRunCommand(
  model: ChatGptProBrowserModel,
  remoteBrowser: ChatGptProRemoteBrowserMode,
  evidence: ChatGptProEvidenceMode,
  promptSource: ChatGptProRunPlan["prompt_source"],
): string {
  const promptPart =
    promptSource.kind === "file"
      ? `--prompt-file ${quoteCliArg(promptSource.path)}`
      : "--prompt <redacted>";
  return [
    "oracle --engine browser --provider chatgpt",
    `--model ${model}`,
    "--chatgpt-pro",
    "--extended-reasoning",
    `--remote-browser ${remoteBrowser}`,
    `--evidence ${evidence}`,
    promptPart,
    "--json",
  ].join(" ");
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function failureEnvelope(error: unknown, generatedAt: string): ChatGptProRunEnvelope {
  const normalized = normalizeError(error);
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    data: null,
    meta: {
      command: "oracle chatgpt run",
      generated_at: generatedAt,
      schema_version: CHATGPT_PRO_RUN_SCHEMA_VERSION,
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
  if (error instanceof ChatGptProCliError) {
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
      code: "invalid_chatgpt_pro_option",
      message: error.message,
      nextCommand: null,
      fixCommand: null,
      retrySafe: false,
      details: {},
    };
  }
  return {
    code: "chatgpt_pro_run_failed",
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
