import fs from "node:fs/promises";
import path from "node:path";
import { sessionStore, type SessionStore } from "../../../sessionStore.js";
import {
  runChatGptDoctor,
  type ProviderDoctorEnvelope,
  type ProviderDoctorRemoteBrowserMode,
} from "./chatgpt.js";
import { runGeminiDoctor } from "./gemini.js";

export type AggregateDoctorStatus = "pass" | "warn" | "fail" | "unknown";

export interface AggregateDoctorCheck {
  component: string;
  status: AggregateDoctorStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  next_command?: string | null;
  fix_command?: string | null;
  retry_safe?: boolean | null;
}

export interface AggregateDoctorData {
  schema_version: "oracle_doctor.v1";
  status: "ready" | "blocked" | "degraded" | "unknown";
  checks: AggregateDoctorCheck[];
  providers: {
    chatgpt: ProviderDoctorEnvelope;
    gemini: ProviderDoctorEnvelope;
  };
  remote_bridge: AggregateDoctorCheck;
  session_storage: AggregateDoctorCheck;
  provider_docs?: AggregateDoctorCheck;
  browser_leases?: AggregateDoctorCheck;
  evidence_storage?: AggregateDoctorCheck;
}

export interface AggregateDoctorEnvelope {
  schema_version: "json_envelope.v1";
  ok: boolean;
  data: AggregateDoctorData;
  meta: {
    command: "oracle doctor --json";
    generated_at: string;
  };
  blocked_reason: string | null;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean | null;
  errors: Array<Record<string, unknown>>;
  warnings: string[];
  commands: Record<string, string>;
}

export interface AggregateDoctorOptions {
  json?: boolean;
  remoteBrowser?: ProviderDoctorRemoteBrowserMode;
  now?: () => Date;
  sessionStore?: Pick<SessionStore, "ensureStorage" | "sessionsDir" | "listSessions">;
  chatgptDoctor?: () => Promise<ProviderDoctorEnvelope>;
  geminiDoctor?: () => Promise<ProviderDoctorEnvelope>;
  remoteBridgeDoctor?: () => Promise<AggregateDoctorCheck>;
  sessionStorageCheck?: () => Promise<AggregateDoctorCheck>;
  providerDocsCheck?: () => Promise<AggregateDoctorCheck>;
  browserLeasesCheck?: () => Promise<AggregateDoctorCheck>;
  evidenceStorageCheck?: () => Promise<AggregateDoctorCheck>;
}

