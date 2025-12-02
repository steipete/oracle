import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveBrowserConfig } from './config.js';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger, ChromeClient, BrowserAttachment } from './types.js';
import {
  launchChrome,
  registerTerminationHooks,
  hideChromeWindow,
  connectToChrome,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
} from './chromeLifecycle.js';
import { syncCookies } from './cookies.js';
import {
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  readAssistantSnapshot,
} from './pageActions.js';
import { uploadAttachmentViaDataTransfer } from './actions/remoteFileTransfer.js';
import { estimateTokenCount, withRetries, delay } from './utils.js';
import { formatElapsed } from '../oracle/format.js';
import { CHATGPT_URL } from './constants.js';
import type { LaunchedChrome } from 'chrome-launcher';
import { BrowserAutomationError } from '../oracle/errors.js';
import { syncChromeProfile } from './profileSync.js';

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from './types.js';
export { CHATGPT_URL, DEFAULT_MODEL_TARGET } from './constants.js';
export { parseDuration, delay, normalizeChatgptUrl } from './utils.js';

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error('Prompt text is required when using browser mode.');
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];

  const config = resolveBrowserConfig(options.config);
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined;
  const emitRuntimeHint = async (): Promise<void> => {
    if (!runtimeHintCb || !chrome?.port) {
      return;
    }
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb(hint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...config,
        promptLength: promptText.length,
      })}`,
    );
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    if (config.headless || config.hideWindow || config.keepBrowser || config.chromePath) {
      logger(
        'Note: --remote-chrome ignores local Chrome flags ' +
        '(--browser-headless, --browser-hide-window, --browser-keep-browser, --browser-chrome-path).'
      );
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : path.join(os.homedir(), '.oracle', 'browser-profile');
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), 'oracle-browser-'));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  const profileSyncEnabled = config.cookieSync !== false && !manualLogin;
  if (profileSyncEnabled) {
    try {
      const result = await syncChromeProfile({
        profile: config.chromeProfile ?? null,
        explicitPath: config.chromeCookiePath ?? null,
        targetDir: userDataDir,
        logger,
      });
      logger(
        `Synced Chrome profile ${result.profileName} -> ${userDataDir} (${result.method})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserAutomationError(
        `Failed to sync Chrome profile: ${message}\n` +
        'Rerun with --browser-fresh-profile for a fresh profile or --browser-manual-login to sign in once.',
      );
    }
  } else if (!manualLogin) {
    logger('Profile sync disabled; starting with a fresh automation profile.');
  }

  const effectiveKeepBrowser = config.keepBrowser || manualLogin;
  const reusedChrome = manualLogin ? await maybeReuseRunningChrome(userDataDir, logger) : null;
  const chrome =
    reusedChrome ??
    (await launchChrome(
      {
        ...config,
        remoteChrome: config.remoteChrome,
      },
      userDataDir,
      logger,
    ));
  const chromeHost = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(chrome, userDataDir, effectiveKeepBrowser, logger);
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: Awaited<ReturnType<typeof connectToChrome>> | null = null;
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let runStatus: 'attempted' | 'complete' = 'attempted';
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let appliedCookies = 0;

  try {
    try {
      client = await connectToChrome(chrome.port, logger, chromeHost);
    } catch (error) {
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on('disconnect', () => {
        connectionClosedUnexpectedly = true;
        logger('Chrome window closed; attempting to abort run.');
        reject(new Error('Chrome window closed before oracle finished. Please keep it open until completion.'));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise]);
    const { Network, Page, Runtime, Input, DOM } = client;

    if (!config.headless && config.hideWindow) {
      await hideChromeWindow(chrome, logger);
    }

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    const inlineCookies = config.inlineCookies && config.inlineCookies.length > 0 ? config.inlineCookies : null;
    if (!manualLogin && !profileSyncEnabled) {
      await Network.clearBrowserCookies();
    }

    if (inlineCookies) {
      const cookieCount = await syncCookies(Network, config.url, null, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        inlineCookies,
      });
      appliedCookies = cookieCount;
      if (cookieCount === 0) {
        throw new Error('No inline cookies were applied; aborting before navigation.');
      }
      logger(`Applied ${cookieCount} inline cookies${profileSyncEnabled ? ' on top of synced profile' : ''}`);
    } else if (manualLogin) {
      logger('Skipping cookie injection (--browser-manual-login); reuse the opened profile after signing in.');
    } else if (!profileSyncEnabled) {
      logger('No inline cookies provided; continuing with a fresh profile (--browser-fresh-profile set; login may be required).');
    }

    const baseUrl = CHATGPT_URL;
    // First load the base ChatGPT homepage to satisfy potential interstitials,
    // then hop to the requested URL if it differs.
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
    await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    await raceWithDisconnect(
      waitForLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
        profileSyncEnabled,
      }),
    );

    if (config.url !== baseUrl) {
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, config.url, logger));
      await raceWithDisconnect(ensureNotBlocked(Runtime, config.headless, logger));
    }
    await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    logger(`Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`);
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          lastUrl = info?.targetInfo?.url ?? lastUrl;
        }
      } catch {
        // ignore
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: 'location.href',
          returnByValue: true,
        });
        if (typeof result?.value === 'string') {
          lastUrl = result.value;
        }
      } catch {
        // ignore
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : '';
        if (lastUrl) {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`);
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    await captureRuntimeSnapshot();
    if (config.desiredModel) {
      await raceWithDisconnect(
        withRetries(
          () => ensureModelSelection(Runtime, config.desiredModel as string, logger),
          {
            retries: 2,
            delayMs: 300,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch((error) => {
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          appliedCookies === 0
            ? ' No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON).'
            : '';
        throw new Error(`${base}${hint}`);
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(`Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`);
    }
    if (attachments.length > 0) {
      if (!DOM) {
        throw new Error('Chrome DOM domain unavailable while uploading attachments.');
      }
      for (const attachment of attachments) {
        logger(`Uploading attachment: ${attachment.displayPath}`);
        await uploadAttachmentFile({ runtime: Runtime, dom: DOM }, attachment, logger);
      }
      const waitBudget = Math.max(config.inputTimeoutMs ?? 30_000, 30_000);
      await raceWithDisconnect(waitForAttachmentCompletion(Runtime, waitBudget, logger));
      logger('All attachments uploaded');
    }
    await raceWithDisconnect(submitPrompt({ runtime: Runtime, input: Input }, promptText, logger));
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    const answer = await raceWithDisconnect(waitForAssistantResponse(Runtime, config.timeoutMs, logger));
    answerText = answer.text;
    answerHtml = answer.html ?? '';
    const copiedMarkdown = await raceWithDisconnect(
      withRetries(
        async () => {
          const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
          if (!attempt) {
            throw new Error('copy-missing');
          }
          return attempt;
        },
        {
          retries: 2,
          delayMs: 350,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        },
      ),
    ).catch(() => null);
    answerMarkdown = copiedMarkdown ?? answerText;
    // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
    const finalSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
    const finalText = typeof finalSnapshot?.text === 'string' ? finalSnapshot.text.trim() : '';
    if (
      finalText &&
      finalText !== answerMarkdown.trim() &&
      finalText !== promptText.trim() &&
      finalText.length >= answerMarkdown.trim().length
    ) {
      logger('Refreshed assistant response via final DOM snapshot');
      answerText = finalText;
      answerMarkdown = finalText;
    }
    if (answerMarkdown.trim() === promptText.trim()) {
      const deadline = Date.now() + 8_000;
      let bestText: string | null = null;
      let stableCount = 0;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(Runtime).catch(() => null);
        const text = typeof snapshot?.text === 'string' ? snapshot.text.trim() : '';
        if (text && text !== promptText.trim()) {
          if (!bestText || text.length > bestText.length) {
            bestText = text;
            stableCount = 0;
          } else if (text === bestText) {
            stableCount += 1;
          }
          if (stableCount >= 2) {
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (bestText) {
        logger('Recovered assistant response after detecting prompt echo');
        answerText = bestText;
        answerMarkdown = bestText;
      }
    }
    stopThinkingMonitor?.();
    runStatus = 'complete';
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
      logger(`Chrome window closed before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    throw new BrowserAutomationError(
      'Chrome window closed before oracle finished. Please keep it open until completion.',
      {
        stage: 'connection-lost',
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: lastUrl,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    removeTerminationHooks?.();
    if (!effectiveKeepBrowser) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else if (!connectionClosedUnexpectedly) {
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileSyncEnabled,
}: {
  runtime: ChromeClient['Runtime'];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileSyncEnabled: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies, profileSync: profileSyncEnabled });
    return;
  }
  const deadline = Date.now() + Math.min(timeoutMs ?? 1_200_000, 20 * 60_000);
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies, profileSync: profileSyncEnabled });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes('login button');
      const sessionMissing = message?.toLowerCase().includes('session not detected');
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          'Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...',
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  throw new Error('Manual login mode timed out waiting for ChatGPT session; please sign in and retry.');
}

