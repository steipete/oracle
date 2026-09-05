import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type Protocol from "devtools-protocol";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { delay } from "./utils.js";
import { isWsl, resolveWslChromeLaunchRoute } from "./wslHost.js";

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
) {
  const { connectHost, debugBindAddress, usePatchedLauncher } = resolveWslChromeLaunchRoute();
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  const launchedProfileDirectory =
    usingCopiedProfile && config.chromeProfile ? config.chromeProfile : "Default";
  await prepareChromeWindowStateForHiddenLaunch({
    config,
    userDataDir,
    profileDirectory: launchedProfileDirectory,
    logger,
  });
  const chromeFlags = buildChromeFlags(
    config.headless ?? false,
    debugBindAddress,
    config.hideWindow ?? false,
  );
  // copy-profile reuses a copied signed-in profile whose cookies are
  // Keychain-encrypted, so it must launch with the real Keychain (not mocked):
  // strip the keychain-mocking flags from both chrome-launcher's defaults and
  // Oracle's set, and ignore the defaults so they aren't re-added.
  if (usingCopiedProfile && config.chromeProfile) {
    chromeFlags.push(`--profile-directory=${config.chromeProfile}`);
  }
  const launchOptions = resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
  const launcher = usePatchedLauncher
    ? await launchWithCustomHost({
        chromeFlags: launchOptions.chromeFlags,
        chromePath: config.chromePath ?? undefined,
        userDataDir,
        host: connectHost ?? "127.0.0.1",
        requestedPort: debugPort ?? undefined,
        ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      })
    : await launch({
        chromePath: config.chromePath ?? undefined,
        chromeFlags: launchOptions.chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: debugPort ?? undefined,
        ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      });
  const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
  return Object.assign(launcher, { host: connectHost ?? "127.0.0.1" }) as LaunchedChrome & {
    host?: string;
  };
}

export async function positionChromeWindowOffscreen(
  client: ChromeClient,
  userDataDir: string,
  logger: BrowserLogger,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger("Window hiding is only supported on macOS");
    return;
  }
  let savedState = false;
  try {
    const { windowId } = await client.Browser.getWindowForTarget();
    if (!(await readSavedChromeWindowState(userDataDir))) {
      const { bounds } = await client.Browser.getWindowBounds({ windowId });
      await writeSavedChromeWindowState(userDataDir, bounds);
      savedState = true;
    }
    await client.Browser.setWindowBounds({
      windowId,
      bounds: { left: -32_000, top: -32_000, windowState: "normal" },
    });
  } catch (error) {
    if (savedState) {
      await rm(chromeWindowStatePath(userDataDir), { force: true }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to position Chrome window off-screen: ${message}`);
    return;
  }
  logger("Chrome window positioned off-screen");
}

export async function positionChromeWindowOnscreen(
  client: ChromeClient,
  userDataDir: string,
  logger: BrowserLogger,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const savedState = await readSavedChromeWindowState(userDataDir);
    if (!savedState) {
      return;
    }
    const { windowId } = await client.Browser.getWindowForTarget();
    await client.Browser.setWindowBounds({
      windowId,
      bounds: restoreWindowBounds(savedState.bounds),
    });
    await rm(chromeWindowStatePath(userDataDir), { force: true });
    logger("Chrome window restored to its pre-hide bounds");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to position Chrome window on-screen: ${message}`);
  }
}

const CHROME_WINDOW_STATE_FILENAME = "oracle-window-state.json";

interface SavedChromeWindowState {
  version: 1;
  bounds: Protocol.Browser.Bounds;
}

interface PersistedChromeWindowPlacement {
  left?: unknown;
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
  maximized?: unknown;
}

const DEFAULT_VISIBLE_WINDOW_BOUNDS: Protocol.Browser.Bounds = {
  left: 80,
  top: 80,
  width: 1280,
  height: 720,
  windowState: "normal",
};

function chromeWindowStatePath(userDataDir: string): string {
  return path.join(userDataDir, CHROME_WINDOW_STATE_FILENAME);
}

