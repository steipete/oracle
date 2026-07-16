import { listRemoteChromeTargets } from "./chromeLifecycle.js";
import { verifyDevToolsReachable } from "./profileState.js";

export type ChromeTargetLiveness = {
  endpointReachable: boolean;
  /** null when no target id was provided to check */
  targetFound: boolean | null;
  matchedUrl?: string;
  error?: string;
};

/**
 * Probe whether Chrome's DevTools endpoint (and optionally a specific target)
 * is still reachable after a CDP client WebSocket disconnect.
 */
export async function probeChromeTargetLiveness(options: {
  host: string;
  port: number;
  targetId?: string | null;
  browserWSEndpoint?: string;
  listTargets?: typeof listRemoteChromeTargets;
  verifyEndpoint?: typeof verifyDevToolsReachable;
}): Promise<ChromeTargetLiveness> {
  const host = options.host || "127.0.0.1";
  const port = options.port;
  if (!Number.isFinite(port) || port <= 0) {
    return { endpointReachable: false, targetFound: null, error: "missing debug port" };
  }

  const verifyEndpoint = options.verifyEndpoint ?? verifyDevToolsReachable;
  const endpoint = await verifyEndpoint({ host, port, attempts: 2, timeoutMs: 1500 });
  if (!endpoint.ok) {
    return {
      endpointReachable: false,
      targetFound: null,
      error: endpoint.error,
    };
  }

  const targetId = options.targetId?.trim();
  if (!targetId) {
    return { endpointReachable: true, targetFound: null };
  }

  try {
    const listTargets = options.listTargets ?? listRemoteChromeTargets;
    const targets = await listTargets({
      host,
      port,
      browserWSEndpoint: options.browserWSEndpoint,
    });
    const match = targets.find((target) => {
      const id = target.targetId ?? (target as { id?: string }).id;
      return id === targetId;
    });
    if (!match) {
      return { endpointReachable: true, targetFound: false };
    }
    return {
      endpointReachable: true,
      targetFound: true,
      matchedUrl: typeof match.url === "string" ? match.url : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Endpoint answered /json/version; treat list failures as still recoverable.
    return { endpointReachable: true, targetFound: null, error: message };
  }
}

export function isRecoverableChromeDisconnect(liveness: ChromeTargetLiveness): boolean {
  return liveness.endpointReachable && liveness.targetFound !== false;
}

export function connectionLostUserMessage(options: {
  recoverable: boolean;
  remote?: boolean;
}): string {
  if (options.recoverable) {
    return options.remote
      ? "Remote Chrome DevTools client disconnected before oracle finished; the browser target appears still alive."
      : "Chrome DevTools client disconnected before oracle finished; the browser target appears still alive.";
  }
  return options.remote
    ? "Remote Chrome connection lost before Oracle finished."
    : "Chrome window closed before oracle finished. Please keep it open until completion.";
}