async function maybeReuseRunningChrome(userDataDir: string, logger: BrowserLogger): Promise<LaunchedChrome | null> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) return null;
  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(versionUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pidPath = path.join(userDataDir, 'chrome.pid');
    let pid: number | undefined;
    try {
      const rawPid = (await readFile(pidPath, 'utf8')).trim();
      pid = Number.parseInt(rawPid, 10);
      if (Number.isNaN(pid)) pid = undefined;
    } catch {
      pid = undefined;
    }
    logger(`Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}${pid ? `, pid ${pid}` : ''})`);
    return {
      port,
      pid,
      kill: async () => {},
      process: undefined,
    } as unknown as LaunchedChrome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`DevToolsActivePort found for ${userDataDir} but unreachable (${message}); launching new Chrome.`);
    return null;
  }
}

async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  const candidates = [
    path.join(userDataDir, 'DevToolsActivePort'),
    path.join(userDataDir, 'Default', 'DevToolsActivePort'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? '', 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
    }
  }
  return null;
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error('Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.');
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let lastUrl: string | undefined;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async () => {
    if (!runtimeHintCb) return;
    try {
      await runtimeHintCb({
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
    }
  };
  const startedAt = Date.now();
  let answerText = '';
  let answerMarkdown = '';
  let answerHtml = '';
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;

  try {
    const connection = await connectToRemoteChrome(host, port, logger, config.url);
    client = connection.client;
    remoteTargetId = connection.targetId ?? null;
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on('disconnect', markConnectionLost);
    const { Network, Page, Runtime, Input, DOM } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === 'function') {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);

    // Skip cookie sync for remote Chrome - it already has cookies
    logger('Skipping cookie sync for remote Chrome (using existing session)');

    await navigateToChatGPT(Page, Runtime, config.url, logger);
    await ensureNotBlocked(Runtime, config.headless, logger);
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    logger(`Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`);
    try {
      const { result } = await Runtime.evaluate({
        expression: 'location.href',
        returnByValue: true,
      });
      if (typeof result?.value === 'string') {
        lastUrl = result.value;
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    if (config.desiredModel) {
      await withRetries(
        () => ensureModelSelection(Runtime, config.desiredModel as string, logger),
        {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(`[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
            }
          },
        },
      );
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
      logger(`Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`);
    }

    if (attachments.length > 0) {
      if (!DOM) {
        throw new Error('Chrome DOM domain unavailable while uploading attachments.');
      }
      // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
      for (const attachment of attachments) {
        logger(`Uploading attachment: ${attachment.displayPath}`);
        await uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger);
      }
      const waitBudget = Math.max(config.inputTimeoutMs ?? 30_000, 30_000);
      await waitForAttachmentCompletion(Runtime, waitBudget, logger);
      logger('All attachments uploaded');
    }

    await submitPrompt({ runtime: Runtime, input: Input }, promptText, logger);
    stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, options.verbose ?? false);
    const answer = await waitForAssistantResponse(Runtime, config.timeoutMs, logger);
    answerText = answer.text;
    answerHtml = answer.html ?? '';

    const copiedMarkdown = await withRetries(
      async () => {
        const attempt = await captureAssistantMarkdown(Runtime, answer.meta, logger);
        if (!attempt) {
          throw new Error('copy-missing');
        }
        return attempt;
      },
      {
        retries: 2,
        delayMs: 350,
        onRetry: (attempt, error) => {
          if (options.verbose) {
            logger(
              `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
            );
          }
        },
      },
    ).catch(() => null);

    answerMarkdown = copiedMarkdown ?? answerText;
    stopThinkingMonitor?.();

    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      controllerPid: process.pid,
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    stopThinkingMonitor?.();
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === '1') && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    throw new BrowserAutomationError('Remote Chrome connection lost before Oracle finished.', {
      stage: 'connection-lost',
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        controllerPid: process.pid,
      },
    });
  } finally {
    try {
      if (!connectionClosedUnexpectedly && client) {
        await client.close();
      }
    } catch {
      // ignore
    }
    await closeRemoteChromeTarget(host, port, remoteTargetId ?? undefined, logger);
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from './utils.js';
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from './config.js';
export { syncCookies } from './cookies.js';
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from './pageActions.js';

function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('websocket connection closed') ||
    message.includes('websocket is closed') ||
    message.includes('websocket error') ||
    message.includes('target closed')
  );
}

