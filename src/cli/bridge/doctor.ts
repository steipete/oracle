import os from "node:os";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { getCliVersion } from "../../version.js";
import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import { checkTcpConnection, checkRemoteHealth } from "../../remote/health.js";
import { detectChromeBinary, detectChromeCookieDb } from "../../browser/detect.js";
import { formatCodexMcpSnippet } from "./codexConfig.js";

import type { RemoteBrowserEndpointV1 } from "../../remote/types.js";
import type { RemoteHealthResult } from "../../remote/health.js";

export interface BridgeDoctorCliOptions {
  verbose?: boolean;
  json?: boolean;
}

type ResolveRemoteServiceConfigInput = Parameters<typeof resolveRemoteServiceConfig>[0];
type ResolvedRemoteServiceConfig = ReturnType<typeof resolveRemoteServiceConfig>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function applyHealthMetadata(endpoint: RemoteBrowserEndpointV1, health: RemoteHealthResult): void {
  endpoint.version = health.version ?? null;
  endpoint.uptimeSeconds = health.uptimeSeconds ?? null;
  endpoint.auth_profile_id_hash = health.authProfileIdHash ?? null;
  endpoint.provider_locks = health.providerLocks ?? [];
}

function formatHealthFailure(health: RemoteHealthResult): string | undefined {
  if (!health.statusCode) {
    return health.error;
  }
  return `HTTP ${health.statusCode} (${health.error ?? "unknown error"})`;
}

function resolveRemoteServiceConfigForDoctor(
  input: ResolveRemoteServiceConfigInput,
): ResolvedRemoteServiceConfig {
  try {
    return resolveRemoteServiceConfig(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("remote_browser_token_missing")) {
      throw error;
    }

    const env = input.env ?? process.env;
    const envHost = normalizeOptionalString(env.ORACLE_REMOTE_HOST);
    const cliHost = normalizeOptionalString(input.cliHost);
    const configHost = normalizeOptionalString(input.userConfig?.browser?.remoteHost);
    const host = envHost ?? cliHost ?? configHost;
    const source = envHost ? "env" : cliHost ? "cli" : configHost ? "config.browser" : "unset";

    return {
      host,
      token: undefined,
      mode: "preferred",
      hostHash: host ? createHash("sha256").update(host).digest("hex").slice(0, 12) : undefined,
      redactedToken: undefined,
      sources: { host: source, token: "unset", mode: "default" },
    } as ResolvedRemoteServiceConfig;
  }
}