async function readSavedChromeWindowState(
  userDataDir: string,
): Promise<SavedChromeWindowState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(chromeWindowStatePath(userDataDir), "utf8"),
    ) as Partial<SavedChromeWindowState>;
    const bounds = parseChromeWindowBounds(parsed.bounds);
    if (parsed.version !== 1 || !bounds) {
      return null;
    }
    return { version: 1, bounds };
  } catch {
    return null;
  }
}

async function writeSavedChromeWindowState(
  userDataDir: string,
  bounds: Protocol.Browser.Bounds,
): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    chromeWindowStatePath(userDataDir),
    `${JSON.stringify({ version: 1, bounds })}\n`,
    "utf8",
  );
}

async function prepareChromeWindowStateForHiddenLaunch({
  config,
  userDataDir,
  profileDirectory,
  logger,
}: {
  config: ResolvedBrowserConfig;
  userDataDir: string;
  profileDirectory: string;
  logger: BrowserLogger;
}): Promise<void> {
  if (
    process.platform !== "darwin" ||
    config.headless ||
    !config.hideWindow ||
    (await readSavedChromeWindowState(userDataDir))
  ) {
    return;
  }
  const bounds =
    (await readPersistedChromeWindowBounds(userDataDir, profileDirectory)) ??
    DEFAULT_VISIBLE_WINDOW_BOUNDS;
  await writeSavedChromeWindowState(userDataDir, bounds);
  logger("Recorded Chrome window placement before hidden launch");
}

async function readPersistedChromeWindowBounds(
  userDataDir: string,
  profileDirectory: string,
): Promise<Protocol.Browser.Bounds | null> {
  const root = path.resolve(userDataDir);
  const profile = path.resolve(root, profileDirectory);
  if (path.dirname(profile) !== root) {
    return null;
  }
  try {
    const preferences = JSON.parse(await readFile(path.join(profile, "Preferences"), "utf8")) as {
      browser?: { window_placement?: PersistedChromeWindowPlacement };
    };
    return persistedPlacementToBounds(preferences.browser?.window_placement);
  } catch {
    return null;
  }
}

function persistedPlacementToBounds(
  placement: PersistedChromeWindowPlacement | undefined,
): Protocol.Browser.Bounds | null {
  if (!placement) {
    return null;
  }
  if (placement.maximized === true) {
    return { windowState: "maximized" };
  }
  const left = finiteNumber(placement.left);
  const top = finiteNumber(placement.top);
  const right = finiteNumber(placement.right);
  const bottom = finiteNumber(placement.bottom);
  if (left === null || top === null || right === null || bottom === null) {
    return null;
  }
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height, windowState: "normal" };
}