export function formatThinkingLog(startedAt: number, now: number, message: string, locatorSuffix: string): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const progress = Math.min(1, elapsedMs / 600_000); // soft target: 10 minutes
  const pct = Math.round(progress * 100)
    .toString()
    .padStart(3, ' ');
  const statusLabel = message ? ` — ${message}` : '';
  return `${pct}% [${elapsedText} / ~10m]${statusLabel}${locatorSuffix}`;
}

function startThinkingStatusMonitor(
  Runtime: ChromeClient['Runtime'],
  logger: BrowserLogger,
  includeDiagnostics = false,
): () => void {
  let stopped = false;
  let pending = false;
  let lastMessage: string | null = null;
  const startedAt = Date.now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const nextMessage = await readThinkingStatus(Runtime);
      if (nextMessage && nextMessage !== lastMessage) {
        lastMessage = nextMessage;
        let locatorSuffix = '';
        if (includeDiagnostics) {
          try {
            const snapshot = await readAssistantSnapshot(Runtime);
            locatorSuffix = ` | assistant-turn=${snapshot ? 'present' : 'missing'}`;
          } catch {
            locatorSuffix = ' | assistant-turn=error';
          }
        }
        logger(formatThinkingLog(startedAt, Date.now(), nextMessage, locatorSuffix));
      }
    } catch {
      // ignore DOM polling errors
    } finally {
      pending = false;
    }
  }, 1500);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