export async function runBridgeDoctor(options: BridgeDoctorCliOptions): Promise<void> {
  const { config: userConfig, path: configPath, loaded } = await loadUserConfig();
  const version = getCliVersion();

  const resolvedRemote = resolveRemoteServiceConfigForDoctor({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  if (options.json) {
    const endpoint: RemoteBrowserEndpointV1 = {
      _schema: "remote_browser_endpoint.v1",
      endpoint_id: resolvedRemote.hostHash || "local",
      mode: resolvedRemote.mode,
      status: "unknown",
      host_env: process.env.ORACLE_REMOTE_HOST || null,
      token_env: process.env.ORACLE_REMOTE_TOKEN ? "***" : null,
      host_hash: resolvedRemote.hostHash || null,
      auth_profile_id_hash: null,
      no_plaintext_secrets: true,
      shared_profile_policy: true,
      provider_locks: [],
      doctor_command: "oracle remote doctor",
      recover_command: "oracle remote doctor",
      version: null,
      uptimeSeconds: null,
    };

    if (!resolvedRemote.host) {
      endpoint.status = "not_configured";
    } else if (!resolvedRemote.token) {
      endpoint.status = "missing_token";
    } else {
      const tcp = await checkTcpConnection(resolvedRemote.host, 2000);
      if (!tcp.ok) {
        endpoint.status = "unreachable";
        endpoint.error = tcp.error;
      } else {
        const health = await checkRemoteHealth({
          host: resolvedRemote.host,
          token: resolvedRemote.token,
          timeoutMs: 5000,
        });
        if (health.ok) {
          endpoint.status = "healthy";
          applyHealthMetadata(endpoint, health);
        } else if (health.busy) {
          endpoint.status = "unknown";
          applyHealthMetadata(endpoint, health);
          endpoint.error = formatHealthFailure(health) ?? "remote host is busy";
        } else {
          endpoint.status = "auth_failed";
          endpoint.error = formatHealthFailure(health);
        }
      }
    }

    console.log(JSON.stringify(endpoint, null, 2));
    process.exitCode =
      endpoint.status === "healthy" || endpoint.status === "not_configured" ? 0 : 1;
    return;
  }

  const lines: string[] = [];
  const fail: string[] = [];
  const warn: string[] = [];

  lines.push(chalk.bold("Bridge doctor"));
  lines.push(chalk.dim(`OS: ${process.platform} ${os.release()} (${process.arch})`));
  lines.push(chalk.dim(`Node: ${process.version}`));
  lines.push(chalk.dim(`Oracle: ${version}`));
  lines.push(chalk.dim(`Config: ${loaded ? configPath : "(missing)"}`));
  if (userConfig.engine) {
    lines.push(chalk.dim(`Default engine: ${userConfig.engine}`));
  }
  if (userConfig.model) {
    lines.push(chalk.dim(`Default model: ${userConfig.model}`));
  }

  lines.push("");
  lines.push(chalk.bold("Browser mode"));

  if (resolvedRemote.host) {
    lines.push(`Remote service: ${chalk.green("configured")}`);
    lines.push(
      chalk.dim(
        `remoteHost: ${resolvedRemote.host} (${resolvedRemote.sources.host}) [hash: ${resolvedRemote.hostHash}]`,
      ),
    );
    lines.push(
      chalk.dim(
        `remoteToken: ${resolvedRemote.redactedToken ?? "missing"} (${resolvedRemote.sources.token})`,
      ),
    );

    const tcp = await checkTcpConnection(resolvedRemote.host, 2000);
    if (tcp.ok) {
      lines.push(chalk.dim(`TCP connect: ${chalk.green("ok")}`));
    } else {
      fail.push(`Cannot reach ${resolvedRemote.host} (${tcp.error ?? "unknown error"}).`);
      lines.push(
        chalk.dim(`TCP connect: ${chalk.red(`failed (${tcp.error ?? "unknown error"})`)}`),
      );
    }

    if (!resolvedRemote.token) {
      fail.push(
        "Remote token is missing. Run `oracle bridge client --connect <...> --write-config` or set ORACLE_REMOTE_TOKEN.",
      );
    } else if (tcp.ok) {
      const health = await checkRemoteHealth({
        host: resolvedRemote.host,
        token: resolvedRemote.token,
        timeoutMs: 5000,
      });
      if (health.ok) {
        const meta = health.version ? `oracle ${health.version}` : "ok";
        lines.push(chalk.dim(`Auth (/health): ${chalk.green(meta)}`));
      } else if (health.busy) {
        const detail = health.error ?? "remote host is busy";
        const suffix = health.statusCode ? `HTTP ${health.statusCode}` : "busy";
        fail.push(`Remote host is busy: ${detail}`);
        const meta = health.version ? `oracle ${health.version}` : "ok";
        lines.push(chalk.dim(`Auth (/health): ${chalk.green(meta)}`));
        lines.push(chalk.dim(`Run availability (/runs): ${chalk.red(`${suffix} (${detail})`)}`));
      } else {
        const detail = health.error ?? "unknown error";
        fail.push(`Remote auth failed: ${detail}`);
        const suffix = health.statusCode ? `HTTP ${health.statusCode}` : "network";
        lines.push(chalk.dim(`Auth (/health): ${chalk.red(`${suffix} (${detail})`)}`));
      }
    }
  } else {
    lines.push(`Remote service: ${chalk.yellow("not configured")}`);
    const chrome = await detectChromeBinary();
    if (chrome.path) {
      lines.push(chalk.dim(`Chrome: ${chalk.green(chrome.path)}`));
    } else {
      fail.push(
        "No Chrome installation detected. Install Chrome/Chromium or set --browser-chrome-path.",
      );
      lines.push(chalk.dim(`Chrome: ${chalk.red("not found")}`));
    }

    if (process.platform === "win32") {
      warn.push(
        "Cookie sync is disabled on Windows; use --browser-manual-login or run browser automation on another host.",
      );
      lines.push(chalk.dim("Cookies: (cookie sync disabled on Windows)"));
    } else {
      const cookieDb = await detectChromeCookieDb({ profile: "Default" });
      if (cookieDb) {
        lines.push(chalk.dim(`Cookies DB: ${chalk.green(cookieDb)}`));
      } else {
        warn.push(
          "Chrome cookies DB not detected. You may need --browser-cookie-path or --browser-manual-login.",
        );
        lines.push(chalk.dim(`Cookies DB: ${chalk.yellow("not found")}`));
      }
    }
  }

  lines.push("");
  lines.push(chalk.bold("Codex MCP"));
  lines.push(
    formatCodexMcpSnippet({
      remoteHost: resolvedRemote.host,
      remoteToken: resolvedRemote.token,
      includeToken: false,
    }),
  );

  if (warn.length) {
    lines.push("");
    lines.push(chalk.yellowBright("Warnings:"));
    for (const message of warn) {
      lines.push(chalk.yellow(`- ${message}`));
    }
  }
  if (fail.length) {
    lines.push("");
    lines.push(chalk.redBright("Problems:"));
    for (const message of fail) {
      lines.push(chalk.red(`- ${message}`));
    }
  }

  console.log(lines.join("\n"));

  process.exitCode = fail.length ? 1 : 0;
}