function parseChromeWindowBounds(value: unknown): Protocol.Browser.Bounds | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const bounds = value as Protocol.Browser.Bounds;
  const windowState = bounds.windowState ?? "normal";
  if (windowState !== "normal") {
    return ["minimized", "maximized", "fullscreen"].includes(windowState) ? { windowState } : null;
  }
  const left = finiteNumber(bounds.left);
  const top = finiteNumber(bounds.top);
  const width = finiteNumber(bounds.width);
  const height = finiteNumber(bounds.height);
  if (
    left === null ||
    top === null ||
    width === null ||
    height === null ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { left, top, width, height, windowState: "normal" };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function restoreWindowBounds(bounds: Protocol.Browser.Bounds): Protocol.Browser.Bounds {
  const windowState = bounds.windowState ?? "normal";
  if (windowState !== "normal") {
    return { windowState };
  }
  return {
    left: bounds.left ?? 80,
    top: bounds.top ?? 80,
    width: bounds.width,
    height: bounds.height,
    windowState: "normal",
  };
}

export function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: BrowserLogger,
  opts?: {
    /** Return true when the run is still in-flight (assistant response pending). */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
    /**
     * Always terminate Chrome and delete `userDataDir` on signal, even when the run is
     * in-flight — for throwaway copied profiles (`--copy-profile`) that must not be left
     * on disk. Overrides the in-flight "leave running" behavior.
     */
    forceProfileCleanup?: boolean;
  },
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    const inFlight = opts?.isInFlight?.() ?? false;
    const forceCleanup = opts?.forceProfileCleanup ?? false;
    const leaveRunning = (keepBrowser || inFlight) && !forceCleanup;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
      );
    } else if (forceCleanup && (keepBrowser || inFlight)) {
      logger(
        `Received ${signal}; terminating Chrome and removing the copied profile (copy-profile is not retained)`,
      );
    } else {
      logger(`Received ${signal}; terminating Chrome process`);
    }
    void (async () => {
      if (leaveRunning) {
        // Ensure reattach hints are written before we exit.
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
        }
      } else {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
        if (opts?.preserveUserDataDir) {
          // Preserve the profile directory (manual login), but clear reattach hints so we don't
          // try to reuse a dead DevTools port on the next run.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })().finally(() => {
      const exitCode = signal === "SIGINT" ? 130 : 1;
      // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
      // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) {
        process.exit(exitCode);
      }
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger("Connected to Chrome DevTools protocol");
  return client;
}

export async function connectToRemoteChrome(
  host: string,
  port: number,
  logger: BrowserLogger,
  targetUrl?: string,
  browserWSEndpoint?: string,
  options?: {
    approvalWaitMs?: number;
    fallbackToDefault?: boolean;
  },
): Promise<RemoteChromeConnection> {
  if (browserWSEndpoint) {
    return await connectToRemoteChromeTarget(host, port, logger, {
      browserWSEndpoint,
      targetUrl: targetUrl ?? "about:blank",
      closeTargetOnDispose: true,
      approvalWaitMs: options?.approvalWaitMs,
    });
  }
  const newTargetUrl =
    targetUrl || (options?.fallbackToDefault === false ? "about:blank" : undefined);
  if (newTargetUrl) {
    const targetConnection = await connectToNewTarget(host, port, newTargetUrl, logger, {
      opened: () => `Opened dedicated remote Chrome tab targeting ${newTargetUrl}`,
      openFailed: (message) =>
        `Failed to open dedicated remote Chrome tab (${message}); ${options?.fallbackToDefault === false ? "refusing to reuse an unrelated tab" : "falling back to first target"}.`,
      attachFailed: (targetId, message) =>
        `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); ${options?.fallbackToDefault === false ? "refusing to reuse an unrelated tab" : "falling back to first target"}.`,
      closeFailed: (targetId, message) =>
        `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return {
        client: targetConnection.client,
        targetId: targetConnection.targetId,
        close: async () => {
          await targetConnection.client.close().catch(() => undefined);
          await closeRemoteChromeTarget(host, port, targetConnection.targetId, logger);
        },
      };
    }
    if (options?.fallbackToDefault === false) {
      throw new Error(
        "Unable to create a dedicated remote Chrome tab; refusing to reuse an unrelated conversation.",
      );
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return {
    client: fallbackClient,
    close: async () => {
      await fallbackClient.close().catch(() => undefined);
    },
  };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<void> {
  if (!targetId) {
    return;
  }
  try {
    await CDP.Close({ host, port, id: targetId });
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
  browserWSEndpoint?: string;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
}

interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export interface RemoteTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
}

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    const targets = await CDP.List({ host: options.host, port: options.port });
    return targets as unknown as RemoteTargetInfo[];
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
      url: target.url,
    }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function connectToRemoteChromeTarget(
  host: string,
  port: number,
  logger: BrowserLogger,
  options: {
    targetId?: string;
    targetUrl?: string;
    browserWSEndpoint?: string;
    closeTargetOnDispose?: boolean;
    approvalWaitMs?: number;
  },
): Promise<RemoteChromeConnection> {
  if (!options.browserWSEndpoint) {
    const client = await CDP({ host, port, target: options.targetId });
    return {
      client,
      targetId: options.targetId,
      close: async () => {
        await client.close().catch(() => undefined);
      },
    };
  }

  const browser = await connectToBrowserWebSocket(
    host,
    port,
    options.browserWSEndpoint,
    logger,
    options.approvalWaitMs,
  );
  let targetId = options.targetId;
  try {
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      targetId = created.targetId;
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
      close: async () => {
        await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        if (options.closeTargetOnDispose && targetId) {
          await browser.Target.closeTarget({ targetId }).catch(() => undefined);
        }
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function connectToBrowserWebSocket(
  host: string,
  port: number,
  browserWSEndpoint: string,
  logger: BrowserLogger,
  approvalWaitMs?: number,
): Promise<ChromeClient> {
  if (!approvalWaitMs || approvalWaitMs <= 0) {
    return (await CDP({ target: browserWSEndpoint, local: true })) as ChromeClient;
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);

  const deadline = Date.now() + approvalWaitMs;
  let lastApprovalError: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      return await Promise.race([
        CDP({ target: browserWSEndpoint, local: true }) as Promise<ChromeClient>,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("__oracle_remote_debugging_approval_timeout__"));
          }, remainingMs);
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "__oracle_remote_debugging_approval_timeout__"
      ) {
        break;
      }
      if (!isRemoteDebuggingApprovalError(error)) {
        throw error;
      }
      lastApprovalError = error;
      await delay(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }
  const suffix =
    lastApprovalError instanceof Error && lastApprovalError.message
      ? ` Last Chrome response: ${lastApprovalError.message}`
      : "";
  throw new Error(
    `Oracle waited ${formatApprovalWait(approvalWaitMs)} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.${suffix}`,
  );
}

function isRemoteDebuggingApprovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unexpected server response:\s*403|remote debugging|forbidden/i.test(message);
}

function formatApprovalWait(waitMs: number): string {
  if (waitMs % 1000 === 0) {
    return `${waitMs / 1000}s`;
  }
  return `${waitMs}ms`;
}

async function connectToNewTarget(
  host: string,
  port: number,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
): Promise<{ client: ChromeClient; targetId: string } | null> {
  try {
    const target = await CDP.New({ host, port, url });
    try {
      const client = await CDP({ host, port, target: target.id });
      if (messages.opened) {
        logger(messages.opened(target.id));
      }
      return { client, targetId: target.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(messages.attachFailed(target.id, message));
      try {
        await CDP.Close({ host, port, id: target.id });
      } catch (closeError) {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        logger(messages.closeFailed(target.id, closeMessage));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(messages.openFailed(message));
  }
  return null;
}

function createSessionBoundChromeClient(browser: ChromeClient, sessionId: string): ChromeClient {
  const browserWithEvents = browser as ChromeClient & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    once: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  const bindDomain = <T extends object>(domainName: string): T => {
    const domain = (browser as unknown as Record<string, Record<string, unknown>>)[domainName] as
      | Record<string, unknown>
      | undefined;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy((domain ?? {}) as T, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const domainEvent = (target as Record<string, unknown>)[name];
            if (typeof domainEvent === "function") {
              return (domainEvent as (...args: unknown[]) => unknown)(sessionId, listener);
            }
            browserWithEvents.on(eventName(name), listener);
            return () => browserWithEvents.removeListener(eventName(name), listener);
          };
        }
        if (prop === "off" || prop === "removeListener") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const off =
              browserWithEvents.off ?? browserWithEvents.removeListener.bind(browserWithEvents);
            off(eventName(name), listener);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) =>
          (value as (...callArgs: unknown[]) => unknown)(...args, sessionId);
      },
    });
  };

  return {
    ...browser,
    // Raw `send` here is the browser-level send (not session-bound), so callers
    // that issue Target.* via `send` must pass this page session id explicitly to
    // stay scoped to this tab (e.g. Deep Research OOPIF auto-attach).
    // chrome-remote-interface defines `send` on the client prototype, so object
    // spread does not preserve it. Bind it explicitly for raw session commands.
    send: typeof browser.send === "function" ? browser.send.bind(browser) : undefined,
    oraclePageSessionId: sessionId,
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
    Emulation: bindDomain("Emulation"),
    on: browserWithEvents.on.bind(browserWithEvents),
    once: browserWithEvents.once.bind(browserWithEvents),
    off:
      browserWithEvents.off?.bind(browserWithEvents) ??
      browserWithEvents.removeListener.bind(browserWithEvents),
    removeListener: browserWithEvents.removeListener.bind(browserWithEvents),
    close: async () => {
      await browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
    },
  } as ChromeClient;
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: { fallbackToDefault?: boolean; retries?: number; retryDelayMs?: number },
): Promise<IsolatedTabConnection> {
  const effectiveHost = host ?? "127.0.0.1";
  const url = initialUrl ?? "about:blank";
  const fallbackToDefault = options?.fallbackToDefault ?? true;
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  const fallbackLabel = fallbackToDefault
    ? "falling back to default target."
    : "strict mode: not falling back.";

  let attempt = 0;
  while (attempt <= retries) {
    const targetConnection = await connectToNewTarget(effectiveHost, port, url, logger, {
      opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
      openFailed: (message) => `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
      attachFailed: (targetId, message) =>
        `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
      closeFailed: (targetId, message) =>
        `Failed to close unused browser tab ${targetId}: ${message}`,
    });
    if (targetConnection) {
      return targetConnection;
    }
    if (attempt >= retries) {
      break;
    }
    attempt += 1;
    await delay(retryDelayMs * attempt);
  }

  if (!fallbackToDefault) {
    throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
  }
  const client = await connectToChrome(port, logger, effectiveHost);
  return { client };
}

export async function closeTab(
  port: number,
  targetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<boolean> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      let targets: Array<{ id?: string; targetId?: string }>;
      try {
        targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
          id?: string;
          targetId?: string;
        }>;
      } catch {
        continue;
      }
      if (!targets.some((target) => (target.targetId ?? target.id) === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    }
    logger(`Browser tab close was not confirmed (target=${targetId})`);
    return false;
  } catch (error) {
    try {
      const targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
        id?: string;
        targetId?: string;
      }>;
      if (!targets.some((target) => (target.targetId ?? target.id) === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch {
      // Preserve the original close error below.
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close browser tab ${targetId}: ${message}`);
    return false;
  }
}

export async function createChromePageTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const created = (await CDP.New({
      host: effectiveHost,
      port,
      url: "about:blank",
    })) as { id?: string; targetId?: string };
    const createdTargetId = created.targetId ?? created.id;
    if (!createdTargetId) {
      logger("Failed to create a replacement Chrome tab.");
      return undefined;
    }
    logger(`Opened replacement Chrome tab (target=${createdTargetId})`);
    return createdTargetId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to create a replacement Chrome tab: ${message}`);
    return undefined;
  }
}

export async function ensureChromePageTargetAfterClose(
  port: number,
  closingTargetId: string,
  logger: BrowserLogger,
  host?: string,
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
    }>;
    const existingPageTargetId = targets
      .filter((target) => target.type === "page")
      .map((target) => target.targetId ?? target.id)
      .find((targetId): targetId is string => Boolean(targetId) && targetId !== closingTargetId);
    if (existingPageTargetId) {
      return existingPageTargetId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect Chrome tabs before closing ${closingTargetId}: ${message}`);
  }
  return await createChromePageTarget(port, logger, host);
}

