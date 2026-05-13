import { Command } from "commander";
import { createRequire } from "node:module";
import { sessionStore, type SessionMetadata, type SessionStore } from "../../../sessionStore.js";

export type ProviderDoctorProvider = "chatgpt" | "gemini";
export type ProviderDoctorStatus = "pass" | "warn" | "fail" | "unknown";
export type ProviderDoctorRemoteBrowserMode = "preferred" | "required" | "off";

export interface ProviderDoctorCheck {
  name: string;
  status: ProviderDoctorStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fix_command?: string | null;
  next_command?: string | null;
}

export interface ProviderDoctorEnvelope {
  schema_version: "provider_doctor.v1";
  provider: ProviderDoctorProvider;
  ok: boolean;
  status: "ready" | "blocked" | "degraded" | "unknown";
  requested: Record<string, unknown>;
  checks: ProviderDoctorCheck[];
  blockers: ProviderDoctorCheck[];
  warnings: ProviderDoctorCheck[];
  next_command: string | null;
  fix_command: string | null;
}

export interface ProviderUiProbeResult {
  status:
    | "verified"
    | "login_required"
    | "ui_drift_suspected"
    | "remote_browser_unavailable"
    | "missing_effort_control"
    | "skipped";
  message?: string;
  selectorManifestVersion?: string;
  observedModeLabel?: string;
  observedEffortLabel?: string;
  effortRank?: string;
  remoteBrowser?: ProviderDoctorRemoteBrowserMode;
  details?: Record<string, unknown>;
}

export interface ProviderProbeResult {
  status: ProviderDoctorStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fix_command?: string | null;
  next_command?: string | null;
}

export interface ChatGptDoctorOptions {
  json?: boolean;
  pro?: boolean;
  extendedReasoning?: boolean;
  remoteBrowser?: ProviderDoctorRemoteBrowserMode;
  env?: NodeJS.ProcessEnv;
  sessionStore?: Pick<SessionStore, "listSessions">;
  cookieSyncProbe?: () => Promise<ProviderProbeResult>;
  keytarProbe?: () => Promise<ProviderProbeResult>;
  uiProbe?: () => Promise<ProviderUiProbeResult>;
}

