import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import {
  discoverDevToolsActivePortCandidates,
  type DevToolsActivePortCandidate,
} from "./detect.js";

export interface AttachRunningConnectionInfo {
  host: string;
  port: number;
  browserWSEndpoint: string;
  profileRoot: string;
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
    throw new Error(
      `No running browser with attach metadata matched ${host}:${port}. Enable remote debugging in chrome://inspect/#remote-debugging first.`,
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

function compareDevToolsCandidates(
  left: DevToolsActivePortCandidate,
  right: DevToolsActivePortCandidate,
): number {
  if (right.mtimeMs !== left.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return left.path.localeCompare(right.path);
}
