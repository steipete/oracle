import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchedChrome } from "chrome-launcher";
import {
  closeTab,
  connectWithNewTab,
  launchChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  ensureLoggedIn,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  acquireProfileRunLock,
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
  type ProfileRunLock,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import {
  executeFindingAction,
  goToNextFindingsPage,
  readFindingDetail,
  waitForFindingDetailReady,
  waitForFindingsPageSettled,
  waitForFindingsReady,
} from "./actions/codexFindings.js";
import type { FindingActionResult } from "./actions/codexFindings.js";
import { normalizeCodexFindingsUrl, buildFindingDetailUrl } from "../codex/url.js";
import {
  aggregateFindingPages,
  githubRepoFromUrl,
  isModalRuntimeEvidence,
  shouldStopPaging,
} from "../codex/findings.js";
import type {
  CodexFinding,
  CodexFindingsPageCounter,
  CodexFindingsRequest,
  CodexFindingsResult,
} from "../codex/types.js";

type BrowserChrome = LaunchedChrome & { host?: string };

function requireFindingId(findingId: string | undefined): string {
  if (!findingId?.trim()) {
    throw new Error("codex findings --finding <id> is required to show a finding's detail.");
  }
  return findingId.trim();
}

export async function runBrowserCodexFindings(
  request: CodexFindingsRequest,
): Promise<CodexFindingsResult> {
  const startedAt = Date.now();
  const logger: BrowserLogger = ((message: string) => request.log?.(message)) as BrowserLogger;
  const findingsUrl = normalizeCodexFindingsUrl(request.chatgptUrl);
  const warnings: string[] = [];

  let config = resolveBrowserConfig({
    ...request.config,
    url: findingsUrl,
    chatgptUrl: findingsUrl,
  });
  if (config.remoteChrome) {
    throw new Error(
      "codex findings uses local browser automation only. Run it on the signed-in browser host.",
    );
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(os.tmpdir(), "oracle-codex-findings-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({ userDataDir, keepBrowser: effectiveKeepBrowser });
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  let tabLease: BrowserTabLease | null = null;
  if (manualLogin) {
    tabLease = await acquireBrowserTabLease(userDataDir, {
      maxConcurrentTabs: config.maxConcurrentTabs,
      timeoutMs: config.timeoutMs,
      logger,
      sessionId: "codex-findings",
    });
  }

  let chrome: BrowserChrome | null = null;
  let reusedChrome: LaunchedChrome | null = null;
  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connectionClosedUnexpectedly = false;
  let completed = false;

  try {
    const acquired = manualLogin
      ? await acquireManualLoginChromeForCodexFindings(userDataDir, config, logger)
      : {
          chrome: await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger),
          reusedChrome: null,
        };
    chrome = acquired.chrome;
    reusedChrome = acquired.reusedChrome;
    const chromeHost = chrome.host ?? "127.0.0.1";
    if (tabLease) {
      await tabLease.update({ chromeHost, chromePort: chrome.port });
    }

    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      { isInFlight: () => !completed, preserveUserDataDir: manualLogin },
    );

    const strictTabIsolation = Boolean(manualLogin && reusedChrome);
    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
      fallbackToDefault: !strictTabIsolation,
      retries: devtoolsRetries,
      retryDelayMs: 500,
    });
    client = connection.client;
    isolatedTargetId = connection.targetId ?? null;
    if (tabLease && isolatedTargetId) {
      await tabLease.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: isolatedTargetId,
        tabUrl: findingsUrl,
      });
    }

    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        reject(new Error("Chrome window closed before codex findings finished."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);

    const { Network, Page, Runtime, Input, Target } = client;
    await Promise.all([Network.enable({}), Page.enable(), Runtime.enable()]);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const appliedCookies = await applyCodexFindingsCookies({
      config,
      network: Network,
      manualLogin,
      logger,
    });
    await clearStaleChatGptConversationCookies(Network, Target, logger);

    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger));
    await raceWithDisconnect(
      waitForCodexFindingsLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
        profileDir: userDataDir,
        keepBrowser: effectiveKeepBrowser,
      }),
    );

    if (request.operation === "detail") {
      const detailUrl = buildFindingDetailUrl(findingsUrl, requireFindingId(request.findingId));
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, detailUrl, logger));
      await raceWithDisconnect(waitForFindingDetailReady(Runtime, config.inputTimeoutMs, logger));
      const detail = await raceWithDisconnect(
        readFindingDetail(Runtime, requireFindingId(request.findingId)),
      );
      completed = true;
      return {
        status: "ok",
        operation: "detail",
        findingsUrl: detailUrl,
        detail,
        warnings,
        tookMs: Date.now() - startedAt,
      };
    }

    if (request.operation === "action") {
      const findingId = requireFindingId(request.findingId);
      if (!request.action) throw new Error("codex finding action requires an action.");
      if (["create-pr", "chat", "close", "adjust"].includes(request.action) && !request.confirm) {
        throw new Error(`Refusing mutating finding action ${request.action} without --confirm.`);
      }
      const detailUrl = buildFindingDetailUrl(findingsUrl, findingId);
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, detailUrl, logger));
      await raceWithDisconnect(waitForFindingDetailReady(Runtime, config.inputTimeoutMs, logger));
      const detail = await raceWithDisconnect(readFindingDetail(Runtime, findingId));
      const expectedRepo = request.repo ?? (request.modalOnly ? "umgbhalla/harp" : undefined);
      if (expectedRepo && githubRepoFromUrl(detail.repo ?? "") !== expectedRepo) {
        throw new Error(
          `Finding ${findingId} belongs to ${githubRepoFromUrl(detail.repo ?? "") ?? "an unknown repository"}, not ${expectedRepo}.`,
        );
      }
      if (
        request.modalOnly &&
        (detail.files.length === 0 || detail.files.some((file) => !isModalRuntimeEvidence(file)))
      ) {
        throw new Error(
          `Finding ${findingId} is not Modal-runtime-only; refusing action because its evidence includes frontend, local-only, test, eval, or unknown paths.`,
        );
      }
      const actionResult: FindingActionResult = await raceWithDisconnect(
        executeFindingAction(
          Runtime,
          Input,
          request.action,
          request.actionText,
          config.inputTimeoutMs,
          logger,
        ),
      );
      completed = true;
      return {
        status: "ok",
        operation: "action",
        findingsUrl: detailUrl,
        action: request.action,
        actionResult,
        warnings,
        tookMs: Date.now() - startedAt,
      };
    }

    // LIST: the findings list is SSR'd + rendered as `li > button` rows; scrape the DOM and
    // page through with a plain Next-page click (verified to advance). No trusted Input needed.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, findingsUrl, logger));
    await raceWithDisconnect(waitForFindingsReady(Runtime, config.inputTimeoutMs, logger));

    const limit =
      typeof request.limit === "number" && request.limit >= 0 ? request.limit : undefined;
    const pages: CodexFinding[][] = [];
    let counter: CodexFindingsPageCounter | undefined;
    let pagesVisited = 0;
    // Hard cap so a mis-reporting counter can never loop forever.
    const maxPages = 100;
    while (pagesVisited < maxPages) {
      const page = await raceWithDisconnect(
        waitForFindingsPageSettled(Runtime, config.inputTimeoutMs, logger),
      );
      pages.push(page.items);
      counter = page.counter;
      pagesVisited += 1;
      const collected = aggregateFindingPages(pages).length;
      if (!request.repo && !request.modalOnly && limit !== undefined && collected >= limit) {
        break;
      }
      if (shouldStopPaging(page.counter, pagesVisited)) {
        break;
      }
      const advanced = await raceWithDisconnect(
        goToNextFindingsPage(Runtime, config.inputTimeoutMs, logger),
      );
      if (!advanced) {
        break;
      }
    }
    let findings = aggregateFindingPages(pages);
    if (request.repo || request.modalOnly) {
      const expectedRepo = request.repo ?? "umgbhalla/harp";
      findings = findings.filter((finding) => finding.repo === expectedRepo);
    }
    if (request.severity) {
      findings = findings.filter((f) => f.severity === request.severity);
    }
    if (limit !== undefined) {
      findings = findings.slice(0, limit);
    }
    findings = findings.map((f: CodexFinding, i: number) => ({ ...f, index: i }));
    completed = true;
    return {
      status: "ok",
      operation: "list",
      findingsUrl,
      findings,
      counter: counter ?? {
        from: findings.length ? 1 : 0,
        to: findings.length,
        total: findings.length,
      },
      warnings,
      tookMs: Date.now() - startedAt,
    };
  } finally {
    removeDialogHandler?.();
    removeTerminationHooks?.();
    const chromeHost = chrome?.host ?? "127.0.0.1";
    try {
      await client?.close();
    } catch {
      // ignore close failures
    }
    if (completed && isolatedTargetId && chrome?.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }

    let keepBrowserOpen = effectiveKeepBrowser;
    let cleanupProfileLock: ProfileRunLock | null = null;
    if (!keepBrowserOpen && manualLogin && tabLease) {
      const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
      if (cleanupLockTimeoutMs > 0) {
        cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
          timeoutMs: cleanupLockTimeoutMs,
          logger,
          sessionId: "codex-findings",
        }).catch(() => null);
      }
      keepBrowserOpen = await hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id).catch(
        () => false,
      );
      if (keepBrowserOpen) {
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (reusedChrome && !connectionClosedUnexpectedly) {
        keepBrowserOpen = true;
        logger("[browser] Reused shared Chrome; leaving browser process running.");
      }
    }
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await handle.release().catch(() => undefined);
    }
    if (!keepBrowserOpen && chrome) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          { connectionClosedUnexpectedly, host: chrome.host ?? "127.0.0.1" },
        );
        if (shouldCleanup) {
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (chrome) {
      try {
        chrome.process?.unref();
      } catch {
        // best effort
      }
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
    if (cleanupProfileLock) {
      await cleanupProfileLock.release().catch(() => undefined);
    }
  }
}