export interface ProviderDoctorIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function registerChatGptDoctorCommand(
  doctorCommand: Command,
  deps: Partial<ChatGptDoctorOptions> = {},
): Command {
  return doctorCommand
    .command("chatgpt")
    .description("Check ChatGPT browser readiness without submitting a prompt.")
    .option("--pro", "Require ChatGPT Pro route readiness.", false)
    .option("--extended-reasoning", "Require visible highest reasoning effort controls.", false)
    .option(
      "--remote-browser <mode>",
      "Remote browser policy (preferred|required|off).",
      "preferred",
    )
    .option("--json", "Print structured JSON.", false)
    .action(async (options: ChatGptDoctorOptions) => {
      const envelope = await runChatGptDoctor({ ...deps, ...options });
      if (!envelope.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runChatGptDoctor(
  options: ChatGptDoctorOptions = {},
  io: ProviderDoctorIo = {},
): Promise<ProviderDoctorEnvelope> {
  const remoteBrowser = normalizeRemoteBrowser(options.remoteBrowser);
  const checks: ProviderDoctorCheck[] = [
    await toCheck(
      "cookie_sync",
      options.cookieSyncProbe ?? (() => defaultChatGptCookieSyncProbe(options)),
    ),
    await toCheck("browser_cookie_keytar", options.keytarProbe ?? defaultKeytarProbe),
    recentSessionCheck("chatgpt", await loadSessions(options.sessionStore)),
    uiProbeToCheck("chatgpt", remoteBrowser, await runUiProbe(options.uiProbe)),
  ];
  const envelope = buildProviderDoctorEnvelope("chatgpt", checks, {
    pro: Boolean(options.pro),
    extended_reasoning: Boolean(options.extendedReasoning),
    remote_browser: remoteBrowser,
  });
  writeProviderDoctorEnvelope(envelope, options, io);
  return envelope;
}

export function buildProviderDoctorEnvelope(
  provider: ProviderDoctorProvider,
  checks: ProviderDoctorCheck[],
  requested: Record<string, unknown>,
): ProviderDoctorEnvelope {
  const blockers = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn" || check.status === "unknown");
  const ok = blockers.length === 0;
  const status = !ok
    ? "blocked"
    : warnings.some((check) => check.status === "warn")
      ? "degraded"
      : warnings.some((check) => check.status === "unknown")
        ? "unknown"
        : "ready";
  return {
    schema_version: "provider_doctor.v1",
    provider,
    ok,
    status,
    requested,
    checks,
    blockers,
    warnings,
    next_command: firstAction(blockers, "next_command") ?? firstAction(warnings, "next_command"),
    fix_command: firstAction(blockers, "fix_command") ?? firstAction(warnings, "fix_command"),
  };
}

export function uiProbeToCheck(
  provider: ProviderDoctorProvider,
  remoteBrowser: ProviderDoctorRemoteBrowserMode,
  probe: ProviderUiProbeResult,
): ProviderDoctorCheck {
  const baseDetails = {
    selector_manifest_version: probe.selectorManifestVersion ?? null,
    observed_mode_label: probe.observedModeLabel ?? null,
    observed_effort_label: probe.observedEffortLabel ?? null,
    effort_rank: probe.effortRank ?? null,
    remote_browser: probe.remoteBrowser ?? remoteBrowser,
    ...(probe.details ?? {}),
  };
  switch (probe.status) {
    case "verified":
      return {
        name: "ui_mode",
        status: "pass",
        code: `${provider}_mode_verified`,
        message: probe.message ?? `${provider} protected mode is observable.`,
        details: baseDetails,
      };
    case "login_required":
      return {
        name: "ui_mode",
        status: "fail",
        code: "provider_login_required",
        message:
          probe.message ?? `${provider} login is required before browser doctor can verify mode.`,
        details: baseDetails,
        next_command: `oracle doctor ${provider} --json`,
        fix_command:
          provider === "chatgpt"
            ? "Sign in to chatgpt.com in Chrome."
            : "Sign in to gemini.google.com or set GEMINI_API_KEY.",
      };
    case "ui_drift_suspected":
      return {
        name: "ui_mode",
        status: "fail",
        code: `${provider}_ui_drift_suspected`,
        message:
          probe.message ?? `${provider} UI selectors did not match the expected mode controls.`,
        details: baseDetails,
        next_command: `oracle doctor ${provider} --json --verbose`,
      };
    case "remote_browser_unavailable":
      return {
        name: "ui_mode",
        status: remoteBrowser === "preferred" ? "warn" : "fail",
        code: "remote_browser_unavailable",
        message: probe.message ?? "Remote browser is unavailable.",
        details: baseDetails,
        next_command: "oracle remote doctor --json",
      };
    case "missing_effort_control":
      return {
        name: "ui_mode",
        status: "fail",
        code: "missing_effort_control",
        message: probe.message ?? `${provider} highest reasoning effort control is not visible.`,
        details: baseDetails,
        next_command: `oracle doctor ${provider} --json`,
      };
    case "skipped":
      return {
        name: "ui_mode",
        status: "unknown",
        code: "ui_probe_skipped",
        message: probe.message ?? "UI probe was skipped; no prompt was submitted.",
        details: baseDetails,
        next_command: `oracle doctor ${provider} --json`,
      };
  }
}

export function recentSessionCheck(
  provider: ProviderDoctorProvider,
  sessions: SessionMetadata[],
): ProviderDoctorCheck {
  const recent = findRecentProviderSession(provider, sessions);
  if (!recent) {
    return {
      name: "recent_session",
      status: "warn",
      code: "no_recent_provider_session",
      message: `No recent ${provider} browser session was found.`,
      next_command: `oracle doctor ${provider} --json`,
    };
  }
  const details = {
    session_id: recent.id,
    status: recent.status,
    model: recent.model ?? null,
    mode: recent.mode ?? null,
    tab_url: recent.browser?.runtime?.tabUrl ?? recent.browser?.harvest?.url ?? null,
    conversation_id: recent.browser?.runtime?.conversationId ?? null,
  };
  if (recent.status === "completed" || recent.status === "running") {
    return {
      name: "recent_session",
      status: "pass",
      code: "recent_provider_session_reachable",
      message: `Recent ${provider} session metadata is reachable.`,
      details,
    };
  }
  return {
    name: "recent_session",
    status: "warn",
    code: "recent_provider_session_not_healthy",
    message: `Most recent ${provider} session status is ${recent.status}.`,
    details,
    next_command: `oracle session ${recent.id}`,
  };
}

export function writeProviderDoctorEnvelope(
  envelope: ProviderDoctorEnvelope,
  options: { json?: boolean },
  io: ProviderDoctorIo,
): void {
  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(options.json ? JSON.stringify(envelope, null, 2) : formatProviderDoctor(envelope));
}

export function normalizeRemoteBrowser(value: string | undefined): ProviderDoctorRemoteBrowserMode {
  return value === "required" || value === "off" ? value : "preferred";
}

async function toCheck(
  name: string,
  probe: () => Promise<ProviderProbeResult>,
): Promise<ProviderDoctorCheck> {
  const result = await probe().catch((error) => ({
    status: "fail" as const,
    code: `${name}_probe_error`,
    message: error instanceof Error ? error.message : String(error),
  }));
  return { name, ...result };
}

async function defaultChatGptCookieSyncProbe(
  options: ChatGptDoctorOptions,
): Promise<ProviderProbeResult> {
  const env = options.env ?? process.env;
  if (env.ORACLE_BROWSER_INLINE_COOKIES || env.ORACLE_BROWSER_INLINE_COOKIES_FILE) {
    return {
      status: "pass",
      code: "inline_cookies_configured",
      message: "Inline ChatGPT cookies are configured.",
    };
  }
  if (env.ORACLE_BROWSER_NO_COOKIE_SYNC === "1" || env.ORACLE_BROWSER_NO_COOKIE_SYNC === "true") {
    return {
      status: "warn",
      code: "cookie_sync_disabled",
      message: "Chrome cookie sync is disabled by environment.",
      fix_command: "unset ORACLE_BROWSER_NO_COOKIE_SYNC",
    };
  }
  return {
    status: process.platform === "win32" ? "warn" : "unknown",
    code: process.platform === "win32" ? "manual_login_default" : "cookie_sync_not_probed",
    message:
      process.platform === "win32"
        ? "Windows defaults to manual-login browser sessions."
        : "Cookie sync is configured by default, but no live cookie read was attempted.",
    next_command: "oracle doctor chatgpt --json",
  };
}

async function defaultKeytarProbe(): Promise<ProviderProbeResult> {
  try {
    createRequire(import.meta.url).resolve("keytar");
    return {
      status: "pass",
      code: "keytar_available",
      message: "browser-cookie keytar dependency is importable.",
    };
  } catch (error) {
    return {
      status: "warn",
      code: "keytar_unavailable",
      message: `browser-cookie keytar dependency is not importable: ${(error as Error).message}`,
      fix_command: "Rebuild keytar in the pnpm cache if browser cookie sync fails.",
    };
  }
}

async function loadSessions(
  store: Pick<SessionStore, "listSessions"> | undefined,
): Promise<SessionMetadata[]> {
  return (store ?? sessionStore).listSessions().catch(() => []);
}

async function runUiProbe(
  probe: (() => Promise<ProviderUiProbeResult>) | undefined,
): Promise<ProviderUiProbeResult> {
  if (!probe) {
    return { status: "skipped", message: "Live UI probe was not requested." };
  }
  return probe();
}

function findRecentProviderSession(
  provider: ProviderDoctorProvider,
  sessions: SessionMetadata[],
): SessionMetadata | undefined {
  return sessions
    .filter((session) => matchesProvider(provider, session))
    .sort((left, right) => sessionTime(right) - sessionTime(left))[0];
}

function matchesProvider(provider: ProviderDoctorProvider, session: SessionMetadata): boolean {
  const model = `${session.model ?? session.options?.model ?? ""}`.toLowerCase();
  const desired = `${session.options?.browserConfig?.desiredModel ?? ""}`.toLowerCase();
  if (provider === "gemini") {
    return model.includes("gemini") || desired.includes("gemini");
  }
  return session.mode === "browser" && (model.startsWith("gpt-") || desired.includes("gpt"));
}

function sessionTime(session: SessionMetadata): number {
  return Date.parse(session.completedAt ?? session.startedAt ?? session.createdAt ?? "") || 0;
}

function firstAction(
  checks: ProviderDoctorCheck[],
  key: "next_command" | "fix_command",
): string | null {
  return checks.find((check) => check[key])?.[key] ?? null;
}

function formatProviderDoctor(envelope: ProviderDoctorEnvelope): string {
  const lines = [
    `oracle doctor ${envelope.provider}: ${envelope.status}`,
    `Checks: ${envelope.checks.length}`,
  ];
  for (const check of envelope.checks) {
    lines.push(`- ${check.status} ${check.name}: ${check.message}`);
  }
  if (envelope.fix_command) {
    lines.push(`Fix: ${envelope.fix_command}`);
  }
  if (envelope.next_command) {
    lines.push(`Next: ${envelope.next_command}`);
  }
  return lines.join("\n");
}