export async function closeBlankChromeTabs(
  port: number,
  logger: BrowserLogger,
  host?: string,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<void> {
  const effectiveHost = host ?? "127.0.0.1";
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  let targets: Array<{ id?: string; targetId?: string; type?: string; url?: string }>;
  try {
    targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
      url?: string;
    }>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect blank Chrome tabs: ${message}`);
    return;
  }

  const preservedBlankTargetId = options?.preserveOneBlank
    ? targets
        .filter(isBlankPageTarget)
        .map((target) => target.targetId ?? target.id)
        .filter((targetId): targetId is string => Boolean(targetId))
        .sort()[0]
    : undefined;
  let closed = 0;
  for (const target of targets) {
    const targetId = target.targetId ?? target.id;
    if (
      !targetId ||
      targetId === preservedBlankTargetId ||
      excluded.has(targetId) ||
      !isBlankPageTarget(target)
    ) {
      continue;
    }
    try {
      await CDP.Close({ host: effectiveHost, port, id: targetId });
      closed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to close blank Chrome tab ${targetId}: ${message}`);
    }
  }
  if (closed > 0) {
    logger(`Closed ${closed} blank Chrome tab${closed === 1 ? "" : "s"}.`);
  }
}

function isBlankPageTarget(target: { type?: string; url?: string }): boolean {
  if (target.type && target.type !== "page") {
    return false;
  }
  const url = (target.url ?? "").trim().toLowerCase();
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}

