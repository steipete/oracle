import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import {
  launchChrome,
  connectWithNewTab,
  connectToRemoteChrome,
  closeTab,
} from "../browser/chromeLifecycle.js";
import { resolveAttachRunningConnection } from "../browser/attachRunning.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} from "../browser/profileState.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  close: () => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log } = input;
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);

  if (resolvedConfig.attachRunning || resolvedConfig.remoteChrome) {
    const logger = log ?? (() => {});
    const endpoint = await resolveAttachRunningConnection(resolvedConfig, logger);
    const connection = await connectToRemoteChrome(
      endpoint.host,
      endpoint.port,
      logger,
      "about:blank",
      endpoint.browserWSEndpoint,
      { approvalWaitMs: resolvedConfig.approvalWaitMs, fallbackToDefault: false },
    );
    return {
      profileDir: endpoint.profileRoot ?? profileDir,
      port: endpoint.port,
      client: connection.client,
      targetId: connection.targetId,
      close: () => connection.close({ preserveTarget: keepBrowser }),
    };
  }

  await mkdir(profileDir, { recursive: true });

  let port = await readDevToolsPort(profileDir);
  let launchedChrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let chromeWasLaunched = false;

  if (port) {
    const probe = await verifyDevToolsReachable({ port });
    if (!probe.ok) {
      log?.(`[gemini-web] Stale DevTools port ${port}; launching fresh Chrome for ${purpose}.`);
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "if_oracle_pid_dead" });
      port = null;
    }
  }

  if (!port) {
    log?.(`[gemini-web] Launching Chrome for ${purpose}.`);
    launchedChrome = await launchChrome(resolvedConfig, profileDir, log ?? (() => {}));
    port = launchedChrome.port;
    chromeWasLaunched = true;
    await writeDevToolsActivePort(profileDir, port);
    if (launchedChrome.pid) {
      await writeChromePid(profileDir, launchedChrome.pid);
    }
  } else {
    log?.(`[gemini-web] Reusing Chrome on port ${port} for ${purpose}.`);
  }

  const connection = await connectWithNewTab(port, log ?? (() => {}), undefined);
  const client = connection.client;
  const targetId = connection.targetId;

  const close = async (): Promise<void> => {
    if (keepBrowser) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (targetId && port) {
      await closeTab(port, targetId, log ?? (() => {})).catch(() => undefined);
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }

    if (chromeWasLaunched && launchedChrome) {
      try {
        launchedChrome.kill();
      } catch {
        /* ignore */
      }
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "never" }).catch(
        () => undefined,
      );
    }
  };

  return {
    profileDir,
    port,
    client,
    targetId: targetId ?? undefined,
    close,
  };
}
