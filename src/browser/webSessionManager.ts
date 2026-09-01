import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "./types.js";
import { launchChrome, connectWithNewTab, closeTab } from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import {
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} from "./profileState.js";

export interface WebBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  close: () => Promise<void>;
}

export interface OpenWebBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  /** Log prefix identifying the calling provider, e.g. "gemini-web". */
  logPrefix: string;
  log?: BrowserLogger;
}

/**
 * Opens a CDP session against the persistent manual-login Chrome profile, reusing
 * an already-running instance when its DevTools port is still reachable.
 *
 * Shared by the non-ChatGPT web providers (Gemini, Perplexity); the ChatGPT path
 * has its own richer lifecycle in `browser/index.ts`.
 */
export async function openWebBrowserSession(
  input: OpenWebBrowserSessionInput,
): Promise<WebBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, logPrefix, log } = input;
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  await mkdir(profileDir, { recursive: true });
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);

  let port = await readDevToolsPort(profileDir);
  let launchedChrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let chromeWasLaunched = false;

  if (port) {
    const probe = await verifyDevToolsReachable({ port });
    if (!probe.ok) {
      log?.(`[${logPrefix}] Stale DevTools port ${port}; launching fresh Chrome for ${purpose}.`);
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "if_oracle_pid_dead" });
      port = null;
    }
  }

  if (!port) {
    log?.(`[${logPrefix}] Launching Chrome for ${purpose}.`);
    launchedChrome = await launchChrome(resolvedConfig, profileDir, log ?? (() => {}));
    port = launchedChrome.port;
    chromeWasLaunched = true;
    await writeDevToolsActivePort(profileDir, port);
    if (launchedChrome.pid) {
      await writeChromePid(profileDir, launchedChrome.pid);
    }
  } else {
    log?.(`[${logPrefix}] Reusing Chrome on port ${port} for ${purpose}.`);
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
