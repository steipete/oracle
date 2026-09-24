import type { LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger } from "./types.js";
import { formatElapsed } from "../oracle/format.js";
import { delay } from "./utils.js";
import {
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";

export async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    chromePath?: string | null;
  } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
  let discoveredPort = false;
  if (!port) {
    const discovered = await findRunningChromeDebugTargetForProfile(userDataDir);
    if (!discovered) {
      if (pid) {
        logger(
          `No reachable Chrome DevTools target found for ${userDataDir}; clearing stale profile state before launching new Chrome.`,
        );
        await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "if_oracle_pid_dead",
        });
      }
      return null;
    }
    port = discovered.port;
    pid = discovered.pid;
    discoveredPort = true;
  }

  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `Chrome for ${userDataDir} on port ${port} is unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }

  if (discoveredPort) {
    await writeDevToolsActivePort(userDataDir, port);
    if (pid) await writeChromePid(userDataDir, pid);
  }

  if (options.chromePath) {
    logger(
      `[browser] Warning: reusing Chrome already running for ${userDataDir}` +
        ` (pid ${pid ?? "unknown"}, port ${port}); configured executable ${options.chromePath}` +
        " applies only to a new launch. The running executable has not been verified against it." +
        " To switch browsers, finish active runs and close this profile’s Chrome, or use a different --browser-manual-login-profile-dir.",
    );
  }
  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ""})`,
  );
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}
