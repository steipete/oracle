import { Command } from "commander";
import {
  addChatGptProRunFlags,
  buildChatGptProRunEnvelope,
  formatChatGptProRunEnvelope,
  type ChatGptProRunCliOptions,
  type ChatGptProRunEnvelope,
  type ChatGptProRunPlan,
} from "./chatgptPro.js";
import {
  addGeminiDeepThinkRunFlags,
  buildGeminiDeepThinkRunEnvelope,
  formatGeminiDeepThinkRunEnvelope,
  isGeminiDeepThinkProviderAlias,
  type GeminiDeepThinkRunCliOptions,
  type GeminiDeepThinkRunEnvelope,
  type GeminiDeepThinkRunPlan,
} from "./geminiDeepThink.js";

const JSON_ENVELOPE_SCHEMA_VERSION = "json_envelope.v1" as const;

export type ProtectedRunProvider = "chatgpt" | "gemini";
export type ProtectedRunEnvelope =
  | ChatGptProRunEnvelope
  | GeminiDeepThinkRunEnvelope
  | ProtectedRunDispatchEnvelope;

export interface ProtectedRunCliOptions
  extends ChatGptProRunCliOptions, GeminiDeepThinkRunCliOptions {
  provider?: string;
  json?: boolean;
}

export interface ProtectedRunCommandDeps extends ProtectedRunCommandIo {
  now?: () => Date;
}

export interface ProtectedRunCommandIo {
  stdout?: (text: string) => void;
}

export interface ProtectedRunDispatchEnvelope {
  schema_version: typeof JSON_ENVELOPE_SCHEMA_VERSION;
  ok: false;
  data: null;
  meta: {
    command: "oracle run";
    generated_at: string;
  };
  blocked_reason: string;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean;
  errors: Array<{
    error_code: string;
    message: string;
    details: Record<string, unknown>;
  }>;
  warnings: string[];
  commands: Record<string, unknown>;
}

export function registerProtectedRunCommand(
  program: Command,
  deps: ProtectedRunCommandDeps = {},
): Command {
  const run = program
    .command("run")
    .description("Plan protected browser provider runs without submitting prompts.");
  addChatGptProRunFlags(run);
  addGeminiDeepThinkRunFlags(run);
  run.action(async (_options: ProtectedRunCliOptions, command: Command) => {
    const options = command.optsWithGlobals() as ProtectedRunCliOptions;
    const envelope = await runProtectedRunCommand(options, deps, deps);
    if (!envelope.ok) {
      process.exitCode = 1;
    }
  });
  return run;
}

export async function runProtectedRunCommand(
  options: ProtectedRunCliOptions,
  deps: ProtectedRunCommandDeps = {},
  io: ProtectedRunCommandIo = {},
): Promise<ProtectedRunEnvelope> {
  const route = resolveProtectedRunProvider(options);
  const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
  let envelope: ProtectedRunEnvelope;

  if (route === "chatgpt") {
    envelope = rewriteChatGptRunCommand(
      buildChatGptProRunEnvelope(
        { ...options, provider: "chatgpt" },
        { now: () => new Date(generatedAt) },
      ),
    );
  } else if (route === "gemini") {
    const providerAliasRequestsDeepThink = isGeminiDeepThinkProviderAlias(options.provider);
    envelope = rewriteGeminiRunCommand(
      buildGeminiDeepThinkRunEnvelope(
        {
          ...options,
          provider: "gemini",
          geminiDeepThink: options.geminiDeepThink || providerAliasRequestsDeepThink,
        },
        { now: () => new Date(generatedAt) },
      ),
    );
  } else {
    envelope = buildDispatchFailure(route, generatedAt);
  }

  writeProtectedRunEnvelope(envelope, options, io);
  return envelope;
}

function resolveProtectedRunProvider(
  options: ProtectedRunCliOptions,
): ProtectedRunProvider | "ambiguous" | "missing" | "unsupported" {
  const provider = normalizeProvider(options.provider);
  if (provider && provider !== "chatgpt" && provider !== "gemini") {
    return "unsupported";
  }
  const wantsChatGpt = provider === "chatgpt" || options.chatgptPro === true;
  const wantsGemini =
    provider === "gemini" || options.geminiDeepThink === true || options.deepThink === true;
  if (wantsChatGpt && wantsGemini) {
    return "ambiguous";
  }
  if (wantsChatGpt) {
    return "chatgpt";
  }
  if (wantsGemini) {
    return "gemini";
  }
  return "missing";
}

