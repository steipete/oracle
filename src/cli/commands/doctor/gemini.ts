import { Command } from "commander";
import {
  buildProviderDoctorEnvelope,
  normalizeRemoteBrowser,
  recentSessionCheck,
  uiProbeToCheck,
  writeProviderDoctorEnvelope,
  type ProviderDoctorEnvelope,
  type ProviderDoctorIo,
  type ProviderDoctorRemoteBrowserMode,
  type ProviderProbeResult,
  type ProviderUiProbeResult,
} from "./chatgpt.js";
import { sessionStore, type SessionStore } from "../../../sessionStore.js";

export interface GeminiDoctorOptions {
  json?: boolean;
  deepThink?: boolean;
  remoteBrowser?: ProviderDoctorRemoteBrowserMode;
  env?: NodeJS.ProcessEnv;
  sessionStore?: Pick<SessionStore, "listSessions">;
  authProbe?: () => Promise<ProviderProbeResult>;
  uiProbe?: () => Promise<ProviderUiProbeResult>;
}

export function registerGeminiDoctorCommand(
  doctorCommand: Command,
  deps: Partial<GeminiDoctorOptions> = {},
): Command {
  return doctorCommand
    .command("gemini")
    .description("Check Gemini browser/API readiness without submitting a prompt.")
    .option("--deep-think", "Require Gemini Deep Think browser route readiness.", false)
    .option(
      "--remote-browser <mode>",
      "Remote browser policy (preferred|required|off).",
      "preferred",
    )
    .option("--json", "Print structured JSON.", false)
    .action(async (options: GeminiDoctorOptions) => {
      const envelope = await runGeminiDoctor({ ...deps, ...options });
      if (!envelope.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runGeminiDoctor(
  options: GeminiDoctorOptions = {},
  io: ProviderDoctorIo = {},
): Promise<ProviderDoctorEnvelope> {
  const remoteBrowser = normalizeRemoteBrowser(options.remoteBrowser);
  const sessions = await (options.sessionStore ?? sessionStore).listSessions().catch(() => []);
  const checks = [
    { name: "auth", ...(await (options.authProbe ?? (() => defaultGeminiAuthProbe(options)))()) },
    recentSessionCheck("gemini", sessions),
    uiProbeToCheck("gemini", remoteBrowser, await runGeminiUiProbe(options.uiProbe)),
  ];
  const envelope = buildProviderDoctorEnvelope("gemini", checks, {
    deep_think: Boolean(options.deepThink),
    remote_browser: remoteBrowser,
  });
  writeProviderDoctorEnvelope(envelope, options, io);
  return envelope;
}

async function defaultGeminiAuthProbe(options: GeminiDoctorOptions): Promise<ProviderProbeResult> {
  const env = options.env ?? process.env;
  if (env.GEMINI_API_KEY?.trim()) {
    return {
      status: "pass",
      code: "gemini_api_key_configured",
      message: "GEMINI_API_KEY is configured for Gemini API checks.",
    };
  }
  if (env.ORACLE_BROWSER_INLINE_COOKIES || env.ORACLE_BROWSER_INLINE_COOKIES_FILE) {
    return {
      status: "pass",
      code: "browser_cookies_configured",
      message: "Inline browser cookies are configured for Gemini web checks.",
    };
  }
  return {
    status: "fail",
    code: "provider_login_required",
    message: "Gemini auth was not found. Set GEMINI_API_KEY or sign in to gemini.google.com.",
    fix_command: "export GEMINI_API_KEY=<key>",
    next_command: "oracle doctor gemini --json",
  };
}

async function runGeminiUiProbe(
  probe: (() => Promise<ProviderUiProbeResult>) | undefined,
): Promise<ProviderUiProbeResult> {
  if (!probe) {
    return { status: "skipped", message: "Live Gemini UI probe was not requested." };
  }
  return probe();
}
