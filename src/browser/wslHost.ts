import { readFileSync } from "node:fs";
import os from "node:os";

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

export function parseWslResolverHost(resolvConf: string): string | null {
  for (const line of resolvConf.split("\n")) {
    const match = line.match(/^nameserver\s+([0-9.]+)/);
    if (match?.[1]) {
      return match[1].startsWith("127.") ? "127.0.0.1" : match[1];
    }
  }
  return null;
}

export function resolveWslHost(): string | null {
  if (!isWsl()) return null;
  try {
    return parseWslResolverHost(readFileSync("/etc/resolv.conf", "utf8"));
  } catch {
    return null;
  }
}

type WslChromeHostOptions = {
  remoteDebugHost?: string | null;
  wslHostIp?: string | null;
  resolvConf?: string | null;
};

export function resolveWslChromeHost(options: WslChromeHostOptions = {}): string | null {
  const remoteDebugHost =
    options.remoteDebugHost === undefined
      ? process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST
      : options.remoteDebugHost;
  const wslHostIp = options.wslHostIp === undefined ? process.env.WSL_HOST_IP : options.wslHostIp;
  const override = remoteDebugHost?.trim() || wslHostIp?.trim();
  if (override) return override;
  if (options.resolvConf !== undefined) {
    return options.resolvConf === null ? null : parseWslResolverHost(options.resolvConf);
  }
  return resolveWslHost();
}

export function resolveWslChromeLaunchRoute(options: WslChromeHostOptions = {}): {
  connectHost: string | null;
  debugBindAddress: string | null;
  usePatchedLauncher: boolean;
} {
  const connectHost = resolveWslChromeHost(options);
  const usePatchedLauncher = Boolean(connectHost && connectHost !== "127.0.0.1");
  return {
    connectHost,
    debugBindAddress: usePatchedLauncher ? "0.0.0.0" : connectHost,
    usePatchedLauncher,
  };
}