export interface AggregateDoctorIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runAggregateDoctor(
  options: AggregateDoctorOptions = {},
  io: AggregateDoctorIo = {},
): Promise<AggregateDoctorEnvelope> {
  const store = options.sessionStore ?? sessionStore;
  const remoteBrowser = options.remoteBrowser ?? "preferred";
  const [
    chatgpt,
    gemini,
    remoteBridge,
    sessionStorage,
    providerDocs,
    browserLeases,
    evidenceStorage,
  ] = await Promise.all([
    runCheck(
      () => options.chatgptDoctor?.() ?? defaultChatGptDoctor(store, remoteBrowser),
      "chatgpt_doctor",
    ),
    runCheck(
      () => options.geminiDoctor?.() ?? defaultGeminiDoctor(store, remoteBrowser),
      "gemini_doctor",
    ),
    runCheck(
      () => options.remoteBridgeDoctor?.() ?? defaultRemoteBridgeDoctor(),
      "remote_bridge_doctor",
    ),
    runCheck(
      () => options.sessionStorageCheck?.() ?? defaultSessionStorageCheck(store),
      "session_storage",
    ),
    runOptionalCheck(options.providerDocsCheck),
    runOptionalCheck(options.browserLeasesCheck),
    runOptionalCheck(options.evidenceStorageCheck),
  ]);

  const providerChecks = [
    providerEnvelopeToCheck("chatgpt", chatgpt as ProviderDoctorEnvelope),
    providerEnvelopeToCheck("gemini", gemini as ProviderDoctorEnvelope),
  ];
  const optionalChecks = [providerDocs, browserLeases, evidenceStorage].filter(
    (check): check is AggregateDoctorCheck => Boolean(check),
  );
  const checks = [
    ...providerChecks,
    remoteBridge as AggregateDoctorCheck,
    sessionStorage as AggregateDoctorCheck,
    ...optionalChecks,
  ];
  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn" || check.status === "unknown");
  const ok = failures.length === 0;
  const data: AggregateDoctorData = {
    schema_version: "oracle_doctor.v1",
    status: !ok
      ? "blocked"
      : warnings.some((check) => check.status === "warn")
        ? "degraded"
        : warnings.some((check) => check.status === "unknown")
          ? "unknown"
          : "ready",
    checks,
    providers: {
      chatgpt: chatgpt as ProviderDoctorEnvelope,
      gemini: gemini as ProviderDoctorEnvelope,
    },
    remote_bridge: remoteBridge as AggregateDoctorCheck,
    session_storage: sessionStorage as AggregateDoctorCheck,
    ...(providerDocs ? { provider_docs: providerDocs } : {}),
    ...(browserLeases ? { browser_leases: browserLeases } : {}),
    ...(evidenceStorage ? { evidence_storage: evidenceStorage } : {}),
  };
  const envelope: AggregateDoctorEnvelope = {
    schema_version: "json_envelope.v1",
    ok,
    data,
    meta: {
      command: "oracle doctor --json",
      generated_at: (options.now?.() ?? new Date()).toISOString(),
    },
    blocked_reason: failures[0]?.code ?? null,
    next_command: firstAction(failures, "next_command") ?? firstAction(warnings, "next_command"),
    fix_command: firstAction(failures, "fix_command") ?? firstAction(warnings, "fix_command"),
    retry_safe: failures[0]?.retry_safe ?? (failures.length ? false : null),
    errors: failures.map(checkToIssue),
    warnings: warnings.map((check) => `${check.component}:${check.code}`),
    commands: {
      chatgpt_doctor: "oracle doctor chatgpt --json",
      gemini_doctor: "oracle doctor gemini --json",
      remote_doctor: "oracle remote doctor --json",
      bridge_doctor: "oracle bridge doctor --json",
      browser_leases_recover: "oracle browser leases recover --json",
      evidence_verify: "oracle evidence verify <session>",
    },
  };
  writeAggregateDoctorEnvelope(envelope, options, io);
  return envelope;
}

export function writeAggregateDoctorEnvelope(
  envelope: AggregateDoctorEnvelope,
  options: { json?: boolean },
  io: AggregateDoctorIo,
): void {
  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(options.json ? JSON.stringify(envelope, null, 2) : formatAggregateDoctor(envelope));
}

function providerEnvelopeToCheck(
  provider: "chatgpt" | "gemini",
  envelope: ProviderDoctorEnvelope,
): AggregateDoctorCheck {
  const component = `${provider}_doctor`;
  if (!envelope.ok) {
    return {
      component,
      status: "fail",
      code: `${provider}_doctor_blocked`,
      message: `${provider} doctor reported blockers.`,
      details: { envelope },
      next_command: envelope.next_command ?? `oracle doctor ${provider} --json`,
      fix_command: envelope.fix_command,
      retry_safe: false,
    };
  }
  if (envelope.status === "degraded") {
    return {
      component,
      status: "warn",
      code: `${provider}_doctor_degraded`,
      message: `${provider} doctor reported warnings.`,
      details: { envelope },
      next_command: envelope.next_command,
      fix_command: envelope.fix_command,
      retry_safe: true,
    };
  }
  if (envelope.status === "unknown") {
    return {
      component,
      status: "unknown",
      code: `${provider}_doctor_unknown`,
      message: `${provider} doctor could not fully verify readiness.`,
      details: { envelope },
      next_command: envelope.next_command ?? `oracle doctor ${provider} --json`,
      fix_command: envelope.fix_command,
      retry_safe: true,
    };
  }
  return {
    component,
    status: "pass",
    code: `${provider}_doctor_ready`,
    message: `${provider} doctor is ready.`,
    details: { envelope },
    retry_safe: true,
  };
}

async function defaultChatGptDoctor(
  store: Pick<SessionStore, "listSessions">,
  remoteBrowser: ProviderDoctorRemoteBrowserMode,
): Promise<ProviderDoctorEnvelope> {
  return runChatGptDoctor(
    {
      json: true,
      pro: true,
      extendedReasoning: true,
      remoteBrowser,
      sessionStore: store,
    },
    { stdout: () => {} },
  );
}