function rewriteChatGptRunCommand(envelope: ChatGptProRunEnvelope): ChatGptProRunEnvelope {
  if (!envelope.data) {
    return envelope;
  }
  const runCommand = chatGptRunCommand(envelope.data);
  return {
    ...envelope,
    data: {
      ...envelope.data,
      protected_route: {
        ...envelope.data.protected_route,
        run_command: runCommand,
      },
    },
    next_command: envelope.next_command ? runCommand : envelope.next_command,
    commands: { ...envelope.commands, run: runCommand },
  };
}

function rewriteGeminiRunCommand(envelope: GeminiDeepThinkRunEnvelope): GeminiDeepThinkRunEnvelope {
  if (!envelope.data) {
    return envelope;
  }
  const runCommand = geminiRunCommand(envelope.data);
  return {
    ...envelope,
    data: {
      ...envelope.data,
      protected_route: {
        ...envelope.data.protected_route,
        run_command: runCommand,
      },
    },
    next_command: envelope.next_command ? runCommand : envelope.next_command,
    commands: { ...envelope.commands, run: runCommand },
  };
}

function buildDispatchFailure(
  reason: Exclude<ReturnType<typeof resolveProtectedRunProvider>, ProtectedRunProvider>,
  generatedAt: string,
): ProtectedRunDispatchEnvelope {
  const message =
    reason === "ambiguous"
      ? "Choose exactly one protected browser provider route."
      : reason === "unsupported"
        ? "Protected browser runs only support provider chatgpt or gemini."
        : "Protected browser runs require --provider chatgpt or --provider gemini.";
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    data: null,
    meta: {
      command: "oracle run",
      generated_at: generatedAt,
    },
    blocked_reason: "protected_provider_required",
    next_command:
      "oracle run --provider chatgpt --chatgpt-pro --extended-reasoning --prompt <redacted> --json",
    fix_command: "--provider chatgpt|gemini",
    retry_safe: false,
    errors: [
      {
        error_code: "protected_provider_required",
        message,
        details: { reason },
      },
    ],
    warnings: [],
    commands: {
      chatgpt:
        "oracle run --provider chatgpt --chatgpt-pro --extended-reasoning --prompt <redacted> --json",
      gemini: "oracle run --provider gemini --gemini-deep-think --prompt <redacted> --json",
    },
  };
}

function writeProtectedRunEnvelope(
  envelope: ProtectedRunEnvelope,
  options: ProtectedRunCliOptions,
  io: ProtectedRunCommandIo,
): void {
  const writer = io.stdout ?? ((text: string) => console.log(text));
  if (options.json) {
    writer(stableJsonStringify(envelope));
    return;
  }
  if (envelope.meta.command === "oracle chatgpt run") {
    writer(formatChatGptProRunEnvelope(envelope as ChatGptProRunEnvelope));
    return;
  }
  if (envelope.meta.command === "oracle gemini run") {
    writer(formatGeminiDeepThinkRunEnvelope(envelope as GeminiDeepThinkRunEnvelope));
    return;
  }
  writer(`blocked: ${envelope.blocked_reason}\n${envelope.errors[0]?.message ?? "blocked"}`);
}

function chatGptRunCommand(plan: ChatGptProRunPlan): string {
  return [
    "oracle run",
    "--engine browser",
    "--provider chatgpt",
    `--model ${quoteCliArg(plan.model)}`,
    "--chatgpt-pro",
    "--extended-reasoning",
    `--remote-browser ${plan.remote_browser}`,
    `--evidence ${plan.evidence.mode}`,
    promptPart(plan.prompt_source),
    "--json",
  ].join(" ");
}

function geminiRunCommand(plan: GeminiDeepThinkRunPlan): string {
  return [
    "oracle run",
    "--engine browser",
    "--provider gemini",
    `--model ${quoteCliArg(plan.model)}`,
    "--gemini-deep-think",
    `--gemini-deep-think-fallback ${plan.fallback}`,
    `--remote-browser ${plan.remote_browser}`,
    `--evidence ${plan.evidence.mode}`,
    promptPart(plan.prompt_source),
    "--json",
  ].join(" ");
}

function promptPart(
  promptSource: ChatGptProRunPlan["prompt_source"] | GeminiDeepThinkRunPlan["prompt_source"],
): string {
  return promptSource.kind === "file"
    ? `--prompt-file ${quoteCliArg(promptSource.path)}`
    : "--prompt <redacted>";
}

function normalizeProvider(value: string | undefined): string | undefined {
  if (isGeminiDeepThinkProviderAlias(value)) {
    return "gemini";
  }
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
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