async function readThinkingStatus(Runtime: ChromeClient['Runtime']): Promise<string | null> {
  const expression = buildThinkingStatusExpression();
  try {
    const { result } = await Runtime.evaluate({ expression, returnByValue: true });
    const value = typeof result.value === 'string' ? result.value.trim() : '';
    const sanitized = sanitizeThinkingText(value);
    return sanitized || null;
  } catch {
    return null;
  }
}

function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return '';
  }
  const trimmed = raw.trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  if (prefixPattern.test(trimmed)) {
    return trimmed.replace(prefixPattern, '').trim();
  }
  return trimmed;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    '',
    'PowerShell (admin):',
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    '',
    'Re-run the same oracle command after adding the rule.',
  ].join('\n');
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes('microsoft');
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      '/mnt/c/Users/Public/AppData/Local/Temp',
      '/mnt/c/Temp',
      '/mnt/c/Windows/Temp',
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return os.tmpdir();
}

function buildThinkingStatusExpression(): string {
  const selectors = [
    'span.loading-shimmer',
    'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = ['pro thinking', 'thinking', 'reasoning', 'clarifying', 'planning', 'drafting', 'summarizing'];
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  return `(() => {
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    document.querySelectorAll('[data-testid]').forEach((node) => nodes.add(node));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = (node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        const shimmerChild = node.querySelector(
          'span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary',
        );
        if (shimmerChild?.textContent?.trim()) {
          return shimmerChild.textContent.trim();
        }
        return text.trim();
      }
    }
    return null;
  })()`;
}