async function defaultGeminiDoctor(
  store: Pick<SessionStore, "listSessions">,
  remoteBrowser: ProviderDoctorRemoteBrowserMode,
): Promise<ProviderDoctorEnvelope> {
  return runGeminiDoctor(
    {
      json: true,
      deepThink: true,
      remoteBrowser,
      sessionStore: store,
    },
    { stdout: () => {} },
  );
}

async function defaultRemoteBridgeDoctor(): Promise<AggregateDoctorCheck> {
  const previousExitCode = process.exitCode;
  const originalLog = console.log;
  let output = "";
  try {
    console.log = (message?: unknown) => {
      output += `${String(message ?? "")}\n`;
    };
    const { runBridgeDoctor } = await import("../../bridge/doctor.js");
    await runBridgeDoctor({ json: true });
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }

  const parsed = JSON.parse(output || "{}") as {
    status?: string;
    mode?: string;
    host_hash?: string | null;
    error?: string;
  };
  if (parsed.status === "healthy" || parsed.status === "not_configured") {
    return {
      component: "remote_bridge",
      status: "pass",
      code: parsed.status === "healthy" ? "remote_bridge_healthy" : "remote_bridge_not_configured",
      message:
        parsed.status === "healthy"
          ? "Remote bridge doctor is healthy."
          : "Remote bridge is not configured; local browser path remains available.",
      details: { endpoint: parsed },
      retry_safe: true,
    };
  }
  const code =
    parsed.status === "missing_token" ? "remote_token_missing" : "remote_bridge_unhealthy";
  return {
    component: "remote_bridge",
    status: "fail",
    code,
    message: parsed.error ?? `Remote bridge status is ${parsed.status ?? "unknown"}.`,
    details: { endpoint: parsed },
    next_command: "oracle remote doctor --json",
    fix_command: code === "remote_token_missing" ? "export ORACLE_REMOTE_TOKEN=<token>" : null,
    retry_safe: parsed.status === "unreachable",
  };
}

async function defaultSessionStorageCheck(
  store: Pick<SessionStore, "ensureStorage" | "sessionsDir">,
): Promise<AggregateDoctorCheck> {
  try {
    await store.ensureStorage();
    const sessionsDir = store.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.access(sessionsDir);
    return {
      component: "session_storage",
      status: "pass",
      code: "session_storage_available",
      message: "Oracle session storage is available.",
      details: { sessions_dir: sessionsDir },
      retry_safe: true,
    };
  } catch (error) {
    const sessionsDir = safeSessionsDir(store);
    return {
      component: "session_storage",
      status: "fail",
      code: "session_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
      details: { sessions_dir: sessionsDir },
      fix_command: sessionsDir ? `mkdir -p ${shellQuote(path.dirname(sessionsDir))}` : null,
      retry_safe: false,
    };
  }
}

async function runCheck<T>(
  callback: () => Promise<T>,
  component: string,
): Promise<T | AggregateDoctorCheck> {
  try {
    return await callback();
  } catch (error) {
    return {
      component,
      status: "fail",
      code: `${component}_error`,
      message: error instanceof Error ? error.message : String(error),
      retry_safe: false,
    };
  }
}

async function runOptionalCheck(
  callback: (() => Promise<AggregateDoctorCheck>) | undefined,
): Promise<AggregateDoctorCheck | undefined> {
  if (!callback) return undefined;
  return runCheck(callback, "optional_check") as Promise<AggregateDoctorCheck>;
}

function firstAction(
  checks: AggregateDoctorCheck[],
  key: "next_command" | "fix_command",
): string | null {
  return checks.find((check) => check[key])?.[key] ?? null;
}

function checkToIssue(check: AggregateDoctorCheck): Record<string, unknown> {
  return {
    component: check.component,
    code: check.code,
    message: check.message,
    details: check.details ?? null,
  };
}

function formatAggregateDoctor(envelope: AggregateDoctorEnvelope): string {
  const lines = [
    `oracle doctor: ${envelope.data.status}`,
    `Checks: ${envelope.data.checks.length}`,
  ];
  for (const check of envelope.data.checks) {
    lines.push(`- ${check.status} ${check.component}: ${check.message}`);
  }
  if (envelope.fix_command) {
    lines.push(`Fix: ${envelope.fix_command}`);
  }
  if (envelope.next_command) {
    lines.push(`Next: ${envelope.next_command}`);
  }
  return lines.join("\n");
}

function safeSessionsDir(store: Pick<SessionStore, "sessionsDir">): string | null {
  try {
    return store.sessionsDir();
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