function buildChromeFlags(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  const flags = [
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--disable-features=TranslateUI,AutomationControlled",
    "--mute-audio",
    "--window-size=1280,720",
    // Chrome that *we* launch is pinned to English, so ChatGPT renders the labels
    // our selectors were written against. This does not make English the only case
    // to handle: --browser-attach-running and --remote-chrome never build these
    // flags (see controlPlan.ts), so those runs inherit the user's own Chrome
    // locale, and a ChatGPT account language setting can localize the UI even here.
    // That is why the model/effort matchers must stay language-tolerant.
    "--lang=en-US",
    "--accept-lang=en-US,en",
  ];

  if (process.platform !== "win32" && !isWsl()) {
    flags.push("--password-store=basic", "--use-mock-keychain");
  }

  if (debugBindAddress) {
    flags.push(`--remote-debugging-address=${debugBindAddress}`);
  }

  if (headless) {
    flags.push("--headless=new");
  } else if (hideWindow && process.platform === "darwin") {
    // Cmd-H stops macOS Chrome from compositing the page, which can swallow
    // trusted CDP clicks and retain the prompt as a draft. Keeping the window
    // off-screen avoids desktop disruption while preserving normal rendering.
    flags.push("--window-position=-32000,-32000");
  }

  // Opt-in only: container/CI Chromium often cannot use the sandbox. Callers must
  // set ORACLE_CHROME_NO_SANDBOX=1 explicitly (never default this on).
  if (process.env.ORACLE_CHROME_NO_SANDBOX === "1") {
    flags.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return flags;
}

export function buildChromeFlagsForTest(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  return buildChromeFlags(headless, debugBindAddress, hideWindow);
}

function resolveChromeLaunchOptions(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  if (!usingCopiedProfile) {
    return { chromeFlags, ignoreDefaultFlags: false };
  }
  return {
    chromeFlags: [...Launcher.defaultFlags(), ...chromeFlags].filter(
      (flag) => flag !== "--use-mock-keychain" && flag !== "--password-store=basic",
    ),
    ignoreDefaultFlags: true,
  };
}

export function resolveChromeLaunchOptionsForTest(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  return resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
}

function parseDebugPortEnv(): number | null {
  const raw = process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

async function launchWithCustomHost({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
  ignoreDefaultFlags,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
    ignoreDefaultFlags,
  });

  if (host) {
    const patched = launcher as unknown as { isDebuggerReady?: () => Promise<void>; port?: number };
    patched.isDebuggerReady = function patchedIsDebuggerReady(
      this: Launcher & { port?: number },
    ): Promise<void> {
      const debugPort = this.port ?? 0;
      if (!debugPort) {
        return Promise.reject(new Error("Missing Chrome debug port"));
      }
      return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: debugPort, host });
        const cleanup = () => {
          client.removeAllListeners();
          client.end();
          client.destroy();
          client.unref();
        };
        client.once("error", (err) => {
          cleanup();
          reject(err);
        });
        client.once("connect", () => {
          cleanup();
          resolve();
        });
      });
    };
  }

  await launcher.launch();

  const kill = async () => launcher.kill();
  return {
    pid: launcher.pid ?? undefined,
    port: launcher.port ?? 0,
    process: launcher.chromeProcess as unknown as NonNullable<LaunchedChrome["process"]>,
    kill,
    host: host ?? undefined,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
  } as unknown as LaunchedChrome & { host?: string };
}
