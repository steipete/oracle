import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import {
  discoverDevToolsActivePortCandidates,
  formatWebSocketHost,
  resolveDevToolsActivePortDiscoveryRoots,
  type DevToolsActivePortCandidate,
} from "./detect.js";

export interface AttachRunningConnectionInfo {
  host: string;
  port: number;
  browserWSEndpoint: string;
  profileRoot: string | null;
}

export async function resolveAttachRunningConnection(
  config: Pick<ResolvedBrowserConfig, "chromePath" | "remoteChrome">,
  logger: BrowserLogger,
): Promise<AttachRunningConnectionInfo> {
  const host = config.remoteChrome?.host ?? "127.0.0.1";
  const port = config.remoteChrome?.port ?? 9222;
  if (config.chromePath) {
    logger("Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.");
  }

  logger(
    config.remoteChrome
      ? `Using explicit attach-running target ${host}:${port}.`
      : `Using default attach-running target ${host}:${port}.`,
  );

  const candidates = (await discoverDevToolsActivePortCandidates({ host }))
    .filter((candidate) => candidate.port === port)
    .sort(compareDevToolsCandidates);

  if (candidates.length === 0) {
    const probe = await probeDevToolsBrowserWSEndpoint({ host, port });
    if (probe.ok) {
      return {
        host,
        port,
        browserWSEndpoint: probe.browserWSEndpoint,
        profileRoot: null,
      };
    }
    const discoveryRoots = resolveDevToolsActivePortDiscoveryRoots();
    throw new Error(
      `No running browser matched ${host}:${port}. DevToolsActivePort discovery searched ${discoveryRoots.join(", ") || "no roots"}, and endpoint probe http://${formatWebSocketHost(host)}:${port}/json/version failed: ${probe.error}.`,
    );
  }
  const candidate = candidates[0];
  logger(`Selected attach-running browser metadata from ${candidate.path}`);
  return {
    host,
    port: candidate.port,
    browserWSEndpoint: candidate.browserWSEndpoint,
    profileRoot: candidate.profileRoot,
  };
}

async function probeDevToolsBrowserWSEndpoint({
  host,
  port,
  attempts = 2,
  timeoutMs = 1000,
}: {
  host: string;
  port: number;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true; browserWSEndpoint: string } | { ok: false; error: string }> {
  const versionUrl = `http://${formatWebSocketHost(host)}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(versionUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof version.webSocketDebuggerUrl !== "string" || !version.webSocketDebuggerUrl) {
        throw new Error("response did not include webSocketDebuggerUrl");
      }
      return { ok: true, browserWSEndpoint: version.webSocketDebuggerUrl };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

function compareDevToolsCandidates(
  left: DevToolsActivePortCandidate,
  right: DevToolsActivePortCandidate,
): number {
  if (right.mtimeMs !== left.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return left.path.localeCompare(right.path);
}