async function applyCodexFindingsCookies({
  config,
  network,
  manualLogin,
  logger,
}: {
  config: ResolvedBrowserConfig;
  network: ChromeClient["Network"];
  manualLogin: boolean;
  logger: BrowserLogger;
}): Promise<number> {
  const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
  const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
  if (!cookieSyncEnabled) {
    logger(
      manualLogin
        ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
        : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
    );
    return 0;
  }
  const cookieCount = await syncCookies(network, config.url, config.chromeProfile, logger, {
    allowErrors: config.allowCookieErrors ?? false,
    filterNames: config.cookieNames ?? undefined,
    inlineCookies: config.inlineCookies ?? undefined,
    cookiePath: config.chromeCookiePath ?? undefined,
    waitMs: config.cookieSyncWaitMs ?? 0,
  });
  logger(
    cookieCount > 0
      ? config.inlineCookies
        ? `Applied ${cookieCount} inline cookies`
        : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
      : "No Chrome cookies found; continuing without session reuse",
  );
  return cookieCount;
}

async function waitForCodexFindingsLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.toLowerCase().includes("login button") ||
        message.toLowerCase().includes("session not detected");
      if (!retryable) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

async function acquireManualLoginChromeForCodexFindings(
  userDataDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const lockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
  let launchLock: ProfileRunLock | null = null;
  if (lockTimeoutMs > 0) {
    launchLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: lockTimeoutMs,
      logger,
      sessionId: "codex-findings",
    });
  }
  try {
    const reusedChrome = await maybeReuseCodexFindingsChrome(userDataDir, logger, {
      waitForPortMs: config.reuseChromeWaitMs,
    });
    const chrome =
      reusedChrome ?? (await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger));
    if (chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid);
      }
    }
    return { chrome, reusedChrome };
  } finally {
    await launchLock?.release().catch(() => undefined);
  }
}

async function maybeReuseCodexFindingsChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${Math.round(waitForPortMs / 1000)}s for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
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
    const probe = await (options.probe ?? verifyDevToolsReachable)({ port: discovered.port });
    if (!probe.ok) {
      logger(
        `Discovered Chrome for ${userDataDir} on port ${discovered.port} but it was unreachable (${probe.error}); launching new Chrome.`,
      );
      await cleanupStaleProfileState(userDataDir, logger, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      return null;
    }
    await writeDevToolsActivePort(userDataDir, discovered.port);
    await writeChromePid(userDataDir, discovered.pid);
    logger(
      `Discovered running Chrome for ${userDataDir}; reusing (DevTools port ${discovered.port}, pid ${discovered.pid})`,
    );
    return {
      port: discovered.port,
      pid: discovered.pid,
      kill: async () => {},
      process: undefined,
    } as unknown as LaunchedChrome;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `Recorded Chrome DevTools port ${port} is stale (${probe.error}); launching new Chrome.`,
    );
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }
  logger(`Reusing running Chrome on port ${port} with profile ${userDataDir}`);
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}
