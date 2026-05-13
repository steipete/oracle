import type { UserConfig } from "../config.js";
import { createHash } from "node:crypto";

export type RemoteServiceConfigSource = "cli" | "config.browser" | "env" | "unset" | "default";

export type RemoteBrowserMode = "preferred" | "required" | "off";

export interface ResolvedRemoteServiceConfig {
  host?: string;
  token?: string;
  mode: RemoteBrowserMode;
  hostHash?: string;
  redactedToken?: string;
  sources: {
    host: RemoteServiceConfigSource;
    token: RemoteServiceConfigSource;
    mode: RemoteServiceConfigSource;
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeMode(value: unknown): RemoteBrowserMode | undefined {
  const norm = normalizeString(value)?.toLowerCase();
  if (norm === "preferred" || norm === "required" || norm === "off") {
    return norm as RemoteBrowserMode;
  }
  return undefined;
}

function hashHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return createHash("sha256").update(host).digest("hex").slice(0, 12);
}

function redactToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return "***";
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  cliMode,
  userConfig,
  env = process.env,
  preferCli = false,
}: {
  cliHost?: string;
  cliToken?: string;
  cliMode?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve precedence as `cli > env > config > default` for host,
   * token, and mode (the standard CLI convention — an explicit flag
   * should win over an inherited environment default).
   *
   * Default `false` preserves the historical `env > cli > config >
   * default` precedence so callers that intentionally let a fleet-wide
   * ORACLE_REMOTE_HOST override an ambient `--remote-host` keep their
   * behaviour. Set to `true` from CLI surfaces where the user passing
   * a `--host` value is an explicit override request (e.g.
   * `oracle remote attach --host …`, oracle-72u).
   */
  preferCli?: boolean;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);
  const configBrowserMode = normalizeMode(userConfig?.browser?.remoteBrowser);

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);
  const envMode = normalizeMode(env.ORACLE_REMOTE_BROWSER);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeString(cliToken);
  const cliModeValue = normalizeMode(cliMode);

  let host = preferCli
    ? (cliHostValue ?? envHost ?? configBrowserHost)
    : (envHost ?? cliHostValue ?? configBrowserHost);
  let token = preferCli
    ? (cliTokenValue ?? envToken ?? configBrowserToken)
    : (envToken ?? cliTokenValue ?? configBrowserToken);
  const mode = preferCli
    ? (cliModeValue ?? envMode ?? configBrowserMode ?? "preferred")
    : (envMode ?? cliModeValue ?? configBrowserMode ?? "preferred");

  if (mode === "off") {
    host = undefined;
    token = undefined;
  } else if (mode === "required" && !host) {
    throw new Error(
      "remote_browser_endpoint_missing: --remote-browser=required but no remote host is configured.",
    );
  }

  if (host && !token && mode !== "off") {
    throw new Error(
      "remote_browser_token_missing: A remote host is configured but no token was provided.\n" +
        "Fix command: oracle config set browser.remoteToken <token>\n" +
        "Next command: export ORACLE_REMOTE_TOKEN=<token>",
    );
  }

  // Source attribution mirrors the precedence used for the value itself,
  // so an attach run that read its host from `--host` reports
  // `sources.host: "cli"` even when ORACLE_REMOTE_HOST is also set.
  const hostSource: RemoteServiceConfigSource = preferCli
    ? cliHostValue
      ? "cli"
      : envHost
        ? "env"
        : configBrowserHost
          ? "config.browser"
          : "unset"
    : envHost
      ? "env"
      : cliHostValue
        ? "cli"
        : configBrowserHost
          ? "config.browser"
          : "unset";

  const tokenSource: RemoteServiceConfigSource = preferCli
    ? cliTokenValue
      ? "cli"
      : envToken
        ? "env"
        : configBrowserToken
          ? "config.browser"
          : "unset"
    : envToken
      ? "env"
      : cliTokenValue
        ? "cli"
        : configBrowserToken
          ? "config.browser"
          : "unset";

  const modeSource: RemoteServiceConfigSource = preferCli
    ? cliModeValue
      ? "cli"
      : envMode
        ? "env"
        : configBrowserMode
          ? "config.browser"
          : "default"
    : envMode
      ? "env"
      : cliModeValue
        ? "cli"
        : configBrowserMode
          ? "config.browser"
          : "default";

  return {
    host,
    token,
    mode,
    hostHash: hashHost(host),
    redactedToken: redactToken(token),
    sources: { host: hostSource, token: tokenSource, mode: modeSource },
  };
}
