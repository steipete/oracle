// `oracle remote attach --host <host:port> --token-env <ENV> [--json]`
//
// Diagnoses attach readiness against a caller-supplied host without
// modifying environment variables or user config. Reads the token from
// the env-var named by --token-env so the token never appears on the
// command line.

import chalk from "chalk";

import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import {
  annotateClientVersion,
  buildRemoteEndpointReport,
  isHealthyReport,
  reportLeaksToken,
} from "./endpointReport.js";

export interface RemoteAttachCliOptions {
  host: string;
  tokenEnv?: string;
  json?: boolean;
}

const DEFAULT_TOKEN_ENV = "ORACLE_REMOTE_TOKEN";

export async function runRemoteAttach(options: RemoteAttachCliOptions): Promise<void> {
  if (!options.host) {
    throw new Error("--host <host:port> is required for `oracle remote attach`.");
  }
  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  if (tokenEnv.length === 0) {
    throw new Error("--token-env must name a non-empty environment variable.");
  }
  const tokenValue = process.env[tokenEnv];
  if (tokenValue !== undefined && tokenValue.trim().length === 0) {
    throw new Error(`Environment variable ${tokenEnv} is set but empty.`);
  }

  const resolved = resolveRemoteServiceConfig({
    cliHost: options.host,
    // Pass the token from the named env var, not from a CLI flag, so it
    // never appears in argv / shell history.
    cliToken: tokenValue,
    cliMode: "preferred",
    userConfig: undefined,
    env: { ...process.env },
    // oracle-72u: `--host` is an explicit attach target — it MUST win
    // over a stale ORACLE_REMOTE_HOST. Without this flag the resolver
    // returns the env-var's host, so the probe would diagnose the
    // wrong endpoint silently. attach is a diagnostic surface; the
    // user's typed host is the intent.
    preferCli: true,
  });

  const { report } = await buildRemoteEndpointReport({
    resolved,
    tokenEnvName: tokenEnv,
    env: { ...process.env, [tokenEnv]: tokenValue ?? "" },
  });

  // Last-line guard: never emit the raw token.
  if (reportLeaksToken(report, tokenValue)) {
    throw new Error("internal: attach report would leak the raw token; refusing to print.");
  }
  const annotated = annotateClientVersion(report);

  if (options.json) {
    console.log(JSON.stringify(annotated, null, 2));
    process.exitCode = isHealthyReport(report) ? 0 : 1;
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold("🧿 oracle remote attach"));
  lines.push(chalk.dim(`host: ${options.host}`));
  lines.push(chalk.dim(`token_env: ${tokenEnv} (${tokenValue ? "set" : "unset"})`));
  lines.push(chalk.dim(`status: ${report.status}`));
  if (report.error) {
    lines.push(chalk.red(`Error: ${report.error}`));
  }
  if (report.status === "healthy" && report.version) {
    lines.push(chalk.green(`Connected to oracle ${report.version}.`));
  }
  console.log(lines.join("\n"));
  process.exitCode = isHealthyReport(report) ? 0 : 1;
}
